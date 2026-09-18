///|
/// AST for `.jev`, the little language whose conditions are Jev judgments.
///
/// This is the MoonBit half of a two-implementation language; the JS half is
/// `jevlang-js/`. The two must agree node for node, because
/// `scripts/jevlang-conformance.sh` runs the same programs through both in
/// replay mode and diffs the results. Keep any change here in step with
/// `jevlang-js/src/parse.mjs`.

///|
pub(all) suberror LangError {
  /// line, column, message
  Syntax(Int, Int, String)
  Runtime(String)
} derive(Debug)

///|
/// A piece of a string literal. `Interp` holds a bare identifier: the grammar
/// admits `"${name}"` and nothing more complex, because whether a question's
/// text is known before the program runs is what decides if it can be hoisted
/// into the batched request.
pub(all) enum StrPart {
  Lit(String)
  Interp(String)
} derive(Debug)

///|
pub(all) struct StrLit {
  parts : Array[StrPart]
} derive(Debug)

///|
/// The `state` block: plain data, no judgments and no variables.
pub(all) enum Literal {
  LStr(String)
  LNum(Double)
  LBool(Bool)
  LArr(Array[Literal])
  LObj(Array[(String, Literal)])
} derive(Debug)

///|
/// A judgment site. `id` is assigned in source order at parse time so a
/// recorded transcript lines up across runs and across implementations.
pub(all) struct JudgeNode {
  kind : String // "noul" | "choice" | "score"
  id : String
  question : StrLit
  options : Array[StrLit]
} derive(Debug)

///|
/// `match` over a string. An `else` arm implies a gate judgment: `choice`
/// always returns one of its options, so "none of these applies" has to be
/// asked separately. docs/17 measured that a separate noul beats mixing a
/// "(none of these)" option into the choice, which is why `gate_id` exists
/// rather than an extra entry in `options`.
pub(all) struct MatchNode {
  subject : Expr
  arms : Array[(StrLit, Expr)]
  fallback : Expr?
  gate_id : String?
} derive(Debug)

///|
pub(all) enum Expr {
  ENum(Double)
  EBool(Bool)
  EStr(StrLit)
  EVar(String)
  /// `conf(x)` — the confidence of the judgment that produced `x`.
  EConf(String)
  /// `flagged(a, b, c)` — renders the ones at or above `threshold flag` as
  /// "a 0.98, c 0.73". Takes bare names rather than expressions precisely so
  /// the NAMES survive: the point is to say which predicate fired.
  EFlagged(Array[String])
  /// `threshold_of(noul)` — reads a `threshold` declaration back as a number,
  /// so a cutoff the language uses and a cutoff a message mentions cannot
  /// drift apart. The name is validated at parse time.
  EThreshold(String)
  ENot(Expr)
  /// op is "&&" or "||"
  ELogic(String, Expr, Expr)
  /// op is one of >= <= == != > <
  ECmp(String, Expr, Expr)
  /// A host effect: `buy("牛乳")`. Evaluates to its first argument.
  EEffect(String, Array[Expr])
  EJudge(JudgeNode)
  EMatch(MatchNode)
} derive(Debug)

///|
pub(all) enum Stmt {
  SLet(String, Expr)
  SDo(Expr)
  SIf(Expr, Array[Stmt], Array[Stmt]?)
} derive(Debug)

///|
pub(all) struct Program {
  state : Literal
  /// A noul used as a condition becomes true at or above this.
  noul_threshold : Double
  /// A `match` takes its `else` arm below this.
  gate_threshold : Double
  /// `flagged()` renders a judgment at or above this.
  flag_threshold : Double
  body : Array[Stmt]
  judgment_count : Int
} derive(Debug)

///|
/// A runtime value. Judgments carry the confidence the API returned, when it
/// returned one; noul answers do not have one.
pub(all) enum Value {
  VProb(Double)
  VNum(Double, Double?)
  VStr(String, Double?)
  VBool(Bool)
} derive(Debug)

///|
/// The state block as JSON, which is what goes on the wire.
pub fn Literal::to_json(self : Literal) -> Json {
  match self {
    LStr(s) => Json::string(s)
    LNum(v) => Json::number(v)
    LBool(b) => Json::boolean(b)
    LArr(items) => Json::array(items.map(item => item.to_json()))
    LObj(entries) => {
      let m : Map[String, Json] = Map([])
      for entry in entries {
        m[entry.0] = entry.1.to_json()
      }
      Json::object(m)
    }
  }
}

///|
/// How a value renders inside `"${...}"` and in effect arguments. Both
/// implementations must agree exactly, or conformance diffs on formatting
/// rather than on semantics.
pub fn Value::show_text(self : Value) -> String {
  match self {
    VStr(s, _) => s
    VBool(b) => if b { "true" } else { "false" }
    VProb(v) => format_number(v)
    VNum(v, _) => format_number(v)
  }
}

///|
/// Always two decimals, so `2` prints as `2.00`.
///
/// Every number in this language is a judgment's value — a probability in
/// 0..1 or a score in 0..n — or a threshold literal, so a fixed two places is
/// the right default and matches what a host reporting these numbers does
/// (the permission hook's `toFixed(2)`). An integer special case would also be
/// one more branch for the two implementations to disagree about.
pub fn format_number(v : Double) -> String {
  let rounded = (v * 100.0 + (if v < 0.0 { -0.5 } else { 0.5 })).to_int()
  let neg = rounded < 0
  let mag = if neg { -rounded } else { rounded }
  let whole = mag / 100
  let frac = mag % 100
  let digits = if frac < 10 { "0\{frac}" } else { "\{frac}" }
  "\{if neg { "-" } else { "" }}\{whole}.\{digits}"
}

///|
/// The confidence attached to a value, if any.
pub fn Value::confidence(self : Value) -> Double? {
  match self {
    VNum(_, c) => c
    VStr(_, c) => c
    VProb(_) => None
    VBool(_) => None
  }
}
