/**
 * The candidate edits, generated in code.
 *
 * This is the constraint that shapes the whole experiment: Jev returns a
 * probability, a class or a level -- never a string. So it cannot write a
 * patch. What it can do is CHOOSE, which means the patches have to come from
 * somewhere else, and the only honest somewhere else is a deterministic
 * generator.
 *
 * So the workflow is: mutate (code) -> order (Jev) -> apply (code) -> test
 * (code). Everything except the ordering is deterministic and replayable,
 * which is the shape docs/19's jevlang and docs/05's browser walk both
 * landed on -- breadth mechanical, depth judged.
 *
 * The catalog is small and syntactic on purpose. It is NOT a program repair
 * system: it is a candidate set built to contain the fix for each planted
 * bug, so that what gets measured is the ORDERING and not the search space.
 * docs/32 says that plainly in its limits.
 */

export interface Candidate {
  id: string;
  /** Which rule produced it, for reading the results by class. */
  rule: string;
  /** 1-based line in the file. */
  line: number;
  /** The line before and after, which is what the question carries. */
  before: string;
  after: string;
  /** The whole file with the edit applied. */
  text: string;
}

type Rule = (line: string) => { after: string; rule: string }[];

/** Replace every occurrence of `from` with `to`, one candidate per position. */
function atEach(line: string, from: string, to: string, rule: string): { after: string; rule: string }[] {
  const out: { after: string; rule: string }[] = [];
  let at = line.indexOf(from);
  while (at >= 0) {
    out.push({ after: line.slice(0, at) + to + line.slice(at + from.length), rule });
    at = line.indexOf(from, at + 1);
  }
  return out;
}

/**
 * The catalog.
 *
 * The order is load-bearing and it took a measurement to notice. The control
 * that walks candidates in generation order needs 2.42 test runs on average
 * against a shuffle's 8.50 (docs/32 §1) -- because the rules that fix the
 * commonest bugs happen to be written first, so the generator's own order is
 * already a strong prior. That is the bar the judgment has to clear, and it
 * is a much higher one than "better than random".
 */
const RULES: Rule[] = [
  // Comparison and equality.
  (l) => atEach(l, "==", "===", "loose-to-strict"),
  (l) => atEach(l, "!=", "!==", "loose-to-strict"),
  (l) => atEach(l, "===", "==", "strict-to-loose"),
  (l) => atEach(l, "<=", "<", "tighten-bound"),
  (l) => atEach(l, ">=", ">", "tighten-bound"),
  (l) => (/<[^=]/.test(l) ? atEach(l, "<", "<=", "loosen-bound") : []),
  (l) => (/>[^=]/.test(l) ? atEach(l, ">", ">=", "loosen-bound") : []),
  (l) => atEach(l, "&&", "||", "and-to-or"),
  (l) => atEach(l, "||", "&&", "or-to-and"),
  (l) => atEach(l, "||", "??", "or-to-nullish"),
  (l) => atEach(l, "??", "||", "nullish-to-or"),
  // Arithmetic and indexing.
  (l) => atEach(l, ".length - 1", ".length", "drop-minus-one"),
  (l) => atEach(l, ".length", ".length - 1", "add-minus-one"),
  (l) => atEach(l, " - 1", " + 1", "flip-offset"),
  (l) => atEach(l, " - 1", "", "drop-offset"),
  (l) => atEach(l, " + 1", "", "drop-offset"),
  (l) => atEach(l, " + 1", " - 1", "flip-offset"),
  (l) => atEach(l, " - ", " + ", "flip-operator"),
  (l) => atEach(l, " + ", " - ", "flip-operator"),
  // Whole-expression rewrites.
  (l) => atEach(l, ".push(", ".concat(", "push-to-concat"),
  (l) => atEach(l, ".concat(", ".push(", "concat-to-push"),
  // Negate an `if` condition, which is where an inverted guard lives.
  //
  // The parenthesis has to be matched by counting. A greedy `(.+)\)` took
  // `seen.has(key(x))) out.push(x` as the condition and produced garbage that
  // still parsed -- a candidate that cannot be the fix and cannot be told
  // apart from one that could.
  (l) => {
    const open = l.indexOf("if (");
    if (open < 0) return [];
    let depth = 0;
    let close = -1;
    for (let i = open + 3; i < l.length; i += 1) {
      if (l[i] === "(") depth += 1;
      else if (l[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) return [];
    const inner = l.slice(open + 4, close);
    const after = inner.startsWith("!") ? inner.slice(1) : `!(${inner})`;
    return [{ after: l.slice(0, open + 4) + after + l.slice(close), rule: "negate-if" }];
  },
  // Negation.
  (l) => {
    const m = /return (.+);$/.exec(l.trimEnd());
    if (!m) return [];
    const indent = l.slice(0, l.length - l.trimStart().length);
    return [{ after: `${indent}return !(${m[1]});`, rule: "negate-return" }];
  },
  // A bare expression statement that should have been returned.
  (l) => {
    const t = l.trim();
    if (!t.endsWith(";") || /^(return|const|let|var|if|for|while|import|export)\b/.test(t)) return [];
    const indent = l.slice(0, l.length - l.trimStart().length);
    return [{ after: `${indent}return ${t}`, rule: "add-return" }];
  },
  // A call whose result is used without awaiting.
  (l) => {
    if (l.includes("await")) return [];
    const m = /^(\s*(?:const|let|var|return)\s[^=]*=\s*)([A-Za-z_$][\w$]*\()/.exec(l);
    if (!m) return [];
    return [{ after: l.slice(0, m[1].length) + "await " + l.slice(m[1].length), rule: "add-await" }];
  },
  // Swap the first two arguments of a call.
  (l) => {
    const out: { after: string; rule: string }[] = [];
    const re = /([A-Za-z_$][\w$.]*)\(([^(),]+),\s*([^(),]+)(,|\))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l)) !== null) {
      const swapped = `${m[1]}(${m[3].trim()}, ${m[2].trim()}${m[4]}`;
      out.push({ after: l.slice(0, m.index) + swapped + l.slice(m.index + m[0].length), rule: "swap-args" });
    }
    return out;
  },
  // Swap the two sides of a binary comparison.
  (l) => {
    const m = /^(\s*(?:return\s+)?)([\w$.[\]]+)\s*(<=|>=|<|>|-)\s*([\w$.[\]]+)(.*)$/.exec(l);
    if (!m) return [];
    return [{ after: `${m[1]}${m[4]} ${m[3]} ${m[2]}${m[5]}`, rule: "swap-operands" }];
  },
  // An optional-chain guard with a default.
  (l) => {
    const out: { after: string; rule: string }[] = [];
    const re = /([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\./g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l)) !== null) {
      out.push({
        after: l.slice(0, m.index) + `(${m[1]}.${m[2]} ?? "").` + l.slice(m.index + m[0].length),
        rule: "guard-with-default",
      });
    }
    return out;
  },
  // Replace an identifier in a `return x;` with each of the others on the
  // line. Not anchored to the line start, because the bug in `clamp` is
  // `if (v > hi) return v;` -- an anchored version missed it, and a rule that
  // cannot reach the planted fix makes the task unsolvable rather than hard.
  (l) => {
    const m = /(return\s+)([A-Za-z_$][\w$]*)(;)/.exec(l);
    if (!m) return [];
    const others = [...new Set(l.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter(
      (x) => x !== m[2] && x !== "return" && x !== "if" && x !== "else",
    );
    return others.map((o) => ({
      after: l.slice(0, m.index) + m[1] + o + m[3] + l.slice(m.index + m[0].length),
      rule: "swap-returned-name",
    }));
  },
  // Swap the two operands of a binary operator inside an arrow body, which
  // is where a reversed comparator lives: `(a, b) => b - a`.
  (l) => {
    const out: { after: string; rule: string }[] = [];
    const re = /=>\s*([A-Za-z_$][\w$]*)\s*(-|<=|>=|<|>)\s*([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l)) !== null) {
      const swapped = m[0].replace(`${m[1]} ${m[2]} ${m[3]}`, `${m[3]} ${m[2]} ${m[1]}`);
      if (swapped === m[0]) continue;
      out.push({ after: l.slice(0, m.index) + swapped + l.slice(m.index + m[0].length), rule: "flip-comparator" });
    }
    return out;
  },
];

/**
 * Every candidate for a file, deduplicated.
 *
 * Deduplication is by the resulting TEXT, not by the rule: two rules can
 * produce the same edit (`< -> <=` and `swap-operands` on the same line), and
 * counting it twice would inflate the search space the control has to walk.
 */
export function candidates(text: string, opts: { identifiers?: string[] } = {}): Candidate[] {
  void opts;
  const lines = text.split("\n");
  const seen = new Set<string>();
  const out: Candidate[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    for (const rule of RULES) {
      for (const { after, rule: name } of rule(line)) {
        if (after === line) continue;
        const next = [...lines];
        next[i] = after;
        const full = next.join("\n");
        if (seen.has(full)) continue;
        seen.add(full);
        out.push({
          id: `${i + 1}:${out.length}`,
          rule: name,
          line: i + 1,
          before: line,
          after,
          text: full,
        });
      }
    }
  });
  return out;
}
