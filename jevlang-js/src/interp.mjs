/**
 * The interpreter. Two things here are language design rather than plumbing,
 * and both come straight out of this repo's measurements.
 *
 * 1. SPECULATIVE BATCHING. docs/00 measured question bundling at 21x faster
 *    and 8x cheaper with the answers unmoved, because the state is sent once
 *    and another question costs only its own wording. So before executing
 *    anything, every judgment whose question text is already known is asked
 *    in ONE request -- including judgments inside branches that will not be
 *    taken. Paying for an unused question is cheaper than a second round
 *    trip.
 *
 *    A judgment whose question interpolates a variable cannot be hoisted,
 *    because its text does not exist yet. Those stay lazy, one request each.
 *    That split is the whole cost model of the language: `noul("牛乳がない")`
 *    is free to batch, `score("${result} で褒められる確率")` is not.
 *
 * 2. THE ESCAPE HATCH IS ITS OWN QUESTION. `choice` always returns one of the
 *    options (docs/00's closed world). docs/13 then measured the two ways of
 *    offering a way out and found them unequal: a separate noul caught 18/18
 *    where mixing "(none of these)" into the options caught 16/18 AND dragged
 *    the hard-but-answerable cases down, because difficulty and
 *    inapplicability escaped through the same door. So a `match` with an
 *    `else` arm emits a separate gate noul, and `else` wins whenever that
 *    gate falls below its threshold -- whatever `choice` picked.
 */

/** Values carry their provenance: a confidence, when the API gave one. */
const prob = (v) => ({ t: "prob", v, conf: null });
const num = (v, conf = null) => ({ t: "num", v, conf });
const str = (v, conf = null) => ({ t: "str", v, conf });
const bool = (v) => ({ t: "bool", v, conf: null });

export class JevRuntimeError extends Error {}

/**
 * Transcript lookup. A transcript is a LIST of
 * `{kind, question, options, answer}` rather than an object keyed by a
 * composite string: keying would make replay depend on two different JSON
 * writers escaping separator characters identically, and the list stays
 * readable to a human besides.
 */
export function findRecorded(entries, kind, question, options) {
  if (!entries) return undefined;
  return entries.find(
    (e) =>
      e.kind === kind &&
      e.question === question &&
      e.options.length === options.length &&
      e.options.every((o, i) => o === options[i]),
  );
}

/**
 * The gate question for a `match` with an `else` arm. Must match the MoonBit
 * implementation exactly, or a transcript recorded by one will not replay in
 * the other.
 */
function gateQuestion(options) {
  return `次の選択肢のうち少なくとも 1 つが実際に当てはまる: ${options.join(" / ")}`;
}

function apiQuestion(kind, question, options) {
  if (kind === "gate") {
    return {
      type: "noul",
      instructions: question,
      criteria: {
        true: "少なくとも 1 つの選択肢が当てはまる",
        false: "どの選択肢も当てはまらない",
      },
    };
  }
  if (kind === "noul") {
    // A plain noul carries no criteria; two options mean a
    // `{true: ..., false: ...}` block, which sharpens the boundary between
    // the two answers (docs/14 section 3 is what this is for).
    if (options.length !== 2) return { type: "noul", instructions: question };
    return {
      type: "noul",
      instructions: question,
      criteria: { true: options[0], false: options[1] },
    };
  }
  if (kind === "choice") {
    // Options carry no descriptions: the name-only choice from docs/00, which
    // docs/13 then measured at 90% on a 53-item roster from names alone.
    const criteria = {};
    for (const option of options) criteria[option] = null;
    return { type: "choice", instructions: question, criteria };
  }
  return { type: "score", instructions: question, criteria: options };
}

export class Interpreter {
  /**
   * @param {object} program           parsed AST
   * @param {object} opts
   * @param {object} opts.jev          client, or null in replay mode
   * @param {boolean} opts.lazy        skip the batch; one request per judgment
   * @param {Array|null} opts.replay   recorded answers to read instead of asking
   * @param {object|null} opts.state    host-supplied state, shallow-merged over
   *                                    the program's own `state` block
   */
  constructor(program, { jev = null, lazy = false, replay = null, state = null } = {}) {
    this.program = program;
    this.jev = jev;
    this.lazy = lazy;
    this.replay = replay;
    this.injectedState = state;
    this.scope = new Map();
    /** Batched answers, by judgment id. */
    this.answers = new Map();
    this.effects = [];
    this.output = [];
    /** One entry per judgment actually consumed, in execution order. */
    this.trace = [];
    /** Everything asked, in order, for the transcript. */
    this.recorded = [];
    this.requests = 0;
    this.batched = 0;
    this.lazyAsked = 0;
  }

  /**
   * The state every judgment sees.
   *
   * A host can supply its own, shallow-merged over the program's `state`
   * block. That makes the block in the source a set of defaults and a piece
   * of documentation, while the real values come from whoever is running the
   * program -- which is the only way a `.jev` file can be a policy for
   * something like a PreToolUse hook, where the command and the git branch
   * are known to the host and not to the author.
   */
  get state() {
    const base = literalToJs(this.program.state);
    return this.injectedState === null ? base : { ...base, ...this.injectedState };
  }

  // ---- the hoisting pass ---------------------------------------------

  /**
   * Every judgment in the program, in source order, with its question text
   * resolved when it can be. `pending` means the text needs a runtime value,
   * so it cannot join the batch.
   */
  allJudgments() {
    const found = [];
    const walkExpr = (node) => {
      if (node === null || typeof node !== "object") return;
      switch (node.k) {
        case "judge": {
          const pending =
            hasInterpolation(node.question) || node.options.some(hasInterpolation);
          found.push({
            id: node.id,
            kind: node.kind,
            pending,
            question: pending ? "" : flatten(node.question),
            options: pending ? [] : node.options.map(flatten),
          });
          return;
        }
        case "match": {
          walkExpr(node.subject);
          for (const arm of node.arms) walkExpr(arm.body);
          if (node.fallback !== null) walkExpr(node.fallback);
          if (node.gateId !== null) {
            // The gate can only be hoisted when the subject is a literal
            // `choice`, because otherwise its options are not known yet.
            const subject = node.subject;
            const usable =
              subject.k === "judge" &&
              subject.kind === "choice" &&
              !subject.options.some(hasInterpolation);
            const options = usable ? subject.options.map(flatten) : [];
            found.push({
              id: node.gateId,
              kind: "gate",
              pending: !usable,
              question: usable ? gateQuestion(options) : "",
              options,
            });
          }
          return;
        }
        case "logic":
        case "cmp":
          walkExpr(node.left);
          walkExpr(node.right);
          return;
        case "not":
          walkExpr(node.expr);
          return;
        case "effect":
          node.args.forEach(walkExpr);
          return;
        default:
          return;
      }
    };
    const walkStmts = (stmts) => {
      for (const s of stmts) {
        if (s.k === "let") walkExpr(s.expr);
        else if (s.k === "do") walkExpr(s.expr);
        else if (s.k === "if") {
          walkExpr(s.cond);
          walkStmts(s.then);
          if (s.otherwise !== null) walkStmts(s.otherwise);
        }
      }
    };
    walkStmts(this.program.body);
    return found;
  }

  /** Phase one: ask every judgment whose text is already known, in one call. */
  async prefetch() {
    if (this.lazy) return;
    const hoistable = this.allJudgments().filter((j) => !j.pending);
    if (hoistable.length === 0) return;
    const toAsk = [];
    for (const j of hoistable) {
      const hit = findRecorded(this.replay, j.kind, j.question, j.options);
      if (hit !== undefined) this.store(j, hit.answer);
      else toAsk.push(j);
    }
    if (toAsk.length === 0) return;
    const questions = {};
    for (const j of toAsk) questions[j.id] = apiQuestion(j.kind, j.question, j.options);
    const res = await this.request(questions);
    for (const j of toAsk) {
      this.store(j, res.answers[j.id]);
      this.batched += 1;
    }
  }

  async request(questions) {
    if (this.jev === null) {
      throw new JevRuntimeError(
        `no answer in the transcript for ${Object.keys(questions).join(", ")}; re-record it`,
      );
    }
    this.requests += 1;
    return this.jev.ask(this.state, questions);
  }

  store(j, answer) {
    if (answer === undefined || answer === null) {
      throw new JevRuntimeError(`no answer came back for ${j.kind} '${j.question}'`);
    }
    this.recorded.push({
      kind: j.kind,
      question: j.question,
      options: j.options,
      answer,
    });
    this.answers.set(j.id, answer);
  }

  /** Phase two, on demand: a judgment the batch could not know about. */
  async resolve(id, kind, question, options) {
    const batched = this.answers.get(id);
    if (batched !== undefined) {
      this.trace.push({ how: "batch", kind, question, answer: batched });
      return batched;
    }
    const hit = findRecorded(this.replay, kind, question, options);
    if (hit !== undefined) {
      this.recorded.push({ kind, question, options, answer: hit.answer });
      this.trace.push({ how: "replay", kind, question, answer: hit.answer });
      return hit.answer;
    }
    const res = await this.request({ [id]: apiQuestion(kind, question, options) });
    const answer = res.answers[id];
    if (answer === undefined) {
      throw new JevRuntimeError(`no answer came back for ${kind} '${question}'`);
    }
    this.recorded.push({ kind, question, options, answer });
    this.lazyAsked += 1;
    this.trace.push({ how: "lazy", kind, question, answer });
    return answer;
  }

  // ---- evaluation ----------------------------------------------------

  async run() {
    await this.prefetch();
    await this.execBlock(this.program.body);
    return {
      effects: this.effects,
      output: this.output,
      // Insertion-ordered pairs rendered through show(), so both
      // implementations print bindings identically.
      bindings: [...this.scope].map(([k, v]) => [k, show(v)]),
      trace: this.trace,
      requests: this.requests,
      batched: this.batched,
      lazy: this.lazyAsked,
    };
  }

  async execBlock(stmts) {
    for (const s of stmts) await this.exec(s);
  }

  async exec(stmt) {
    switch (stmt.k) {
      case "let": {
        const value = await this.eval(stmt.expr);
        this.scope.set(stmt.name, value);
        return;
      }
      case "do": {
        await this.eval(stmt.expr);
        return;
      }
      case "if": {
        const cond = await this.eval(stmt.cond);
        if (this.truthy(cond)) await this.execBlock(stmt.then);
        else if (stmt.otherwise !== null) await this.execBlock(stmt.otherwise);
        return;
      }
      default:
        throw new JevRuntimeError(`unknown statement ${stmt.k}`);
    }
  }

  /**
   * Only a noul probability becomes a condition on its own, and it does so at
   * the declared threshold. A number or a string is not a condition: docs/01
   * is emphatic that the cutoff is a code-side decision, so the language
   * makes you write the comparison rather than inventing one for you.
   */
  truthy(value) {
    if (value.t === "bool") return value.v;
    if (value.t === "prob") return value.v >= this.program.thresholds.noul;
    if (value.t === "num") {
      throw new JevRuntimeError(
        "a number is not a condition -- compare it, as in `x >= 1.5`",
      );
    }
    throw new JevRuntimeError(
      'a string is not a condition -- compare it, as in `x == "a"`',
    );
  }

  async eval(node) {
    switch (node.k) {
      case "num":
        return num(node.value);
      case "bool":
        return bool(node.value);
      case "str":
        return str(this.interpolate(node));
      case "var": {
        const found = this.scope.get(node.name);
        if (found === undefined) {
          throw new JevRuntimeError(`'${node.name}' is not defined`);
        }
        return found;
      }
      case "conf": {
        const found = this.scope.get(node.name);
        if (found === undefined) {
          throw new JevRuntimeError(`'${node.name}' is not defined`);
        }
        // noul answers carry no confidence -- the API does not return one.
        return num(found.conf ?? 0);
      }
      case "flagged": {
        // Renders "name value" for the judgments at or above `threshold flag`.
        // This is what lets a reason string say WHICH predicate fired, which
        // the built-in hook does by iterating a key list and a language with
        // no string concatenation otherwise cannot express.
        const parts = [];
        for (const name of node.names) {
          const found = this.scope.get(name);
          if (found === undefined) {
            throw new JevRuntimeError(`'${name}' is not defined`);
          }
          if (found.t !== "prob" && found.t !== "num") {
            throw new JevRuntimeError(
              `flagged() needs judgments, but '${name}' is a ${found.t}`,
            );
          }
          if (found.v >= this.program.thresholds.flag) {
            parts.push(`${name} ${formatNumber(found.v)}`);
          }
        }
        return str(parts.join(", "));
      }
      case "not":
        return bool(!this.truthy(await this.eval(node.expr)));
      case "logic": {
        const left = this.truthy(await this.eval(node.left));
        if (node.op === "&&" && !left) return bool(false);
        if (node.op === "||" && left) return bool(true);
        return bool(this.truthy(await this.eval(node.right)));
      }
      case "cmp": {
        const left = await this.eval(node.left);
        const right = await this.eval(node.right);
        return bool(compare(node.op, left, right));
      }
      case "effect": {
        const args = [];
        for (const a of node.args) args.push(await this.eval(a));
        const rendered = args.map((a) => show(a));
        this.effects.push({ name: node.name, args: rendered });
        if (node.name === "print" || node.name === "say") {
          this.output.push(rendered.join(" "));
        }
        // An effect evaluates to its first argument, which is what lets it sit
        // in a match arm: `"プリン" => buy("プリン")` binds "プリン".
        return args.length > 0 ? args[0] : str("");
      }
      case "judge":
        return this.evalJudgment(node);
      case "match":
        return this.evalMatch(node);
      default:
        throw new JevRuntimeError(`unknown expression ${node.k}`);
    }
  }

  async evalJudgment(node) {
    const question = this.interpolate(node.question);
    const options = node.options.map((o) => this.interpolate(o));
    const answer = await this.resolve(node.id, node.kind, question, options);
    if (node.kind === "noul") {
      expectType(answer, "noul", question);
      return prob(answer.noul);
    }
    if (node.kind === "choice") {
      expectType(answer, "choice", question);
      return str(answer.choice, answer.confidence);
    }
    expectType(answer, "score", question);
    return num(answer.score, answer.confidence);
  }

  async evalMatch(node) {
    const subject = await this.eval(node.subject);
    if (subject.t !== "str") {
      throw new JevRuntimeError(`match needs a string, got a ${subject.t}`);
    }
    // The gate decides before the arms do: if nothing applies, `else` wins
    // even when `choice` returned a perfectly good-looking option.
    // A gate only exists over a `choice` subject (see the parser), so the
    // options are always the choice's own.
    if (node.gateId !== null) {
      const options = node.subject.options.map((o) => this.interpolate(o));
      const answer = await this.resolve(
        node.gateId,
        "gate",
        gateQuestion(options),
        options,
      );
      expectType(answer, "noul", "gate");
      if (answer.noul < this.program.thresholds.gate) {
        return this.eval(node.fallback);
      }
    }
    for (const arm of node.arms) {
      if (this.interpolate(arm.lit) === subject.v) return this.eval(arm.body);
    }
    if (node.fallback !== null) return this.eval(node.fallback);
    throw new JevRuntimeError(`match has no arm for '${subject.v}' and no else arm`);
  }

  interpolate(strNode) {
    let out = "";
    for (const part of strNode.parts) {
      if (part.lit !== undefined) {
        out += part.lit;
        continue;
      }
      const found = this.scope.get(part.ident);
      if (found === undefined) {
        throw new JevRuntimeError(`'${part.ident}' is not defined`);
      }
      out += show(found);
    }
    return out;
  }
}

// ---- helpers --------------------------------------------------------

function hasInterpolation(strNode) {
  return strNode.parts.some((p) => p.ident !== undefined);
}

/** The question text of a node with no interpolation. */
function flatten(strNode) {
  return strNode.parts.map((p) => p.lit ?? "").join("");
}

function expectType(answer, want, question) {
  if (answer.type !== want) {
    throw new JevRuntimeError(
      `expected a ${want} answer for '${question}', got ${answer.type}`,
    );
  }
}

function compare(op, left, right) {
  if (left.t === "str" || right.t === "str") {
    if (op !== "==" && op !== "!=") {
      throw new JevRuntimeError(`cannot use ${op} on strings`);
    }
    const same = show(left) === show(right);
    return op === "==" ? same : !same;
  }
  const a = numeric(left);
  const b = numeric(right);
  switch (op) {
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case "<":
      return a < b;
    case "==":
      return a === b;
    default:
      return a !== b;
  }
}

function numeric(value) {
  if (value.t === "num" || value.t === "prob") return value.v;
  if (value.t === "bool") return value.v ? 1 : 0;
  throw new JevRuntimeError("cannot compare a string numerically");
}

/**
 * How a value renders inside `"${...}"` and in effect arguments. Must match
 * `Value::show_text` in the MoonBit implementation exactly, or conformance
 * diffs on formatting rather than on semantics.
 */
function show(value) {
  if (value.t === "num" || value.t === "prob") return formatNumber(value.v);
  if (value.t === "bool") return value.v ? "true" : "false";
  return value.v;
}

/**
 * Always two decimals, so `2` prints as `2.00`.
 *
 * Every number in this language is a judgment's value — a probability in
 * 0..1 or a score in 0..n — or a threshold literal, so a fixed two places is
 * the right default and matches what a host reporting these numbers does
 * (the permission hook's `toFixed(2)`). An integer special case would also be
 * one more branch for the two implementations to disagree about.
 *
 * `trunc(v * 100 +/- 0.5)` rather than `Math.round`, because Math.round breaks
 * ties toward +Infinity while MoonBit's `.to_int()` truncates toward zero —
 * they disagree on negative halves, and this function's whole job is to agree.
 */
function formatNumber(v) {
  const rounded = Math.trunc(v * 100 + (v < 0 ? -0.5 : 0.5));
  const neg = rounded < 0;
  const mag = Math.abs(rounded);
  const whole = Math.floor(mag / 100);
  const frac = mag % 100;
  return `${neg ? "-" : ""}${whole}.${frac < 10 ? `0${frac}` : frac}`;
}

/**
 * How many judgments can ride the single batched request, and how many have
 * to wait for a runtime value. This is the program's cost model — it issues
 * `1 + lazy` requests where a naive interpreter issues `hoistable + lazy` —
 * so it is worth being able to ask for without running anything. Mirrors
 * `Program::request_plan` in the MoonBit implementation.
 */
export function requestPlan(program) {
  const sites = new Interpreter(program).allJudgments();
  const hoistable = sites.filter((s) => !s.pending).length;
  return { hoistable, lazy: sites.length - hoistable };
}

function literalToJs(node) {
  switch (node.k) {
    case "obj":
      return Object.fromEntries(node.entries.map(([k, v]) => [k, literalToJs(v)]));
    case "arr":
      return node.items.map(literalToJs);
    default:
      return node.value;
  }
}

export { show, literalToJs, formatNumber };
