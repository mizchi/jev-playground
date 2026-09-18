///|
/// Parser for `.jev`. Mirrors `jevlang-js/src/parse.mjs`, including the order
/// in which judgment ids are handed out — a `match`'s gate id comes after
/// everything inside the match, so both implementations number identically.

///|
priv struct Parser {
  tokens : Array[Token]
  mut pos : Int
  mut judgments : Int
}

///|
fn Parser::peek(self : Parser) -> Token {
  let i = if self.pos < self.tokens.length() {
    self.pos
  } else {
    self.tokens.length() - 1
  }
  self.tokens[i]
}

///|
fn Parser::next(self : Parser) -> Token {
  let tok = self.peek()
  self.pos = self.pos + 1
  tok
}

///|
fn Parser::fail(self : Parser, msg : String) -> Unit raise {
  let tok = self.peek()
  raise Syntax(tok.line, tok.col, msg)
}

///|
fn Parser::describe(self : Parser) -> String {
  match self.peek().tok {
    TEof => "end of file"
    TIdent(t) => "'\{t}'"
    TKeyword(t) => "'\{t}'"
    TPunct(t) => "'\{t}'"
    TStr(_) => "a string"
    TNum(_) => "a number"
  }
}

///|
fn Parser::at_punct(self : Parser, p : String) -> Bool {
  match self.peek().tok {
    TPunct(t) => t == p
    _ => false
  }
}

///|
fn Parser::at_keyword(self : Parser, k : String) -> Bool {
  match self.peek().tok {
    TKeyword(t) => t == k
    _ => false
  }
}

///|
fn Parser::at_ident(self : Parser) -> String? {
  match self.peek().tok {
    TIdent(t) => Some(t)
    _ => None
  }
}

///|
fn Parser::eat_punct(self : Parser, p : String) -> Bool {
  if self.at_punct(p) {
    self.pos = self.pos + 1
    true
  } else {
    false
  }
}

///|
fn Parser::eat_keyword(self : Parser, k : String) -> Bool {
  if self.at_keyword(k) {
    self.pos = self.pos + 1
    true
  } else {
    false
  }
}

///|
fn Parser::expect_punct(self : Parser, p : String) -> Unit raise {
  if !self.eat_punct(p) {
    self.fail("expected '\{p}', found \{self.describe()}")
  }
}

///|
fn Parser::expect_keyword(self : Parser, k : String) -> Unit raise {
  if !self.eat_keyword(k) {
    self.fail("expected '\{k}', found \{self.describe()}")
  }
}

///|
fn Parser::expect_ident(self : Parser, what : String) -> String raise {
  match self.peek().tok {
    TIdent(t) => {
      self.pos = self.pos + 1
      t
    }
    _ => {
      self.fail("expected \{what}, found \{self.describe()}")
      ""
    }
  }
}

///|
fn Parser::expect_number(self : Parser) -> Double raise {
  match self.peek().tok {
    TNum(v) => {
      self.pos = self.pos + 1
      v
    }
    _ => {
      self.fail("expected a number, found \{self.describe()}")
      0.0
    }
  }
}

///|
fn Parser::expect_string(self : Parser) -> StrLit raise {
  match self.peek().tok {
    TStr(parts) => {
      self.pos = self.pos + 1
      { parts, }
    }
    _ => {
      self.fail("expected a string, found \{self.describe()}")
      { parts: [] }
    }
  }
}

///|
fn Parser::next_judgment_id(self : Parser) -> String {
  let id = "j\{self.judgments}"
  self.judgments = self.judgments + 1
  id
}

// ------------------------------------------------------------- literals

///|
/// The `state` block. Plain data only: no judgments, no variables.
fn Parser::object(self : Parser) -> Literal raise {
  self.expect_punct("{")
  let entries : Array[(String, Literal)] = []
  while !self.at_punct("}") {
    let key = match self.next().tok {
      TIdent(t) => t
      TKeyword(t) => t
      TStr(parts) => str_lit_text(parts)
      _ => {
        self.pos = self.pos - 1
        self.fail("expected a key, found \{self.describe()}")
        ""
      }
    }
    self.expect_punct(":")
    entries.push((key, self.literal()))
    if !self.eat_punct(",") {
      break
    }
  }
  self.expect_punct("}")
  LObj(entries)
}

///|
fn Parser::literal(self : Parser) -> Literal raise {
  if self.at_keyword("true") {
    self.pos = self.pos + 1
    return LBool(true)
  }
  if self.at_keyword("false") {
    self.pos = self.pos + 1
    return LBool(false)
  }
  if self.at_punct("[") {
    self.pos = self.pos + 1
    let items : Array[Literal] = []
    while !self.at_punct("]") {
      items.push(self.literal())
      if !self.eat_punct(",") {
        break
      }
    }
    self.expect_punct("]")
    return LArr(items)
  }
  if self.at_punct("{") {
    return self.object()
  }
  match self.peek().tok {
    TNum(v) => {
      self.pos = self.pos + 1
      LNum(v)
    }
    TStr(parts) => {
      self.pos = self.pos + 1
      for p in parts {
        match p {
          Interp(_) =>
            self.fail("the state block cannot interpolate variables")
          Lit(_) => ()
        }
      }
      LStr(str_lit_text(parts))
    }
    _ => {
      self.fail("expected a value, found \{self.describe()}")
      LBool(false)
    }
  }
}

///|
/// The literal text of a string with no interpolation.
pub fn str_lit_text(parts : Array[StrPart]) -> String {
  let buf = StringBuilder()
  for p in parts {
    match p {
      Lit(s) => buf.write_string(s)
      Interp(_) => ()
    }
  }
  buf.to_string()
}

// ---------------------------------------------------------- expressions

///|
fn Parser::expr(self : Parser) -> Expr raise {
  self.or_expr()
}

///|
fn Parser::or_expr(self : Parser) -> Expr raise {
  let mut left = self.and_expr()
  while self.at_punct("||") {
    self.pos = self.pos + 1
    left = ELogic("||", left, self.and_expr())
  }
  left
}

///|
fn Parser::and_expr(self : Parser) -> Expr raise {
  let mut left = self.cmp_expr()
  while self.at_punct("&&") {
    self.pos = self.pos + 1
    left = ELogic("&&", left, self.cmp_expr())
  }
  left
}

///|
fn Parser::cmp_expr(self : Parser) -> Expr raise {
  let left = self.unary()
  for op in [">=", "<=", "==", "!=", ">", "<"] {
    if self.at_punct(op) {
      self.pos = self.pos + 1
      return ECmp(op, left, self.unary())
    }
  }
  left
}

///|
fn Parser::unary(self : Parser) -> Expr raise {
  if self.at_punct("!") {
    self.pos = self.pos + 1
    return ENot(self.unary())
  }
  self.primary()
}

///|
fn Parser::primary(self : Parser) -> Expr raise {
  if self.at_keyword("true") {
    self.pos = self.pos + 1
    return EBool(true)
  }
  if self.at_keyword("false") {
    self.pos = self.pos + 1
    return EBool(false)
  }
  if self.at_keyword("match") {
    return self.match_expr()
  }
  if self.at_punct("(") {
    self.pos = self.pos + 1
    let inner = self.expr()
    self.expect_punct(")")
    return inner
  }
  match self.peek().tok {
    TNum(v) => {
      self.pos = self.pos + 1
      return ENum(v)
    }
    TStr(parts) => {
      self.pos = self.pos + 1
      return EStr({ parts, })
    }
    _ => ()
  }
  match self.at_ident() {
    Some(name) => {
      if name == "noul" || name == "choice" || name == "score" {
        return self.judgment()
      }
      if name == "conf" {
        self.pos = self.pos + 1
        self.expect_punct("(")
        let target = self.expect_ident("a variable name")
        self.expect_punct(")")
        return EConf(target)
      }
      self.pos = self.pos + 1
      if self.at_punct("(") {
        self.pos = self.pos + 1
        let args : Array[Expr] = []
        while !self.at_punct(")") {
          args.push(self.expr())
          if !self.eat_punct(",") {
            break
          }
        }
        self.expect_punct(")")
        return EEffect(name, args)
      }
      EVar(name)
    }
    None => {
      self.fail("expected an expression, found \{self.describe()}")
      EBool(false)
    }
  }
}

///|
fn Parser::judgment(self : Parser) -> Expr raise {
  let tok = self.peek()
  let kind = match tok.tok {
    TIdent(t) => t
    _ => "noul"
  }
  self.pos = self.pos + 1
  self.expect_punct("(")
  let question = self.expect_string()
  let options : Array[StrLit] = []
  if kind == "noul" {
    self.expect_punct(")")
  } else {
    self.expect_punct(",")
    self.expect_punct("[")
    while !self.at_punct("]") {
      options.push(self.expect_string())
      if !self.eat_punct(",") {
        break
      }
    }
    self.expect_punct("]")
    let _ = self.eat_punct(",")
    self.expect_punct(")")
    if options.length() == 0 {
      raise Syntax(tok.line, tok.col, "\{kind} needs at least one option")
    }
  }
  EJudge({ kind, id: self.next_judgment_id(), question, options })
}

///|
fn Parser::match_expr(self : Parser) -> Expr raise {
  self.expect_keyword("match")
  let subject = self.expr()
  self.expect_punct("{")
  let arms : Array[(StrLit, Expr)] = []
  let mut fallback : Expr? = None
  while !self.at_punct("}") {
    if self.at_keyword("else") {
      self.pos = self.pos + 1
      self.expect_punct("=>")
      fallback = Some(self.expr())
      let _ = self.eat_punct(",")
      continue
    }
    let lit = self.expect_string()
    self.expect_punct("=>")
    arms.push((lit, self.expr()))
    let _ = self.eat_punct(",")
  }
  self.expect_punct("}")
  // An `else` arm needs a way to say "none of these applies", and docs/13
  // measured that it belongs in its own noul rather than as an extra choice
  // option. The id is taken after the arms so the JS implementation numbers
  // judgments the same way.
  let gate_id = match fallback {
    Some(_) => Some(self.next_judgment_id())
    None => None
  }
  EMatch({ subject, arms, fallback, gate_id })
}

// ----------------------------------------------------------- statements

///|
fn Parser::block(self : Parser) -> Array[Stmt] raise {
  self.expect_punct("{")
  let body : Array[Stmt] = []
  while !self.at_punct("}") {
    body.push(self.stmt())
  }
  self.expect_punct("}")
  body
}

///|
fn Parser::stmt(self : Parser) -> Stmt raise {
  if self.at_keyword("let") {
    self.pos = self.pos + 1
    let name = self.expect_ident("a variable name")
    self.expect_punct("=")
    return SLet(name, self.expr())
  }
  if self.at_keyword("if") {
    self.pos = self.pos + 1
    let cond = self.expr()
    let then = self.block()
    let mut otherwise : Array[Stmt]? = None
    if self.eat_keyword("else") {
      otherwise = Some(
        if self.at_keyword("if") {
          [self.stmt()]
        } else {
          self.block()
        },
      )
    }
    return SIf(cond, then, otherwise)
  }
  SDo(self.expr())
}

// -------------------------------------------------------------- program

///|
/// Parse a whole program. Raises `Syntax(line, col, message)`.
pub fn parse(source : String) -> Program raise {
  let p = { tokens: lex(source), pos: 0, judgments: 0 }
  let mut state : Literal = LObj([])
  let mut saw_state = false
  let mut noul_threshold = 0.5
  let mut gate_threshold = 0.5
  let body : Array[Stmt] = []
  while true {
    match p.peek().tok {
      TEof => break
      _ => ()
    }
    if p.at_keyword("state") {
      let tok = p.peek()
      p.pos = p.pos + 1
      if saw_state {
        raise Syntax(tok.line, tok.col, "only one state block is allowed")
      }
      saw_state = true
      state = p.object()
      continue
    }
    if p.at_keyword("threshold") {
      p.pos = p.pos + 1
      let name = p.expect_ident("a threshold name")
      p.expect_punct("=")
      let value = p.expect_number()
      if name == "noul" {
        noul_threshold = value
      } else if name == "gate" {
        gate_threshold = value
      } else {
        raise Syntax(
          p.peek().line,
          p.peek().col,
          "unknown threshold '\{name}'; expected 'noul' or 'gate'",
        )
      }
      continue
    }
    body.push(p.stmt())
  }
  { state, noul_threshold, gate_threshold, body, judgment_count: p.judgments }
}
