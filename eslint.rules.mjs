/**
 * This repository's own conventions, as jev/rule sentences.
 *
 * docs/24 wrote five ad-hoc rules against a 641-line corpus of planted bugs
 * and left the obvious limit: it had never been pointed at a real repository.
 * This is that run (docs/26). The rules come from three places, and which one
 * a rule comes from is the whole reason it is here:
 *
 *   reused    Three of docs/24's five sentences, VERBATIM. Same question, new
 *             code: the gap either survives the move or it does not.
 *   prose     Conventions this repository states in docs/ and nowhere else.
 *             No linter has them, and writing them as AST code is the week of
 *             work that stops teams from having them at all.
 *   probe     A convention the repository demonstrably already follows. There
 *             is no label set for real code, so these are the ground truth
 *             that can be had: a report here is a false positive, full stop.
 *
 * The selectors over-match on purpose (docs/24 §4): `TemplateLiteral` is every
 * template literal in a codebase that prints tables for a living. Level 0 of
 * the scale is where that goes.
 *
 * One file, imported by `eslint.config.mjs` and passed to the warm pass with
 * `--rules`, because the sentence is part of the cache key and two copies that
 * drift produce a cache that never hits.
 *
 * `origin` is for the report, not for the plugin: the schema rejects fields it
 * does not know, which is the right call for a config surface, so it is
 * stripped out below and exported separately.
 */
const declared = [
  // ------------------------------------------------------- reused from docs/24
  {
    id: "no-swallowed-catch",
    origin: "reused",
    // RETIRED for this repository, and the reason is the measurement rather
    // than a preference. At docs/24's cutoff it reports 12 of 28 catch clauses
    // here and not one of them is something to change; raising the cutoff only
    // trades which intentional catch it points at. The labelled corpus says
    // why no cutoff rescues it: in all three drafts (§5) the corpus's
    // INTENTIONAL catch outscores its real bug, because "the caller is
    // supposed to distinguish failure" is not visible in the block, in the
    // enclosing function, or anywhere the subject can reach.
    retired: true,
    selector: "CatchClause",
    rule: "catch 節を、例外を投げ直しも伝播もせず、失敗を成功と区別できない値(空配列・空オブジェクト・null・true など)を返して終わらせないこと。",
    // SECOND DRAFT for this repository. docs/24's sentence and note, verbatim,
    // reported 12 of 28 catch clauses here -- and reading all twelve, none was
    // something to change: this codebase's own conventions are to swallow on
    // purpose. The judgment layer falls silent by design (docs/18: every
    // failure path lands on "no decision"), and a label probe's `catch { return
    // true }` IS its assertion. The corpus docs/24 fitted on had no intentional
    // version of the shape, so the sentence could not have known about it.
    //
    // The two added clauses are the exception docs/16 warns about -- give a
    // model an exemption and it goes looking for one -- so the cost is measured
    // rather than assumed: `out-repo-corpus.json` runs this draft against
    // docs/22's labelled corpus, where the one真 swallowed failure is known.
    note: "例外の内容を検査して分岐している場合、失敗を表す値やフィールドを返している場合、再スローしている場合、失敗をカウンタやログに記録している場合、およびテストで例外が起きたこと自体を判定に使っている場合は違反ではない。",
    // docs/24 lowered this from 2.0 after its report said the cutoff was not
    // inside the widest gap. Carried over unchanged so the two runs compare.
    at: 1.5,
  },
  {
    id: "explicit-sort-comparator",
    origin: "reused",
    selector: "CallExpression[callee.property.name='sort']",
    rule: "数値の配列を sort するときは比較関数を渡すこと。既定の比較は文字列としての比較になる。",
  },
  {
    id: "no-string-built-query",
    origin: "reused",
    selector: "TemplateLiteral",
    rule: "呼び出し元から来た文字列を、パースされるもの(SQL・URL・シェル・HTML・正規表現)に直接埋め込まないこと。",
    note: "埋め込む値がコード内のリテラルや数値、あるいはエスケープ済みの場合は違反ではない。",
    at: 2.5,
  },

  // --------------------------------------------- this repository's own prose
  {
    id: "measured-number-has-a-source",
    origin: "prose",
    // RETIRED, after two drafts. It is the most useful rule in this file and
    // it does not work: it found the two numbers in this repository whose
    // provenance was genuinely missing (both now documented), and it cannot
    // tell them from an enum's 0/1/2. Neither draft separates -- 0.05..2.29
    // with a widest gap of 0.26, then 0.09..2.49 with 0.39 -- because "why
    // this number" has no bright line: a timeout needs a reason, an enum does
    // not, and nothing in the code says which kind it is.
    retired: true,
    // Every SCREAMING_CASE constant. Whether its number needs a provenance
    // note is the judgment, and the evidence is the comment ABOVE it -- which
    // is not in the matched node at all, only in the file the state carries.
    selector: "VariableDeclarator[id.name=/^[A-Z][A-Z0-9_]*$/]",
    // SECOND DRAFT. The first asked whether the number was "観測して得た数値"
    // -- which the declaration cannot show: nothing in `TIMEOUT_MS = 2500`
    // says whether 2500 was measured or picked. Every answer landed in the
    // middle as a result (69 matches spread 0.05..2.29, widest gap 0.26, and
    // the five reports came back at confidence 0.02-0.36). docs/24 §2 had
    // already named this failure -- do not put a condition the subject cannot
    // show into the sentence -- and writing it again anyway is how this draft
    // exists. The second draft asks only what is in the file.
    rule: "数値リテラルを含む定数の宣言には、その数をなぜその値にしたのかが近くのコメントに書かれていること。",
    note: "数値を含まない定数(文字列・配列・オブジェクト・関数)は対象外。理由・出典・測り方のいずれかがコメントから読めれば違反ではない。",
  },
  {
    id: "no-threshold-in-question",
    origin: "prose",
    // Every `instructions:` property -- the text that goes to the model.
    selector: "Property[key.name='instructions']",
    rule: "Jev に渡す質問文に、判定を分ける閾値の数値を書かないこと。閾値はコード側に置く。",
    note: "score のレベルの説明、単位、スケールの範囲は閾値ではない。",
  },
  {
    id: "no-process-exit-in-module",
    origin: "prose",
    selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']",
    rule: "プロセスの終了コードを決めるのはコマンドとして直接実行されるファイルだけ。他から import されるモジュールのコードから process.exit を呼ばないこと。",
    note: "そのファイル自身が実行可能なエントリポイントである場合(shebang がある、トップレベルで main を呼んでいる、テストランナーである)は違反ではない。",
  },

  // ----------------------------------------------------------------- probes
  {
    id: "noul-criteria-nested",
    origin: "probe",
    // Every object that declares a question type. docs/00: a noul's
    // `true`/`false` descriptions must sit under `criteria`, because the
    // server silently ignores them at the top level -- 200 OK, no warning,
    // and the only symptom is 28 fewer input tokens.
    selector: "ObjectExpression:has(Property[key.name='type'][value.value='noul'])",
    rule: "noul の質問で、true / false の説明を criteria の下にネストすること。トップレベルに置くとサーバーが黙って無視する。",
    note: "説明そのものを書いていない質問は違反ではない。",
  },
  {
    id: "fail-safe-silence",
    origin: "probe",
    // Scoped to hooks/** by the config, not by the sentence: docs/24's lesson
    // is that a condition the subject cannot show ("is this the deciding
    // layer?") must not be written into the question.
    selector: "CatchClause",
    rule: "失敗したときは「判断なし」に落とすこと。失敗を、許可や拒否という決定に変換しないこと。",
    note: "判断を返さずに終わる、呼び出し元に失敗を伝える、既定の動作に任せる、のいずれかであれば違反ではない。",
  },
];

/** Rule id -> where the sentence came from. Read by the docs/26 report. */
export const origins = Object.fromEntries(declared.map((r) => [r.id, r.origin]));

/**
 * Rules the measurement retired. Kept in this file rather than deleted: a
 * sentence that was tried and did not work is the expensive part of the
 * authoring loop, and the next person to write "numbers should say where they
 * came from" should find out here that it has already been measured twice.
 *
 * The config drops them; the report still reads them, because their verdicts
 * are in the committed cache and their cutoffs are what docs/26 quotes.
 */
export const retiredIds = new Set(declared.filter((r) => r.retired).map((r) => r.id));

/** Every sentence, retired ones included: what the report scores. */
export const rules = declared.map(({ origin, retired, ...rule }) => rule);

/** What the plugin is given. */
export const active = rules.filter((r) => !retiredIds.has(r.id));

export default rules;
