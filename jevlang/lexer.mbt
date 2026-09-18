///|
/// Tokenizer for `.jev`. Mirrors `jevlang-js/src/lex.mjs`.
///
/// Works on `Array[Char]` rather than slicing the string, so multi-byte
/// identifiers (effect names written in Japanese) index the same way ASCII
/// ones do.

///|
pub(all) enum Tok {
  TNum(Double)
  TStr(Array[StrPart])
  TIdent(String)
  TKeyword(String)
  TPunct(String)
  TEof
} derive(Debug)

///|
pub(all) struct Token {
  tok : Tok
  line : Int
  col : Int
} derive(Debug)

///|
/// Words the parser matches structurally rather than as identifiers. Note
/// that `noul`, `choice`, `score`, `conf` and `match` are NOT here: they stay
/// identifiers so a program can still call an effect with a similar name.
let keywords : Array[String] = [
  "state", "threshold", "let", "if", "else", "match", "true", "false",
]

///|
/// Longest first, so `>=` wins over `>`.
let punct : Array[String] = [
  "=>", ">=", "<=", "==", "!=", "&&", "||", "{", "}", "(", ")", "[", "]", ",",
  ":", "=", ">", "<", "!",
]

///|
fn is_ident_start(c : Char) -> Bool {
  let n = c.to_int()
  (n >= 'a'.to_int() && n <= 'z'.to_int()) ||
  (n >= 'A'.to_int() && n <= 'Z'.to_int()) ||
  c == '_' ||
  n >= 128
}

///|
fn is_ident_char(c : Char) -> Bool {
  is_ident_start(c) || c.is_digit(10)
}

///|
/// Hand-rolled so the lexer needs no numeric-parsing dependency. Accepts
/// `12` and `1.5`; anything else is a syntax error at the call site.
///
/// The fraction is accumulated as an INTEGER and divided once at the end,
/// rather than added digit by digit against a shrinking scale. The naive form
/// makes `0.6` come out as 0.6000000000000001 while JS's `parseFloat` gives
/// exactly 0.6 — and since these numbers are thresholds, a program whose
/// `threshold noul = 0.6` sat exactly on a judgment's probability would then
/// branch differently in the two implementations.
fn parse_number(chars : Array[Char]) -> Double? {
  let mut whole = 0.0
  let mut i = 0
  let mut seen = false
  while i < chars.length() && chars[i] != '.' {
    if !chars[i].is_digit(10) {
      return None
    }
    whole = whole * 10.0 + (chars[i].to_int() - '0'.to_int()).to_double()
    seen = true
    i = i + 1
  }
  if i >= chars.length() {
    return if seen { Some(whole) } else { None }
  }
  i = i + 1 // skip the '.'
  let mut frac = 0.0
  let mut divisor = 1.0
  while i < chars.length() {
    if !chars[i].is_digit(10) {
      return None
    }
    frac = frac * 10.0 + (chars[i].to_int() - '0'.to_int()).to_double()
    divisor = divisor * 10.0
    seen = true
    i = i + 1
  }
  if seen {
    Some(whole + frac / divisor)
  } else {
    None
  }
}

///|
fn starts_with(chars : Array[Char], at : Int, text : String) -> Bool {
  let want = text.to_array()
  if at + want.length() > chars.length() {
    return false
  }
  for k in 0..<want.length() {
    if chars[at + k] != want[k] {
      return false
    }
  }
  true
}

///|
/// Split `source` into tokens, ending with `TEof`.
pub fn lex(source : String) -> Array[Token] raise {
  let chars = source.to_array()
  let tokens : Array[Token] = []
  let mut i = 0
  let mut line = 1
  let mut col = 1

  // Advancing through the source has to track line/col for error messages.
  fn bump() -> Unit {
    if chars[i] == '\n' {
      line = line + 1
      col = 1
    } else {
      col = col + 1
    }
    i = i + 1
  }

  while i < chars.length() {
    let c = chars[i]
    if c == '#' {
      while i < chars.length() && chars[i] != '\n' {
        bump()
      }
      continue
    }
    if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
      bump()
      continue
    }
    let start_line = line
    let start_col = col
    if c == '"' {
      bump()
      let parts : Array[StrPart] = []
      let buf : Array[Char] = []
      let mut closed = false
      while i < chars.length() {
        let ch = chars[i]
        if ch == '"' {
          bump()
          closed = true
          break
        }
        if ch == '\\' {
          bump()
          if i >= chars.length() {
            raise Syntax(line, col, "unterminated escape")
          }
          let esc = chars[i]
          buf.push(
            if esc == 'n' {
              '\n'
            } else if esc == 't' {
              '\t'
            } else {
              esc
            },
          )
          bump()
          continue
        }
        if ch == '$' && i + 1 < chars.length() && chars[i + 1] == '{' {
          if buf.length() > 0 {
            parts.push(Lit(String::from_array(buf)))
            buf.clear()
          }
          bump()
          bump()
          let ident : Array[Char] = []
          while i < chars.length() && is_ident_char(chars[i]) {
            ident.push(chars[i])
            bump()
          }
          if i >= chars.length() || chars[i] != '}' {
            raise Syntax(
              line, col, "interpolation takes a bare identifier, as in ${name}",
            )
          }
          bump()
          if ident.length() == 0 {
            raise Syntax(line, col, "empty interpolation")
          }
          parts.push(Interp(String::from_array(ident)))
          continue
        }
        buf.push(ch)
        bump()
      }
      if !closed {
        raise Syntax(start_line, start_col, "unterminated string")
      }
      if buf.length() > 0 || parts.length() == 0 {
        parts.push(Lit(String::from_array(buf)))
      }
      tokens.push({ tok: TStr(parts), line: start_line, col: start_col })
      continue
    }
    if c.is_digit(10) {
      let digits : Array[Char] = []
      while i < chars.length() && (chars[i].is_digit(10) || chars[i] == '.') {
        digits.push(chars[i])
        bump()
      }
      match parse_number(digits) {
        Some(v) => tokens.push({ tok: TNum(v), line: start_line, col: start_col })
        None =>
          raise Syntax(
            start_line, start_col, "bad number '\{String::from_array(digits)}'",
          )
      }
      continue
    }
    if is_ident_start(c) {
      let word : Array[Char] = []
      while i < chars.length() && is_ident_char(chars[i]) {
        word.push(chars[i])
        bump()
      }
      let text = String::from_array(word)
      let tok = if keywords.contains(text) {
        TKeyword(text)
      } else {
        TIdent(text)
      }
      tokens.push({ tok, line: start_line, col: start_col })
      continue
    }
    let mut matched = false
    for p in punct {
      if starts_with(chars, i, p) {
        for _ in 0..<p.length() {
          bump()
        }
        tokens.push({ tok: TPunct(p), line: start_line, col: start_col })
        matched = true
        break
      }
    }
    if matched {
      continue
    }
    raise Syntax(line, col, "unexpected character '\{c}'")
  }
  tokens.push({ tok: TEof, line, col })
  tokens
}
