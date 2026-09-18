/**
 * Parser for .jev. Produces the AST that interp.mjs walks, and that
 * `jevlang/` in MoonBit reproduces node for node.
 *
 * Grammar, in full:
 *
 *   program    := (stateDecl | thresholdDecl | stmt)*
 *   stateDecl  := 'state' object
 *   threshold  := 'threshold' ident '=' num
 *   stmt       := letStmt | ifStmt | exprStmt
 *   letStmt    := 'let' ident '=' expr
 *   ifStmt     := 'if' expr block ('else' (ifStmt | block))?
 *   block      := '{' stmt* '}'
 *   expr       := or
 *   or         := and ('||' and)*
 *   and        := cmp ('&&' cmp)*
 *   cmp        := unary (('>='|'<='|'=='|'!='|'>'|'<') unary)?
 *   unary      := '!' unary | primary
 *   primary    := num | str | 'true' | 'false' | ident
 *               | 'noul' '(' str (',' noulCriteria)? ')'
 *               | 'choice' '(' expr ',' array ')'
 *               | 'score' '(' expr ',' array ')'
 *               | 'conf' '(' ident ')'
 *               | matchExpr
 *               | ident '(' args ')'          -- an effect
 *               | '(' expr ')'
 *   noulCriteria := '{' ('true'|'false') ':' str (',' ...)* ','? '}'
 *   matchExpr  := 'match' expr '{' arm* ('else' '=>' expr ','?)? '}'
 *   arm        := str '=>' expr ','?
 *
 * Judgments get a stable `id` at parse time (j0, j1, ...) in source order, so
 * a recorded transcript replays identically in both implementations.
 */
import { lex, JevSyntaxError } from "./lex.mjs";

const JUDGMENTS = new Set(["noul", "choice", "score"]);

export function parse(source) {
  const tokens = lex(source);
  let pos = 0;
  let judgmentCount = 0;

  const peek = (offset = 0) => tokens[Math.min(pos + offset, tokens.length - 1)];
  const at = (type) => peek().type === type;
  const fail = (msg, tok = peek()) => {
    throw new JevSyntaxError(msg, tok.line, tok.col);
  };
  const next = () => tokens[pos++];
  const expect = (type, what = type) => {
    if (!at(type)) fail(`expected ${what}, found ${describe(peek())}`);
    return next();
  };
  const eat = (type) => (at(type) ? (next(), true) : false);

  const describe = (tok) =>
    tok.type === "eof"
      ? "end of file"
      : tok.type === "ident"
        ? `'${tok.text}'`
        : tok.type === "str"
          ? "a string"
          : tok.type === "num"
            ? "a number"
            : `'${tok.text ?? tok.type}'`;

  /** `noul`/`choice`/`score`/`conf`/`match` read as identifiers to the lexer. */
  const atIdent = (text) => at("ident") && peek().text === text;

  function nextJudgmentId() {
    const id = `j${judgmentCount}`;
    judgmentCount += 1;
    return id;
  }

  // ---- literals ------------------------------------------------------
  function object() {
    expect("{", "'{'");
    const entries = [];
    while (!at("}")) {
      const keyTok = next();
      const key =
        keyTok.type === "ident" || keyTok.type === "state" || keyTok.type === "let"
          ? keyTok.text
          : keyTok.type === "str"
            ? keyTok.parts.map((p) => p.lit ?? "").join("")
            : fail("expected a key", keyTok);
      expect(":", "':'");
      entries.push([key, literal()]);
      if (!eat(",")) break;
    }
    expect("}", "'}'");
    return { k: "obj", entries };
  }

  /** State values are plain data: no judgments, no variables. */
  function literal() {
    if (at("num")) return { k: "num", value: next().value };
    if (at("true")) return (next(), { k: "bool", value: true });
    if (at("false")) return (next(), { k: "bool", value: false });
    if (at("str")) {
      const tok = next();
      if (tok.parts.some((p) => p.ident !== undefined)) {
        fail("the state block cannot interpolate variables", tok);
      }
      return { k: "str", value: tok.parts.map((p) => p.lit ?? "").join("") };
    }
    if (at("[")) {
      next();
      const items = [];
      while (!at("]")) {
        items.push(literal());
        if (!eat(",")) break;
      }
      expect("]", "']'");
      return { k: "arr", items };
    }
    if (at("{")) return object();
    return fail(`expected a value, found ${describe(peek())}`);
  }

  /** A string used as a question or an option: may interpolate. */
  function stringExpr() {
    const tok = expect("str", "a string");
    return { k: "str", parts: tok.parts };
  }

  function stringArray() {
    expect("[", "'['");
    const items = [];
    while (!at("]")) {
      items.push(stringExpr());
      if (!eat(",")) break;
    }
    expect("]", "']'");
    return items;
  }

  // ---- expressions ---------------------------------------------------
  function expr() {
    return orExpr();
  }

  function orExpr() {
    let left = andExpr();
    while (at("||")) {
      next();
      left = { k: "logic", op: "||", left, right: andExpr() };
    }
    return left;
  }

  function andExpr() {
    let left = cmpExpr();
    while (at("&&")) {
      next();
      left = { k: "logic", op: "&&", left, right: cmpExpr() };
    }
    return left;
  }

  function cmpExpr() {
    const left = unary();
    for (const op of [">=", "<=", "==", "!=", ">", "<"]) {
      if (at(op)) {
        next();
        return { k: "cmp", op, left, right: unary() };
      }
    }
    return left;
  }

  function unary() {
    if (at("!")) {
      next();
      return { k: "not", expr: unary() };
    }
    return primary();
  }

  function primary() {
    if (at("num")) return { k: "num", value: next().value };
    if (at("true")) return (next(), { k: "bool", value: true });
    if (at("false")) return (next(), { k: "bool", value: false });
    if (at("str")) return stringExpr();
    if (at("(")) {
      next();
      const inner = expr();
      expect(")", "')'");
      return inner;
    }
    if (at("match")) return matchExpr();

    if (at("ident")) {
      const name = peek().text;
      if (JUDGMENTS.has(name)) return judgment();
      if (name === "conf") {
        next();
        expect("(", "'('");
        const target = expect("ident", "a variable name").text;
        expect(")", "')'");
        return { k: "conf", name: target };
      }
      next();
      if (at("(")) {
        next();
        const args = [];
        while (!at(")")) {
          args.push(expr());
          if (!eat(",")) break;
        }
        expect(")", "')'");
        return { k: "effect", name, args };
      }
      return { k: "var", name };
    }
    return fail(`expected an expression, found ${describe(peek())}`);
  }

  function judgment() {
    const tok = next();
    const kind = tok.text;
    expect("(", "'('");
    const question = stringExpr();
    let options = [];
    if (kind === "noul") {
      // Optional `{true: "...", false: "..."}`. docs/14 is the argument for
      // having this at all: the `false` criterion of an `exfiltrates`
      // predicate is what decided whether an ordinary `git push` was denied,
      // so a policy that cannot write one cannot be written correctly.
      //
      // The two descriptions are stored in `options`, which means they take
      // part in a judgment's transcript identity for free -- the same
      // question with different criteria really is a different question.
      if (eat(",")) {
        options = noulCriteria();
      }
      expect(")", "')'");
    } else {
      expect(",", "','");
      options = stringArray();
      eat(",");
      expect(")", "')'");
      if (options.length === 0) {
        fail(`${kind} needs at least one option`, tok);
      }
    }
    return { k: "judge", kind, id: nextJudgmentId(), question, options };
  }

  /** Returns [trueDesc, falseDesc]; a missing side becomes an empty string. */
  function noulCriteria() {
    expect("{", "'{' with true/false criteria");
    let trueDesc = null;
    let falseDesc = null;
    while (!at("}")) {
      const which = peek().type;
      if (which !== "true" && which !== "false") {
        fail(`expected 'true' or 'false', found ${describe(peek())}`);
      }
      next();
      expect(":", "':'");
      if (which === "true") trueDesc = stringExpr();
      else falseDesc = stringExpr();
      if (!eat(",")) break;
    }
    expect("}", "'}'");
    if (trueDesc === null && falseDesc === null) {
      fail("noul criteria need at least a true or a false description");
    }
    const empty = { k: "str", parts: [{ lit: "" }] };
    return [trueDesc ?? empty, falseDesc ?? empty];
  }

  function matchExpr() {
    expect("match", "'match'");
    const subject = expr();
    expect("{", "'{'");
    const arms = [];
    let fallback = null;
    while (!at("}")) {
      if (at("else")) {
        next();
        expect("=>", "'=>'");
        fallback = expr();
        eat(",");
        continue;
      }
      const lit = stringExpr();
      expect("=>", "'=>'");
      arms.push({ lit, body: expr() });
      eat(",");
    }
    expect("}", "'}'");
    // An `else` arm needs a way to mean "none of these options applies". The
    // measured answer (docs/13) is a SEPARATE noul, not an extra choice
    // option: mixing "(none of these)" into the options costs accuracy on the
    // hard-but-answerable cases. So the gate gets its own judgment id here.
    const gateId = fallback === null ? null : nextJudgmentId();
    return { k: "match", subject, arms, fallback, gateId };
  }

  // ---- statements ----------------------------------------------------
  function block() {
    expect("{", "'{'");
    const body = [];
    while (!at("}")) body.push(stmt());
    expect("}", "'}'");
    return body;
  }

  function stmt() {
    if (at("let")) {
      next();
      const name = expect("ident", "a variable name").text;
      expect("=", "'='");
      return { k: "let", name, expr: expr() };
    }
    if (at("if")) {
      next();
      const cond = expr();
      const then = block();
      let otherwise = null;
      if (eat("else")) {
        otherwise = at("if") ? [stmt()] : block();
      }
      return { k: "if", cond, then, otherwise };
    }
    return { k: "do", expr: expr() };
  }

  // ---- program -------------------------------------------------------
  let state = { k: "obj", entries: [] };
  let sawState = false;
  const thresholds = { noul: 0.5, gate: 0.5 };
  const body = [];

  while (!at("eof")) {
    if (at("state")) {
      const tok = next();
      if (sawState) fail("only one state block is allowed", tok);
      sawState = true;
      state = object();
      continue;
    }
    if (at("threshold")) {
      next();
      const name = expect("ident", "a threshold name").text;
      if (!(name in thresholds)) {
        fail(`unknown threshold '${name}'; expected 'noul' or 'gate'`);
      }
      expect("=", "'='");
      thresholds[name] = expect("num", "a number").value;
      continue;
    }
    body.push(stmt());
  }

  return { state, thresholds, body, judgmentCount };
}

export { JevSyntaxError };
