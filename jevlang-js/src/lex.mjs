/**
 * Tokenizer for .jev.
 *
 * Deliberately small, because there are two implementations of this language
 * (this one and `jevlang/` in MoonBit) and they have to agree token for token.
 * Anything clever here is a thing that has to be got right twice.
 *
 * String interpolation only accepts a bare identifier -- `"${result} を買った"`
 * works, `"${a + b}"` does not. That is not laziness: whether a question's
 * text is known before the program runs is what decides if it can be hoisted
 * into the single batched request (see interp.mjs), and keeping the rule to
 * "does it mention a variable at all" keeps that analysis honest in both
 * implementations.
 */

export const KEYWORDS = new Set([
  "state",
  "threshold",
  "let",
  "if",
  "else",
  "match",
  "true",
  "false",
]);

export class JevSyntaxError extends Error {
  constructor(message, line, col) {
    super(`${line}:${col}: ${message}`);
    this.line = line;
    this.col = col;
  }
}

const PUNCT = [
  "=>",
  ">=",
  "<=",
  "==",
  "!=",
  "&&",
  "||",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ",",
  ":",
  "=",
  ">",
  "<",
  "!",
];

export function lex(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const fail = (msg) => {
    throw new JevSyntaxError(msg, line, col);
  };
  const advance = (n = 1) => {
    for (let k = 0; k < n; k += 1) {
      if (source[i] === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }

    const startLine = line;
    const startCol = col;

    if (ch === '"') {
      advance();
      // parts: {lit} for text, {ident} for an interpolated variable.
      const parts = [];
      let lit = "";
      for (;;) {
        if (i >= source.length) fail("unterminated string");
        const c = source[i];
        if (c === '"') {
          advance();
          break;
        }
        if (c === "\\") {
          advance();
          const esc = source[i];
          if (esc === undefined) fail("unterminated escape");
          lit += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
          advance();
          continue;
        }
        if (c === "$" && source[i + 1] === "{") {
          if (lit !== "") {
            parts.push({ lit });
            lit = "";
          }
          advance(2);
          let ident = "";
          while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
            ident += source[i];
            advance();
          }
          if (source[i] !== "}") {
            fail("interpolation takes a bare identifier, as in ${name}");
          }
          advance();
          if (ident === "") fail("empty interpolation");
          parts.push({ ident });
          continue;
        }
        lit += c;
        advance();
      }
      if (lit !== "" || parts.length === 0) parts.push({ lit });
      tokens.push({ type: "str", parts, line: startLine, col: startCol });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let text = "";
      while (i < source.length && /[0-9.]/.test(source[i])) {
        text += source[i];
        advance();
      }
      const value = Number.parseFloat(text);
      if (!Number.isFinite(value)) fail(`bad number '${text}'`);
      tokens.push({ type: "num", value, line: startLine, col: startCol });
      continue;
    }

    // Identifiers accept non-ASCII so effect names can be written in Japanese.
    if (/[A-Za-z_-￿]/.test(ch)) {
      let text = "";
      while (i < source.length && /[A-Za-z0-9_-￿]/.test(source[i])) {
        text += source[i];
        advance();
      }
      tokens.push({
        type: KEYWORDS.has(text) ? text : "ident",
        text,
        line: startLine,
        col: startCol,
      });
      continue;
    }

    const punct = PUNCT.find((p) => source.startsWith(p, i));
    if (punct) {
      advance(punct.length);
      tokens.push({ type: punct, line: startLine, col: startCol });
      continue;
    }

    fail(`unexpected character '${ch}'`);
  }

  tokens.push({ type: "eof", line, col });
  return tokens;
}
