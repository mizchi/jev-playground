///|
/// The interpreter. Mirrors `jevlang-js/src/interp.mjs`.
///
/// Two decisions here are language design rather than plumbing, and both come
/// out of this repo's measurements:
///
/// 1. SPECULATIVE BATCHING. docs/00 measured question bundling at 21x faster
///    and 8x cheaper with the answers unmoved, because the state is sent once
///    and another question costs only its own wording. So before executing
///    anything, every judgment whose question text is already known goes into
///    ONE request — including judgments in branches that will not be taken.
///    A question whose text interpolates a variable cannot be hoisted, so it
///    stays lazy. That split is the language's whole cost model.
///
/// 2. THE ESCAPE HATCH IS ITS OWN QUESTION. `choice` always returns one of the
///    options. docs/13 measured a separate noul at 18/18 against 16/18 for
///    mixing "(none of these)" into the options — and the mixed form also
///    dragged down the hard-but-answerable cases. So `match`'s `else` arm is
///    driven by a gate noul, and it wins below the gate threshold whatever
///    `choice` picked.

///|
/// One judgment, as consumed at runtime.
pub(all) struct TraceEntry {
  /// "batch", "lazy" or "replay"
  how : String
  kind : String
  question : String
  answer : @lib.Answer
}

///|
/// One recorded answer. The transcript is a LIST of these rather than an
/// object keyed by a composite string, so it does not depend on two different
/// JSON writers escaping control characters identically — and so a human can
/// read it.
pub(all) struct Recorded {
  kind : String
  question : String
  options : Array[String]
  answer : @lib.Answer
}

///|
pub(all) struct RunResult {
  effects : Array[(String, Array[String])]
  output : Array[String]
  /// Insertion-ordered, so both implementations print bindings the same way.
  bindings : Array[(String, String)]
  trace : Array[TraceEntry]
  requests : Int
  batched : Int
  lazy_asked : Int
  input_tokens : Int
}

///|
/// A judgment site found by the pre-pass. `pending` means its question text
/// needs a runtime value, so it cannot join the batch.
priv struct Site {
  id : String
  kind : String
  pending : Bool
  question : String
  options : Array[String]
}

///|
pub struct Interp {
  program : Program
  /// Host-supplied state, shallow-merged over the program's `state` block.
  /// That makes the block in the source a set of defaults and a piece of
  /// documentation, while the real values come from whoever runs the program
  /// — the only way a `.jev` file can be a policy for something like a
  /// PreToolUse hook, where the command and the git branch are known to the
  /// host and not to the author.
  injected_state : Json?
  client : @lib.Client?
  model : String
  lazy_mode : Bool
  replay : Array[Recorded]?
  scope : Map[String, Value]
  order : Array[String]
  answers : Map[String, @lib.Answer]
  recorded : Array[Recorded]
  effects : Array[(String, Array[String])]
  output : Array[String]
  trace : Array[TraceEntry]
  mut requests : Int
  mut batched : Int
  mut lazy_asked : Int
  mut input_tokens : Int
}

///|
pub fn Interp::new(
  program : Program,
  client? : @lib.Client,
  model? : String,
  lazy_mode? : Bool,
  replay? : Array[Recorded],
  injected_state? : Json,
) -> Interp {
  {
    program,
    injected_state,
    client,
    model: model.unwrap_or("jev-latest"),
    lazy_mode: lazy_mode.unwrap_or(false),
    replay,
    scope: Map([]),
    order: [],
    answers: Map([]),
    recorded: [],
    effects: [],
    output: [],
    trace: [],
    requests: 0,
    batched: 0,
    lazy_asked: 0,
    input_tokens: 0,
  }
}

///|
/// The gate question for a `match` with an `else` arm. Must match the JS
/// implementation exactly, or a transcript recorded by one will not replay in
/// the other.
pub fn gate_question(options : Array[String]) -> String {
  "次の選択肢のうち少なくとも 1 つが実際に当てはまる: \{options.join(" / ")}"
}

///|
fn api_question(kind : String, question : String, options : Array[String]) -> @lib.Question {
  if kind == "gate" {
    @lib.Question::noul(
      question,
      true_desc="少なくとも 1 つの選択肢が当てはまる",
      false_desc="どの選択肢も当てはまらない",
    )
  } else if kind == "noul" {
    // A plain noul carries no criteria; two options mean a
    // `{true: ..., false: ...}` block, which sharpens the boundary between
    // the two answers (docs/14 section 3 is what this is for).
    if options.length() == 2 {
      @lib.Question::noul(
        question,
        true_desc=options[0],
        false_desc=options[1],
      )
    } else {
      @lib.Question::noul(question)
    }
  } else if kind == "choice" {
    // Name-only choices: the cheapest form (docs/00), and docs/13 measured it
    // at 90% on a 53-item roster from names alone.
    @lib.Question::choice_of(options, instructions=question)
  } else {
    @lib.Question::score(options, instructions=question)
  }
}

///|
fn str_has_interp(s : StrLit) -> Bool {
  for p in s.parts {
    match p {
      Interp(_) => return true
      Lit(_) => ()
    }
  }
  false
}

///|
fn options_have_interp(options : Array[StrLit]) -> Bool {
  for o in options {
    if str_has_interp(o) {
      return true
    }
  }
  false
}

// ------------------------------------------------------ the hoisting pass

///|
fn collect_expr(node : Expr, found : Array[Site]) -> Unit {
  match node {
    EJudge(j) => {
      let pending = str_has_interp(j.question) || options_have_interp(j.options)
      found.push({
        id: j.id,
        kind: j.kind,
        pending,
        question: if pending { "" } else { str_lit_text(j.question.parts) },
        options: if pending {
          []
        } else {
          j.options.map(o => str_lit_text(o.parts))
        },
      })
    }
    EMatch(m) => {
      collect_expr(m.subject, found)
      for arm in m.arms {
        collect_expr(arm.1, found)
      }
      match m.fallback {
        Some(f) => collect_expr(f, found)
        None => ()
      }
      match m.gate_id {
        Some(id) => {
          // The gate can only be hoisted when the subject is a literal
          // `choice`, because otherwise its options are not known yet.
          let usable = match m.subject {
            EJudge(j) =>
              j.kind == "choice" && !options_have_interp(j.options)
            _ => false
          }
          let options = match m.subject {
            EJudge(j) if usable => j.options.map(o => str_lit_text(o.parts))
            _ => []
          }
          found.push({
            id,
            kind: "gate",
            pending: !usable,
            question: if usable { gate_question(options) } else { "" },
            options,
          })
        }
        None => ()
      }
    }
    ELogic(_, l, r) => {
      collect_expr(l, found)
      collect_expr(r, found)
    }
    ECmp(_, l, r) => {
      collect_expr(l, found)
      collect_expr(r, found)
    }
    ENot(e) => collect_expr(e, found)
    EEffect(_, args) =>
      for a in args {
        collect_expr(a, found)
      }
    ENum(_) | EBool(_) | EStr(_) | EVar(_) | EConf(_) => ()
  }
}

///|
fn collect_stmts(stmts : Array[Stmt], found : Array[Site]) -> Unit {
  for s in stmts {
    match s {
      SLet(_, e) => collect_expr(e, found)
      SDo(e) => collect_expr(e, found)
      SIf(cond, then, otherwise) => {
        collect_expr(cond, found)
        collect_stmts(then, found)
        match otherwise {
          Some(body) => collect_stmts(body, found)
          None => ()
        }
      }
    }
  }
}

///|
/// How many judgments can ride the single batched request, and how many have
/// to wait for a runtime value. This is the program's cost model — it will
/// issue `1 + lazy` requests where a naive interpreter issues
/// `hoistable + lazy` — so it is worth being able to ask for without running
/// anything.
pub fn Program::request_plan(self : Program) -> (Int, Int) {
  let sites = self.judgment_sites()
  let mut hoistable = 0
  for s in sites {
    if !s.pending {
      hoistable = hoistable + 1
    }
  }
  (hoistable, sites.length() - hoistable)
}

///|
/// Every judgment in the program, in source order.
fn Program::judgment_sites(self : Program) -> Array[Site] {
  let found : Array[Site] = []
  collect_stmts(self.body, found)
  found
}

// ---------------------------------------------------------------- oracle

///|
fn Interp::lookup_replay(
  self : Interp,
  kind : String,
  question : String,
  options : Array[String],
) -> @lib.Answer? {
  match self.replay {
    None => None
    Some(entries) => {
      for e in entries {
        if e.kind == kind && e.question == question && same_options(e.options, options) {
          return Some(e.answer)
        }
      }
      None
    }
  }
}

///|
fn same_options(a : Array[String], b : Array[String]) -> Bool {
  if a.length() != b.length() {
    return false
  }
  for i in 0..<a.length() {
    if a[i] != b[i] {
      return false
    }
  }
  true
}

///|
fn Interp::record(
  self : Interp,
  kind : String,
  question : String,
  options : Array[String],
  answer : @lib.Answer,
) -> Unit {
  self.recorded.push({ kind, question, options, answer })
}

///|
async fn Interp::ask(
  self : Interp,
  questions : Map[String, @lib.Question],
) -> @lib.SystemOneResponse raise {
  match self.client {
    None =>
      raise Runtime(
        "no answer in the transcript for " +
        questions.keys().to_array().join(", ") +
        "; re-record it",
      )
    Some(client) => {
      self.requests = self.requests + 1
      let resp = client.system_one({
        state: self.effective_state(),
        model: self.model,
        questions,
      })
      self.input_tokens = self.input_tokens + resp.input_tokens
      resp
    }
  }
}

///|
/// The state every judgment sees: the program's own block, with any
/// host-supplied keys overriding it.
pub fn Interp::effective_state(self : Interp) -> Json {
  let base = self.program.state.to_json()
  match (self.injected_state, base) {
    (None, _) => base
    (Some(Json::Object(over)), Json::Object(under)) => {
      let merged : Map[String, Json] = Map([])
      for k, v in under {
        merged[k] = v
      }
      for k, v in over {
        merged[k] = v
      }
      Json::object(merged)
    }
    // A non-object injection replaces the block outright: the state is
    // allowed to be any JSON value, not only an object.
    (Some(other), _) => other
  }
}

///|
/// Phase one: ask everything whose text is already known, in a single call.
async fn Interp::prefetch(self : Interp) -> Unit raise {
  if self.lazy_mode {
    return
  }
  let sites = self.program.judgment_sites().filter(s => !s.pending)
  if sites.length() == 0 {
    return
  }
  let to_ask : Array[Site] = []
  for s in sites {
    match self.lookup_replay(s.kind, s.question, s.options) {
      Some(answer) => {
        self.answers[s.id] = answer
        self.record(s.kind, s.question, s.options, answer)
      }
      None => to_ask.push(s)
    }
  }
  if to_ask.length() == 0 {
    return
  }
  let questions : Map[String, @lib.Question] = Map([])
  for s in to_ask {
    questions[s.id] = api_question(s.kind, s.question, s.options)
  }
  let resp = self.ask(questions)
  for s in to_ask {
    match resp.answers.get(s.id) {
      Some(answer) => {
        self.answers[s.id] = answer
        self.record(s.kind, s.question, s.options, answer)
        self.batched = self.batched + 1
      }
      None =>
        raise Runtime("no answer came back for \{s.kind} '\{s.question}'")
    }
  }
}

///|
/// Phase two: a judgment the batch could not know about, asked on demand.
async fn Interp::resolve(
  self : Interp,
  id : String,
  kind : String,
  question : String,
  options : Array[String],
) -> @lib.Answer raise {
  match self.answers.get(id) {
    Some(answer) => {
      self.trace.push({ how: "batch", kind, question, answer })
      return answer
    }
    None => ()
  }
  match self.lookup_replay(kind, question, options) {
    Some(answer) => {
      self.record(kind, question, options, answer)
      self.trace.push({ how: "replay", kind, question, answer })
      return answer
    }
    None => ()
  }
  let questions : Map[String, @lib.Question] = Map([])
  questions[id] = api_question(kind, question, options)
  let resp = self.ask(questions)
  match resp.answers.get(id) {
    Some(answer) => {
      self.record(kind, question, options, answer)
      self.lazy_asked = self.lazy_asked + 1
      self.trace.push({ how: "lazy", kind, question, answer })
      answer
    }
    None => raise Runtime("no answer came back for \{kind} '\{question}'")
  }
}

// ------------------------------------------------------------ evaluation

///|
/// Run the program.
pub async fn Interp::run(self : Interp) -> RunResult raise {
  self.prefetch()
  self.exec_block(self.program.body)
  let bindings : Array[(String, String)] = []
  for name in self.order {
    match self.scope.get(name) {
      Some(v) => bindings.push((name, v.show_text()))
      None => ()
    }
  }
  {
    effects: self.effects,
    output: self.output,
    bindings,
    trace: self.trace,
    requests: self.requests,
    batched: self.batched,
    lazy_asked: self.lazy_asked,
    input_tokens: self.input_tokens,
  }
}

///|
async fn Interp::exec_block(self : Interp, stmts : Array[Stmt]) -> Unit raise {
  for s in stmts {
    self.exec(s)
  }
}

///|
async fn Interp::exec(self : Interp, stmt : Stmt) -> Unit raise {
  match stmt {
    SLet(name, e) => {
      let value = self.eval(e)
      if self.scope.get(name) is None {
        self.order.push(name)
      }
      self.scope[name] = value
    }
    SDo(e) => {
      let _ = self.eval(e)

    }
    SIf(cond, then, otherwise) => {
      let c = self.eval(cond)
      if self.truthy(c) {
        self.exec_block(then)
      } else {
        match otherwise {
          Some(body) => self.exec_block(body)
          None => ()
        }
      }
    }
  }
}

///|
/// Only a noul probability is a condition on its own, and only at the
/// declared threshold. A number or a string is not: docs/01 is emphatic that
/// the cutoff is a code-side decision, so the language makes you write the
/// comparison instead of inventing one.
fn Interp::truthy(self : Interp, value : Value) -> Bool raise {
  match value {
    VBool(b) => b
    VProb(p) => p >= self.program.noul_threshold
    VNum(_, _) =>
      raise Runtime("a number is not a condition -- compare it, as in `x >= 1.5`")
    VStr(_, _) =>
      raise Runtime("a string is not a condition -- compare it, as in `x == \"a\"`")
  }
}

///|
async fn Interp::eval(self : Interp, node : Expr) -> Value raise {
  match node {
    ENum(v) => VNum(v, None)
    EBool(b) => VBool(b)
    EStr(s) => VStr(self.interpolate(s), None)
    EVar(name) =>
      match self.scope.get(name) {
        Some(v) => v
        None => raise Runtime("'\{name}' is not defined")
      }
    EConf(name) =>
      match self.scope.get(name) {
        // noul answers carry no confidence: the API does not return one.
        Some(v) => VNum(v.confidence().unwrap_or(0.0), None)
        None => raise Runtime("'\{name}' is not defined")
      }
    ENot(e) => {
      let v = self.eval(e)
      VBool(!self.truthy(v))
    }
    ELogic(op, l, r) => {
      let left = self.eval(l)
      let lt = self.truthy(left)
      if op == "&&" && !lt {
        return VBool(false)
      }
      if op == "||" && lt {
        return VBool(true)
      }
      let right = self.eval(r)
      VBool(self.truthy(right))
    }
    ECmp(op, l, r) => {
      let left = self.eval(l)
      let right = self.eval(r)
      VBool(compare_values(op, left, right))
    }
    EEffect(name, args) => {
      let values : Array[Value] = []
      for a in args {
        values.push(self.eval(a))
      }
      let rendered = values.map(v => v.show_text())
      self.effects.push((name, rendered))
      if name == "print" || name == "say" {
        self.output.push(rendered.join(" "))
      }
      // An effect evaluates to its first argument, which is what lets it sit
      // in a match arm: `"プリン" => buy("プリン")` binds "プリン".
      if values.length() > 0 {
        values[0]
      } else {
        VStr("", None)
      }
    }
    EJudge(j) => self.eval_judgment(j)
    EMatch(m) => self.eval_match(m)
  }
}

///|
async fn Interp::eval_judgment(self : Interp, j : JudgeNode) -> Value raise {
  let question = self.interpolate(j.question)
  let options : Array[String] = []
  for o in j.options {
    options.push(self.interpolate(o))
  }
  let answer = self.resolve(j.id, j.kind, question, options)
  match answer {
    @lib.Answer::NoulAnswer(p) =>
      if j.kind == "noul" {
        VProb(p)
      } else {
        raise Runtime("expected a \{j.kind} answer for '\{question}', got noul")
      }
    @lib.Answer::ChoiceAnswer(c, conf, _) =>
      if j.kind == "choice" {
        VStr(c, Some(conf))
      } else {
        raise Runtime("expected a \{j.kind} answer for '\{question}', got choice")
      }
    @lib.Answer::ScoreAnswer(s, conf, _, _) =>
      if j.kind == "score" {
        VNum(s, Some(conf))
      } else {
        raise Runtime("expected a \{j.kind} answer for '\{question}', got score")
      }
  }
}

///|
async fn Interp::eval_match(self : Interp, m : MatchNode) -> Value raise {
  let subject = self.eval(m.subject)
  let text = match subject {
    VStr(s, _) => s
    _ => raise Runtime("match needs a string")
  }
  // The gate decides before the arms do: if nothing applies, `else` wins even
  // when `choice` returned a perfectly good-looking option.
  match m.gate_id {
    Some(id) => {
      let options : Array[String] = []
      match m.subject {
        EJudge(j) if j.kind == "choice" =>
          for o in j.options {
            options.push(self.interpolate(o))
          }
        _ =>
          for arm in m.arms {
            options.push(self.interpolate(arm.0))
          }
      }
      let answer = self.resolve(id, "gate", gate_question(options), options)
      let p = match answer {
        @lib.Answer::NoulAnswer(v) => v
        _ => raise Runtime("the gate question came back in the wrong shape")
      }
      if p < self.program.gate_threshold {
        match m.fallback {
          Some(f) => return self.eval(f)
          None => ()
        }
      }
    }
    None => ()
  }
  for arm in m.arms {
    if self.interpolate(arm.0) == text {
      return self.eval(arm.1)
    }
  }
  match m.fallback {
    Some(f) => self.eval(f)
    None => raise Runtime("match has no arm for '\{text}' and no else arm")
  }
}

///|
fn Interp::interpolate(self : Interp, s : StrLit) -> String raise {
  let buf = StringBuilder()
  for p in s.parts {
    match p {
      Lit(text) => buf.write_string(text)
      Interp(name) =>
        match self.scope.get(name) {
          Some(v) => buf.write_string(v.show_text())
          None => raise Runtime("'\{name}' is not defined")
        }
    }
  }
  buf.to_string()
}

///|
fn compare_values(op : String, left : Value, right : Value) -> Bool raise {
  let left_str = match left {
    VStr(_, _) => true
    _ => false
  }
  let right_str = match right {
    VStr(_, _) => true
    _ => false
  }
  if left_str || right_str {
    if op != "==" && op != "!=" {
      raise Runtime("cannot use \{op} on strings")
    }
    let same = left.show_text() == right.show_text()
    return if op == "==" { same } else { !same }
  }
  let a = numeric_value(left)
  let b = numeric_value(right)
  match op {
    ">=" => a >= b
    "<=" => a <= b
    ">" => a > b
    "<" => a < b
    "==" => a == b
    _ => a != b
  }
}

///|
fn numeric_value(v : Value) -> Double raise {
  match v {
    VNum(x, _) => x
    VProb(x) => x
    VBool(b) => if b { 1.0 } else { 0.0 }
    VStr(_, _) => raise Runtime("cannot compare a string numerically")
  }
}
