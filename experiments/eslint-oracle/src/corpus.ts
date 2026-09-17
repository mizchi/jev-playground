/**
 * The code corpus. Every snippet is a valid ES module so the real linter can
 * rule on it — the labels in this experiment are ESLint's, never ours.
 *
 * `kind` and `note` are annotations for the write-up and are NEVER sent to
 * Jev (run.ts asserts this). They record what we were aiming at:
 *
 * - `violation` — meant to trip the target rule.
 * - `clean`     — meant to satisfy it.
 * - `nearmiss`  — the case where the rule's DEFAULT OPTIONS or a carve-out in
 *                 `create()` decides the verdict, and the one-line description
 *                 gives no hint which way it goes. These are the interesting
 *                 ones: a predictor that only has the description should get
 *                 them wrong, and a predictor that has memorised ESLint should
 *                 get them right.
 */
export interface Snippet {
  id: string;
  target: string;
  kind: "violation" | "clean" | "nearmiss";
  note: string;
  code: string;
}

export const CORPUS: Snippet[] = [
  // ---------------------------------------------------------------- eqeqeq
  {
    id: "eqeqeq_loose",
    target: "eqeqeq",
    kind: "violation",
    note: "Plain `==` between two members; nothing subtle.",
    code: `export function sameId(a, b) {
  return a.id == b.id;
}
`,
  },
  {
    id: "eqeqeq_strict",
    target: "eqeqeq",
    kind: "clean",
    note: "The rule's own recommendation.",
    code: `export function sameId(a, b) {
  return a.id === b.id;
}
`,
  },
  {
    id: "eqeqeq_null_idiom",
    target: "eqeqeq",
    kind: "nearmiss",
    note:
      "`== null` is the idiom every style guide blesses, and eqeqeq's 'smart' " +
      "and 'always'+{null:'ignore'} options do allow it -- but the DEFAULT is " +
      "plain 'always', which reports it. The default lives in the implementation.",
    code: `export function isMissing(value) {
  return value == null;
}
`,
  },

  // ---------------------------------------------------------------- no-var
  {
    id: "novar_declaration",
    target: "no-var",
    kind: "violation",
    note: "A bare `var` declaration.",
    code: `export var retries = 3;
`,
  },
  {
    id: "novar_const",
    target: "no-var",
    kind: "clean",
    note: "No `var` token anywhere.",
    code: `export const retries = 3;
`,
  },
  {
    id: "novar_in_string",
    target: "no-var",
    kind: "nearmiss",
    note:
      "The token `var` appears twice, in a string literal and in a comment. " +
      "A text matcher fires; a parser does not.",
    code: `// Legacy snippet we print in the docs: var legacy = 1;
export const template = "var legacy = 1;";
`,
  },

  // ---------------------------------------------------------------- no-eval
  {
    id: "eval_direct",
    target: "no-eval",
    kind: "violation",
    note: "Direct `eval()` call.",
    code: `export function runExpr(src) {
  return eval(src);
}
`,
  },
  {
    id: "eval_json",
    target: "no-eval",
    kind: "clean",
    note: "The safe replacement.",
    code: `export function runExpr(src) {
  return JSON.parse(src);
}
`,
  },
  {
    id: "eval_aliased",
    target: "no-eval",
    kind: "nearmiss",
    note:
      "Indirect eval through a local alias. `allowIndirect` defaults to false, " +
      "so the reference itself is reported -- but the description only says " +
      "'the use of eval()', and there is no call spelled `eval(...)` here.",
    code: `const evaluate = eval;

export function runExpr(src) {
  return evaluate(src);
}
`,
  },

  // ------------------------------------------------------------- no-debugger
  {
    id: "debugger_stmt",
    target: "no-debugger",
    kind: "violation",
    note: "A `debugger` statement.",
    code: `export function checkout(cart) {
  debugger;
  return cart.total;
}
`,
  },
  {
    id: "debugger_none",
    target: "no-debugger",
    kind: "clean",
    note: "No debugger statement.",
    code: `export function checkout(cart) {
  return cart.total;
}
`,
  },
  {
    id: "debugger_property",
    target: "no-debugger",
    kind: "nearmiss",
    note:
      "`debugger` appears twice as a property name. The rule matches the " +
      "DebuggerStatement node type, so a property key is untouched.",
    code: `export const flags = { debugger: false, verbose: true };

export function checkout(cart) {
  return flags.debugger ? cart : cart.total;
}
`,
  },

  // ----------------------------------------------------------- no-unused-vars
  {
    id: "unused_local",
    target: "no-unused-vars",
    kind: "violation",
    note: "A local const that is written and never read.",
    code: `export function total(items) {
  const count = items.length;
  return items.reduce((sum, item) => sum + item.price, 0);
}
`,
  },
  {
    id: "unused_none",
    target: "no-unused-vars",
    kind: "clean",
    note: "Every binding is read.",
    code: `export function total(items) {
  const count = items.length;
  return count === 0 ? 0 : items.reduce((sum, item) => sum + item.price, 0);
}
`,
  },
  {
    id: "unused_arg_before_used",
    target: "no-unused-vars",
    kind: "nearmiss",
    note:
      "`req` is plainly unused, and the description says 'Disallow unused " +
      "variables'. But `args` defaults to 'after-used', which only reports " +
      "parameters AFTER the last used one -- so this passes.",
    code: `export function handler(req, res) {
  return res.end("ok");
}
`,
  },
  {
    id: "unused_caught_error",
    target: "no-unused-vars",
    kind: "nearmiss",
    note:
      "An unused catch binding. `caughtErrors` defaulted to 'none' through " +
      "ESLint 8 and flipped to 'all' in ESLint 9, so the verdict depends on a " +
      "default that changed between versions and is invisible in the description.",
    code: `export function parse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}
`,
  },

  // ------------------------------------------------------------- prefer-const
  {
    id: "preferconst_let",
    target: "prefer-const",
    kind: "violation",
    note: "A `let` that is never reassigned.",
    code: `export function greet(name) {
  let greeting = "hi " + name;
  return greeting;
}
`,
  },
  {
    id: "preferconst_reassigned",
    target: "prefer-const",
    kind: "clean",
    note: "Reassigned, so `let` is correct.",
    code: `export function counter(start) {
  let value = start;
  value += 1;
  return value;
}
`,
  },
  {
    id: "preferconst_destructuring_any",
    target: "prefer-const",
    kind: "nearmiss",
    note:
      "`host` is never reassigned, so by the description it should be const. " +
      "But `destructuring` defaults to 'any': because ONE binding in the " +
      "pattern is reassigned, the rule reports neither.",
    code: `export function normalize(input) {
  let { host, port } = input;
  port = port ?? 443;
  return host + ":" + port;
}
`,
  },
  {
    id: "preferconst_assigned_in_closure",
    target: "prefer-const",
    kind: "nearmiss",
    note:
      "Declared without an initialiser and assigned exactly once, but from a " +
      "nested scope. The implementation only suggests const when the single " +
      "assignment sits in the declaring scope.",
    code: `export function lazy(make) {
  let cached;
  make(() => {
    cached = 1;
  });
  return cached;
}
`,
  },

  // ----------------------------------------------------------- no-fallthrough
  {
    id: "fallthrough_plain",
    target: "no-fallthrough",
    kind: "violation",
    note: "A case with statements and no break.",
    code: `export function label(kind) {
  let out = "";
  switch (kind) {
    case "a":
      out = "alpha";
    case "b":
      out = "beta";
      break;
    default:
      out = "other";
  }
  return out;
}
`,
  },
  {
    id: "fallthrough_breaks",
    target: "no-fallthrough",
    kind: "clean",
    note: "Every case breaks.",
    code: `export function label(kind) {
  let out = "";
  switch (kind) {
    case "a":
      out = "alpha";
      break;
    case "b":
      out = "beta";
      break;
    default:
      out = "other";
  }
  return out;
}
`,
  },
  {
    id: "fallthrough_comment",
    target: "no-fallthrough",
    kind: "nearmiss",
    note:
      "Identical control flow to fallthrough_plain, plus a `falls through` " +
      "comment. `commentPattern` makes that comment suppress the report -- a " +
      "magic string the description never mentions.",
    code: `export function label(kind) {
  let out = "";
  switch (kind) {
    case "a":
      out = "alpha";
    // falls through
    case "b":
      out = "beta";
      break;
    default:
      out = "other";
  }
  return out;
}
`,
  },
  {
    id: "fallthrough_empty_case",
    target: "no-fallthrough",
    kind: "nearmiss",
    note:
      "Control really does fall from `case \"a\"` into `case \"b\"`, which is " +
      "what the description names -- but an empty case has no statements to " +
      "fall through, and the implementation allows it.",
    code: `export function label(kind) {
  let out = "";
  switch (kind) {
    case "a":
    case "b":
      out = "ab";
      break;
    default:
      out = "other";
  }
  return out;
}
`,
  },

  // ----------------------------------------------------- no-constant-condition
  {
    id: "constcond_if_true",
    target: "no-constant-condition",
    kind: "violation",
    note: "`if (true)`.",
    code: `export function pick(a, b) {
  if (true) {
    return a;
  }
  return b;
}
`,
  },
  {
    id: "constcond_dynamic",
    target: "no-constant-condition",
    kind: "clean",
    note: "The condition depends on input.",
    code: `export function pick(a, b) {
  if (a.enabled) {
    return a;
  }
  return b;
}
`,
  },
  {
    id: "constcond_while_true",
    target: "no-constant-condition",
    kind: "nearmiss",
    note:
      "`while (true)` is a constant expression in a condition, which is exactly " +
      "what the description forbids. `checkLoops` defaults to " +
      "'allExceptWhileTrue', which carves out this one spelling.",
    code: `export function drain(queue) {
  while (true) {
    const next = queue.pop();
    if (next === undefined) {
      break;
    }
  }
  return queue;
}
`,
  },
  {
    id: "constcond_do_while_true",
    target: "no-constant-condition",
    kind: "nearmiss",
    note:
      "The same infinite loop written as do/while. The 'allExceptWhileTrue' " +
      "carve-out covers `while (true)` only, so the sibling spelling is reported. " +
      "Pairs with constcond_while_true: the description cannot separate them.",
    code: `export function drain(queue) {
  do {
    queue.pop();
  } while (true);
  return queue;
}
`,
  },

  // ---------------------------------------------------------------- no-empty
  {
    id: "empty_if_block",
    target: "no-empty",
    kind: "violation",
    note: "An empty `if` block.",
    code: `export function save(record) {
  if (record.dirty) {
  }
  return record;
}
`,
  },
  {
    id: "empty_filled",
    target: "no-empty",
    kind: "clean",
    note: "The block does something.",
    code: `export function save(record) {
  if (record.dirty) {
    record.dirty = false;
  }
  return record;
}
`,
  },
  {
    id: "empty_function_body",
    target: "no-empty",
    kind: "nearmiss",
    note:
      "An empty block statement by any plain reading of the description -- but " +
      "function bodies belong to `no-empty-function`, and no-empty skips them.",
    code: `export function noop() {}
`,
  },
  {
    id: "empty_block_with_comment",
    target: "no-empty",
    kind: "nearmiss",
    note:
      "Syntactically an empty block; the implementation treats a comment inside " +
      "as intent and stays quiet.",
    code: `export function save(record) {
  if (record.dirty) {
    // nothing to do yet
  }
  return record;
}
`,
  },
  {
    id: "empty_catch",
    target: "no-empty",
    kind: "nearmiss",
    note:
      "An empty catch is the one empty block people expect to be tolerated, and " +
      "`allowEmptyCatch` exists for it -- but it defaults to false, so this is " +
      "reported. Opposite direction to empty_block_with_comment.",
    code: `export function save(record) {
  try {
    record.flush();
  } catch {}
  return record;
}
`,
  },

  // ---------------------------------------------------------- no-self-compare
  {
    id: "selfcompare_nan",
    target: "no-self-compare",
    kind: "violation",
    note: "The classic `x !== x` NaN check.",
    code: `export function isNaNValue(x) {
  return x !== x;
}
`,
  },
  {
    id: "selfcompare_builtin",
    target: "no-self-compare",
    kind: "clean",
    note: "No comparison at all.",
    code: `export function isNaNValue(x) {
  return Number.isNaN(x);
}
`,
  },
  {
    id: "selfcompare_same_member",
    target: "no-self-compare",
    kind: "nearmiss",
    note:
      "`a.version === a.version` is the same expression twice, but not the same " +
      "*token*; whether the rule looks through member expressions is an " +
      "implementation choice.",
    code: `export function stale(a) {
  return a.version === a.version;
}
`,
  },
  {
    id: "selfcompare_different_index",
    target: "no-self-compare",
    kind: "nearmiss",
    note:
      "Textually near-identical sides that are not the same value. Should pass.",
    code: `export function equalAt(arr, i, j) {
  return arr[i] === arr[j];
}
`,
  },

  // ----------------------------------------------------------- no-cond-assign
  {
    id: "condassign_bare",
    target: "no-cond-assign",
    kind: "violation",
    note: "Assignment straight in an `if` test.",
    code: `export function firstMatch(re, text) {
  let m;
  if (m = re.exec(text)) {
    return m[0];
  }
  return null;
}
`,
  },
  {
    id: "condassign_compare",
    target: "no-cond-assign",
    kind: "clean",
    note: "No assignment in the condition.",
    code: `export function firstMatch(re, text) {
  if (re.test(text)) {
    return re.exec(text)[0];
  }
  return null;
}
`,
  },
  {
    id: "condassign_parens",
    target: "no-cond-assign",
    kind: "nearmiss",
    note:
      "There IS an assignment operator in the conditional expression, which is " +
      "what the description forbids. The default option 'except-parens' makes " +
      "the extra parentheses a legal way to say 'I meant it'.",
    code: `export function firstMatch(re, text) {
  let m;
  while ((m = re.exec(text)) !== null) {
    return m[0];
  }
  return null;
}
`,
  },

  // ----------------------------------------------------- no-prototype-builtins
  {
    id: "proto_hasownproperty",
    target: "no-prototype-builtins",
    kind: "violation",
    note: "`obj.hasOwnProperty(key)`.",
    code: `export function has(obj, key) {
  return obj.hasOwnProperty(key);
}
`,
  },
  {
    id: "proto_object_hasown",
    target: "no-prototype-builtins",
    kind: "clean",
    note: "The modern replacement.",
    code: `export function has(obj, key) {
  return Object.hasOwn(obj, key);
}
`,
  },
  {
    id: "proto_call_form",
    target: "no-prototype-builtins",
    kind: "nearmiss",
    note:
      "The form the rule's own docs recommend. The token `hasOwnProperty` is " +
      "present, so a text matcher fires where the rule does not.",
    code: `export function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
`,
  },
];
