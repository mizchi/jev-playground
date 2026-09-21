/**
 * The drafts docs/26 retired, kept so the retirement is reproducible.
 *
 * Two sentences, five entries. `eslint.rules.mjs` ships neither of them any
 * more; this file is the evidence for why, and it is run against two targets:
 *
 *   out-repo-drafts.json   this repository (unlabelled, 9.8k lines of JS)
 *   out-repo-corpus.json   docs/22's corpus (labelled, where the answer is known)
 *
 * Part one: three drafts of ONE sentence, asked about two different subjects.
 *
 * docs/26 rewrote the note of docs/24's sentence because the first draft
 * reported twelve of this repository's twenty-eight catch clauses and none of
 * them was something to change: the repository swallows on purpose in two
 * places (the judgment layer falls silent by design, a label probe's boolean
 * IS its assertion). Adding an exception is the move docs/16 measured as
 * dangerous -- "渡した例外は隣のケースにも一般化される", 0 misses became 11 --
 * so the cost is measured here instead of assumed.
 *
 * The corpus is the only place where the answer is known:
 *
 *   fsutil.js:32  saveAll's `catch { // continue }`      labelled BUG
 *   fsutil.js:7   readJsonOrDefault's intentional catch  labelled NEARMISS
 *
 * The third draft changes neither the sentence nor the note. It changes the
 * SUBJECT: the selector matches the enclosing function instead of the catch
 * clause. Both earlier drafts rank the corpus's intentional catch
 * (`readJsonOrDefault`) above its real one, and the reason is visible in the
 * two names -- "OrDefault" is a promise the catch block cannot show. docs/24
 * §2's rule is to ask only what the subject shows; the other way to satisfy it
 * is to make the subject show more.
 *
 * The ids differ because the plugin drops duplicates, and a distinct id is
 * also a distinct cache key -- which is what lets every draft be asked in one
 * run.
 */
const RULE = "catch 節を、例外を投げ直しも伝播もせず、失敗を成功と区別できない値(空配列・空オブジェクト・null・true など)を返して終わらせないこと。";

export const rules = [
  // ---------------------------------------------------------- the catch rule
  {
    id: "swallowed-draft1",
    selector: "CatchClause",
    rule: RULE,
    note: "例外の内容を検査して分岐している場合、失敗を表す値を返している場合、再スローしている場合は違反ではない。",
    at: 1.5,
  },
  {
    id: "swallowed-fn",
    // The enclosing function, not the catch clause. Same sentence, same note.
    selector:
      "FunctionDeclaration:has(CatchClause), FunctionExpression:has(CatchClause), ArrowFunctionExpression:has(CatchClause), MethodDefinition:has(CatchClause)",
    rule: RULE,
    note: "例外の内容を検査して分岐している場合、失敗を表す値やフィールドを返している場合、再スローしている場合、失敗をカウンタやログに記録している場合、およびテストで例外が起きたこと自体を判定に使っている場合は違反ではない。",
    at: 1.5,
  },
  {
    id: "swallowed-draft2",
    selector: "CatchClause",
    rule: RULE,
    note: "例外の内容を検査して分岐している場合、失敗を表す値やフィールドを返している場合、再スローしている場合、失敗をカウンタやログに記録している場合、およびテストで例外が起きたこと自体を判定に使っている場合は違反ではない。",
    at: 1.5,
  },

  // ------------------------------------------------------- the constants rule
  //
  // Part two: the same code, asked in two ways. The first draft asks whether a
  // number was "observed", which the declaration cannot show; the second asks
  // only whether a reason is written next to it, which it can. docs/26 §3 has
  // what changed and what did not.
  {
    id: "constants-draft1",
    selector: "VariableDeclarator[id.name=/^[A-Z][A-Z0-9_]*$/]",
    rule: "観測して得た数値(API の上限・実測した秒数・当てはめた閾値)を定数に書くときは、その数がどこから来たのかを近くのコメントに書くこと。",
    note: "言語や仕様で決まっている値、その場で決めた便宜的な値であることがコメントから読める場合、および数値ではない定数は違反ではない。",
  },
  {
    id: "constants-draft2",
    selector: "VariableDeclarator[id.name=/^[A-Z][A-Z0-9_]*$/]",
    rule: "数値リテラルを含む定数の宣言には、その数をなぜその値にしたのかが近くのコメントに書かれていること。",
    note: "数値を含まない定数(文字列・配列・オブジェクト・関数)は対象外。理由・出典・測り方のいずれかがコメントから読めれば違反ではない。",
  },
];

export default rules;
