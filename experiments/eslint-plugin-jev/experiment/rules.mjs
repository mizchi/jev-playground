/**
 * Ad-hoc rules for the corpus: rules that do not exist in any linter, written
 * as sentences, with only the node selector written as code.
 *
 * One file, imported by both `eslint.config.mjs` and the warm pass, because
 * the rule TEXT is part of the cache key: two copies that drift produce a
 * cache that never hits.
 *
 * Each of these is deliberately a rule you cannot express as a selector. The
 * selector is the coarse part and it over-matches on purpose -- `async
 * FunctionDeclaration` is every async function in the corpus, and the sentence
 * is what narrows it to the ones that actually lose an update. Level 0 of the
 * scale ("the rule does not apply") is where the over-matching goes.
 */
export const rules = [
  {
    id: "no-swallowed-catch",
    // Every catch block. Whether the catch is a problem is the judgment.
    selector: "CatchClause",
    // Second draft. The first asked whether "呼び出し元が失敗を知る必要がある"
    // -- which is the hardest part of the judgment and is not visible in the
    // catch block, so every answer came back in the middle (all four matches
    // between 1.03 and 1.58, a 0.28 spread). This version asks only about what
    // the block itself does, and the spread went to 1.42.
    rule: "catch 節を、例外を投げ直しも伝播もせず、失敗を成功と区別できない値(空配列・空オブジェクト・null・true など)を返して終わらせないこと。",
    note: "例外の内容を検査して分岐している場合、失敗を表す値を返している場合、再スローしている場合は違反ではない。",
    // `rules-report` said the cutoff was NOT inside this rule's widest gap:
    // 2.0 was splitting 2.31 from 1.94 (0.37 apart) while the structural break
    // in the answers is at 1.94/1.17 (0.77). Both of the top two are real
    // swallowed failures in the corpus, so the report was pointing at the
    // right number. Changing `at` costs nothing -- the threshold is not part
    // of the question, so nothing is re-asked.
    at: 1.5,
  },
  {
    id: "atomic-read-modify-write",
    // Every async function. Most of them are fine.
    selector: "FunctionDeclaration[async=true], MethodDefinition[value.async=true]",
    rule: "await をまたいで同じ状態を read-modify-write しないこと。並行呼び出しで更新が失われる。",
  },
  {
    id: "no-string-built-query",
    // Every template literal. Almost all of them are innocent.
    selector: "TemplateLiteral",
    rule: "呼び出し元から来た文字列を、パースされるもの(SQL・URL・シェル・HTML・正規表現)に直接埋め込まないこと。",
    note: "埋め込む値がコード内のリテラルや数値、あるいはエスケープ済みの場合は違反ではない。",
    // Sharper than the default: this one is either true or it is not.
    at: 2.5,
  },
  {
    id: "explicit-sort-comparator",
    // Only `.sort(...)` calls -- the selector can be precise here.
    selector: "CallExpression[callee.property.name='sort']",
    rule: "数値の配列を sort するときは比較関数を渡すこと。既定の比較は文字列としての比較になる。",
  },
  {
    id: "no-stringly-arithmetic",
    selector: "BinaryExpression[operator='*'], BinaryExpression[operator='/']",
    // Second draft. The first was about 金額の丸め and `*100 / 100`, which no
    // code in this corpus does -- so 0.53 was the right answer to the wrong
    // question, and the spread was 0.16. The bug actually present is
    // `amount.toFixed(2)` fed back through `* 1`, so this asks about that.
    rule: "文字列を算術演算子で数値に戻さないこと。`toFixed()` や `String()` の結果に掛ける・割るのは、数値変換を演算子の副作用に頼っている。",
    note: "両辺がもともと数値である算術は違反ではない。",
  },
];

export default rules;
