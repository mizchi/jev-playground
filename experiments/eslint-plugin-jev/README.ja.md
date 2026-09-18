# @mizchi/eslint-plugin-jev

[English](./README.md) | 日本語

注意: **現時点ではジョーク実装であり、評価は済んでいません。この lint を信用するかどうかは完全にあなた次第です。**

パターンではなくモデルが判定を下す、2 つの ESLint ルール:

| ルール | 書くもの | 判定対象 |
| --- | --- | --- |
| `jev/rule` | **セレクタと一文** | セレクタにマッチしたすべてのノードを、あなたの一文に照らして |
| `jev/quality` | 何も書かない | すべての関数を、固定の質問セットと 8 つの名前付き欠陥クラスに照らして |

`jev/rule` は他のどの linter にも存在しないものです: ノードのセレクタをコードで書き、述語を一行の文章で書きます。ファイル内のすべての関数は、[Jev](https://typesafe.ai) への 1 リクエストでまとめて問い合わせられます。

```
  5:8  warning  `applyDiscount` matches the review criterion `unit_or_arithmetic` (0.94, its cutoff is 0.28)  jev/quality
 13:8  warning  `increment` matches the review criterion `lost_update` (0.93, its cutoff is 0.73)             jev/quality
 36:8  warning  Jev thinks `reachable` does the wrong thing for some realistic input (misbehaves 0.78)        jev/quality
 15:8  warning  Jev would push back on `formatYen` but is not sure -- worth a human look rather than a fix    jev/quality
```

> **ステータス: 実験。** npm にはそのまま公開していますが、実際のリポジトリで動かしたことはありません — 以下の数値はすべて 15 ファイル・78 関数のラベル付きコーパスから来ています。カットオフは *そのコーパスに合わせてフィット* されたもので、真っ先に再調整すべき対象です。[制約](#制約) を参照。

---

## 目次

- [仕組み](#仕組み)
- [インストール](#インストール)
- [クイックスタート](#クイックスタート)
- [`jev/rule`: まだ存在しないルール](#jevrule-まだ存在しないルール)
- [設定](#設定)
- [メッセージ](#メッセージ)
- [名前付き基準](#名前付き基準)
- [warm pass (CLI)](#warm-pass-cli)
- [キャッシュ](#キャッシュ)
- [`onMiss`: キャッシュに判定がないとき](#onmiss-キャッシュに判定がないとき)
- [コストとスケール](#コストとスケール)
- [何を捕まえるか](#何を捕まえるか)
- [制約](#制約)
- [開発](#開発)

## 仕組み

**ESLint のルールは同期的です。** `context.report()` は走査中に呼ぶ必要があり、どのフックも promise を返せないので、ルールは HTTP リクエストを await できません。そのためプラグインは 2 つのフェーズに分かれます:

```
  phase 1  warm pass (帯域外, async)             phase 2  eslint (sync)
  ┌────────────────────────────────────┐        ┌──────────────────────────┐
  │ 本物の ESLint を collector モードで │        │ jev/quality              │
  │ 実行 -> ルールが参照するのと同じ    │        │  Program:exit            │
  │ 単位を集める                       │        │  各関数をハッシュ        │
  │ ファイルごとに 1 リクエスト、      │───────▶│  キャッシュを引く        │
  │ 関数ごとに N 問                    │ .jev-  │  ゲートを適用            │
  │ -> 判定を content-addressed で保存 │quality │  context.report()        │
  └────────────────────────────────────┘ .json  └──────────────────────────┘
```

キャッシュキーは `sha256(schema + rubric + functionText)` なので content-addressed です: 関数を編集すれば判定は失効し (ルールは何も言わないか、ミスを報告する — どちらかは設定次第)、別ファイルに移動すれば判定は追随します。warm pass は本物の ESLint と本物のプラグインで関数を探すので、書き込むキーはルールが引くキーと完全に一致します。

判定の単位は、`minLines` 行以上の **最外側の** 関数 1 つ (declaration, expression, arrow, method) です。コールバックはデフォルトでスキップされ、それを含む関数の一部として判定されます。

## インストール

```bash
npm install --save-dev @mizchi/eslint-plugin-jev
```

このリポジトリから:

```bash
cd experiments/eslint-plugin-jev && npm install
```

ESLint >= 9 (flat config) と Node 18+ が必要です。`dependencies` はありません — Jev クライアントは 155 行の `fetch` です — peer dependency は `eslint` のみで、warm pass も同じ `eslint` を使ってルールと同じ方法で関数を見つけます。

## クイックスタート

まず `jev/rule` から: チームにはあるが、どの linter にも入っていない規約を 1 つ、セレクタ (コード) と一文 (文章) で書きます。`eslint.config.mjs`:

```js
import jev from "@mizchi/eslint-plugin-jev";

export default [
  {
    files: ["**/*.js"],
    plugins: { jev },
    rules: {
      "jev/rule": ["warn", {
        rules: [
          {
            id: "fetch-timeout",
            selector: "CallExpression[callee.name='fetch']",
            rule: "fetch は必ずタイムアウト (AbortSignal.timeout など) を渡すこと",
            note: "リトライラッパの内側で既に設定されている場合は違反ではない",
          },
        ],
      }],
    },
  },
];
```

```bash
export TYPESAFEAI_API_KEY=...   # または下の `--api-key`、または `apiKey` オプション

# 1. 問い合わせる。ファイルごとに 1 リクエスト。ルールは本物の config から読む。
npx jev-warm "src/**/*.js" --config eslint.config.mjs

# 2. lint する。ネットワークなし、API キーなし。
npx eslint src
```

```
 12:3  warning  fetch-timeout: fetch は必ずタイムアウトを渡すこと (violation, 2.74/3 confidence 0.74; reports at 2.00)  jev/rule
```

さらに、すべての関数を固定の質問セットでレビューさせたければ、隣に `jev/quality` を足します:

```js
rules: {
  "jev/rule": ["warn", { rules: [/* 上と同じ */] }],
  "jev/quality": ["warn", { rubric: "full" }],
},
```

```bash
# `--config` は jev/rule を warm する。`--rubric` は jev/quality のオプションと一致させること。
# 78 関数に 15 リクエスト、約 $0.004。lint は変わらず 12 ファイルで 31 ms。
npx jev-warm "src/**/*.js" --config eslint.config.mjs --rubric full
```

あるいはプリセットを使います。`jev/quality` のみ、`warn` かつ `onMiss: "silent"`、それ以外はすべてデフォルトです:

```js
import jev from "@mizchi/eslint-plugin-jev";

export default [jev.configs.recommended];
```

プリセットは `rubric` を `vague` のままにするので、使う場合は `--rubric vague` (デフォルト) で warm してください。ある rubric で warm して別の rubric で lint すると、誰も引かないキーだらけのキャッシュになります — しかもミスは silent なので、クリーンなコードとまったく同じに見えます。ルールが突然何も報告しなくなったら、まずここを疑ってください。

`error` ではなく `warn` なのは意図的です: ビルドを落とし得る確率的レビュアーは、結局オフにされる確率的レビュアーです。デフォルトの裏付けとなる計測値は、クリーンなコードへの 117 判定中 3 件の偽陽性 — 読む分には十分、マージのゲートにするには不十分です。

## `jev/rule`: まだ存在しないルール

チームの規約の半分は lint ルールにならず、理由はいつも同じです: セレクタは自明なのに、述語には一週間分の AST 作業が要る。`CallExpression[callee.name='fetch']` は 10 秒で書けます。「…タイムアウトなしで、ただし既にタイムアウトを設定するリトライラッパの内側にある場合を除く」は書かれないまま終わります。

だからセレクタをコードで、述語を一文で書きます — [クイックスタート](#クイックスタート) の `fetch-timeout` がその形そのものです。この分業がアイデアのすべてです:

| | 担当 | 失敗の仕方 |
| --- | --- | --- |
| `selector` | ESLint 自身の esquery — 厳密、無料、モデル不要 | **黙って**: マッチしなかったノードは決して問い合わせられない |
| `rule` | Jev、マッチしたノードごとに 1 回 | 声高に: すべてのスコアを読める |

**セレクタはわざと過剰にマッチするように書いてください。** セレクタは判断を含まない側なので、判断をさせるべきではありません。後述のスケールのレベル 0 は、モデルが「あなたのセレクタはこのルールと無関係なものを拾った」と言う手段であり、決して発火しないセレクタを手書きするより、レポートでそれを見る方が安上がりです。

### スケール

マッチしたノードごとに yes/no ではなく `score` が返ります。スコアには確信度が付き、ルールが二値であることは稀だからです:

| 0 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| ルールが該当しない | コードはルールを満たす | ルールを破っていると言える | 明らかに破っている |

`reportAt` のデフォルトは **2.0** で、これは調整された数値ではなくレベルの境界です: レベル 1 はコードがルールを *満たしている* ことを意味し、満たしているノードを報告するのは調整で消せる偽陽性ではなく、ルールが逆向きに発火しているということです。

### オプション

[設定](#設定) にあるもののうち `rubric` や関数に関するもの以外はすべて適用され、加えて:

| オプション | 型 | デフォルト | 動作 |
| --- | --- | --- | --- |
| `rules` | array | `[]` | ルール本体。`selector` と `rule` は必須。`id` (デフォルトはセレクタ)、`note`、`at` は任意。 |
| `rules[].note` | string | — | モデル向けの追加コンテキスト。**メッセージには決して表示されない**。例外事項はここに書く。 |
| `rules[].at` | number 0–3 | `reportAt` | そのルール個別のカットオフ。質問の一部ではないので、変えても再問い合わせは発生しない。 |
| `reportAt` | number 0–3 | `2` | `at` を持たないルールのカットオフ。 |
| `unsureBelow` | number 0–1 | `0.5` | この確信度未満の指摘は疑問形で表現される (`ruleUnsure`)。 |
| `batchSize` | integer | `256` | 1 リクエストあたりのマッチ数。自主的な上限 — [コストとスケール](#コストとスケール) を参照。 |
| `apiKey` | string | — | `onMiss: "ask"` のときのみ: 子プロセスが使うキー。`TYPESAFEAI_API_KEY` より優先。 |

メッセージ: `rule`、`ruleUnsure`、`ruleMissing` (`onMiss: "report"` のとき)、そして不正なエントリやパースできないセレクタに対する `ruleConfig`。最後のものは意図的に silent *ではありません*: 設定が落ちて一度も発火しないルールは、何も見つけなかったルールとまったく同じに見えるからです。

### warm する

ルールは 1 つのモジュールにまとめ、両方の場所からそれを import してください — 文はキャッシュキーの一部なので、コピーが 2 つあってずれると、決してヒットしないキャッシュになります:

```js
// jev-rules.mjs
export const rules = [ /* ... */ ];
```

```bash
npx jev-warm "src/**/*.js" --rules jev-rules.mjs --only rules --prune
npx jev-warm "src/**/*.js" --config eslint.config.mjs --only rules   # または本物の config から読む
```

| フラグ | 動作 |
| --- | --- |
| `--rules <path>` | ルール定義の `.mjs` または `.json` ファイル |
| `--config <path>` | 代わりに対象の本物の ESLint config からルールを取る |
| `--only rules` / `--only quality` | 2 つのルールのうち片方だけ warm する |
| `--batch-size <n>` | 256 の上限を上書きする |
| `--prune` | 以前の文の草稿が残した判定を削除する |

### ルールを書く

文を編集するとキーが変わるので、そのルールだけが再問い合わせされます。ループは安価で、読むべきは `rules-report` です:

```bash
npm run warm:rules       # テキストが変わったルールだけ
npm run rules            # あなたの文がセレクタのマッチに何をしたか
```

```
rule@draft                          cutoff  matches  reported  widest gap  cutoff in gap
no-string-built-query                 2.50       20         2        1.82  yes
atomic-read-modify-write              2.00        7         1        1.79  yes
explicit-sort-comparator              2.00        4         1        1.90  yes
no-stringly-arithmetic                2.00       14         1        2.16  yes
no-swallowed-catch                    1.50        4         2        0.77  yes
```

**読むべき数字はカットオフではなく gap です。** 機能しているルールは、違反をセレクタの他のマッチから広いマージンで分離し、そうなれば正確なしきい値はどうでもよくなります — gap の内側ならどこでも同じ答えになる。スコアが密集しているルールは、調整が必要なしきい値ではなく、弁別できていない文であり、どんなカットオフも救えません。

上の 5 つのルールを書く間に、両方のことが起きました:

- `no-magic-rounding` は `* 100 / 100` について問いましたが、コーパスにそれをするものはありません。gap **0.16**、報告なし。実際にある強制変換 (`toFixed()` を `* 1` で戻す) について問うように書き直したところ、gap **2.16**、それをしている唯一の関数を見つけました。
- `no-swallowed-catch` は最初「呼び出し元は失敗を知る必要があったか」を問いました — 判断の最も難しい部分で、catch ブロックからは見えません。すべての答えが中間に来て、gap **0.28**。ブロック自体が何をするかだけを問うように書き直すと、gap **0.77**。そしてレポートはカットオフの位置が間違っていると言い、それも正しかった。

### 計測結果

マッチのあった 12 コーパスファイルに 5 ルールをかけ、49 のマッチノードを **12 リクエスト $0.0011** で判定しました — 書き直しが必要だった 2 つの文を含めると 17 リクエスト $0.0015:

| | |
| --- | --- |
| セレクタがマッチしたノード | 49 |
| 文を通した後の指摘 | **7** |
| ラベル付きバグまたは smell に該当 | 6 |
| 確信のある指摘の正解 | **5 / 5** |
| 不確かな指摘の正解 | 1 / 2 |

確信のある指摘はすべてラベル付きバグに当たりました: lost update、文字列連結クエリ、欠けたソート比較関数、文字列強制変換の丸め、握りつぶされた書き込み失敗。唯一の誤答は `readJsonOrDefault` で、意図的に catch する関数です — そして確信度 **0.31** で返ってきたので、指摘ではなく疑問として報告されました。`unsureBelow` はそのためにあります。

そして 1 つのバグは、どのしきい値でも直せない理由で見逃されました: `compareTokens` は空のトークン 2 つに対して `true` を返します。これは `catch` のない握りつぶされた失敗です。`CatchClause` はマッチしなかったので、何も問われませんでした。**セレクタは黙って失敗する側です** — 片方だけをコードで書くことのコストがこれです。

## 設定

1 つのルール、`jev/quality`。すべてのオプション:

| オプション | 型 | デフォルト | 動作 |
| --- | --- | --- | --- |
| `rubric` | `"vague"` \| `"checklist"` \| `"atoms"` \| `"full"` | `"vague"` | 判定がどの質問セットから来たか。**warm pass と一致させること** — キャッシュキーの一部。 |
| `reportAt` | number 0–3 | `1.5` | レビュアーアクションのスコアがこれに達したら報告。 |
| `bugAt` | number 0–1 | `0.7` | 汎用の「誤動作する」確率がこれに達したら `bug` を報告。 |
| `unsureBelow` | number 0–1 | `0.5` | この確信度未満なら、報告は `quality` ではなく `unsure` になる。 |
| `criterionAt` | `{ [name]: number }` | [後述](#名前付き基準) | 基準ごとのカットオフ。デフォルトにマージされるので、1 つだけ上書きできる。 |
| `atomAt` | number 0–1 | `0.8` | `criterionAt` にエントリのない基準のフォールバック。同梱の 8 基準はすべてエントリを持つので、基準を追加した場合のみ意味がある。 |
| `minLines` | integer >= 1 | `3` | これより短い関数は無視。 |
| `includeCallbacks` | boolean | `false` | 引数として渡された関数も判定する。 |
| `cache` | string | `".jev-quality.json"` | 判定キャッシュのパス、cwd 相対。 |
| `onMiss` | `"silent"` \| `"report"` \| `"ask"` | `"silent"` | [キャッシュに判定がないときの動作](#onmiss-キャッシュに判定がないとき)。 |
| `timeout` | integer >= 100 | `30000` | ms。`onMiss: "ask"` のときのみ意味がある。 |
| `apiKey` | string | — | `onMiss: "ask"` のときのみ意味がある: 子プロセスが送るキーで、`TYPESAFEAI_API_KEY` より優先。ルール自身はネットワークに触れず、キーがメッセージに出ることもない。 |

未知のオプションは設定エラーです (`additionalProperties: false`)。

`minLines`、`includeCallbacks`、`rubric` はルールと warm pass で同じでなければならず、そうでなければルールは誰も書いていないキーを引きます。warm pass が `--min-lines`、`--include-callbacks`、`--rubric` を受け取るのはまさにそのためです。

### どの rubric か

`rubric` は何を問うかを決め、それが何を教えてもらえるかを決めます:

| rubric | 質問数/関数 | 指摘が教えてくれるもの | 捕捉数 (51 中) |
| --- | --- | --- | --- |
| `vague` | 2 | スコアと「誤動作する」 | 33 |
| `checklist` | 2 | 同上、ただし指示に基準を列挙 | 34 |
| `atoms` | 8 | **どの** 基準か、スコアなし | 38 |
| `full` | 10 | どの基準か *と* スコア | **41** |

`full` は `vague` の 3.3 倍のトークンを消費しますが、それでもファイルあたり 1 リクエストです。*何が* 悪いかを言う指摘が欲しければ払ってください。`vague` の指摘は *何かが* 悪いとしか言いません。

クラスに名前を付けることが主に効くのは、関数自身のテキストからは見えない欠陥です: ローカルに見えるものはどちらでも 15/15、それ以外は 14% → 52%。

### チューニング

ゲートは 3 つのテストで、最初に通ったものが勝ちます:

1. 名前付き基準のいずれかが **それ自身の** `criterionAt` を超える → `criterion`
2. 汎用の「誤動作する」>= `bugAt` → `bug`
3. スコア >= `reportAt` → `quality`、確信度 < `unsureBelow` なら `unsure`

より少なく、より確かな指摘が欲しければ、`reportAt` を 3 に、`bugAt`/`criterionAt` を 1 に近づけてください。確信度はゲート *ではありません*: 低確信度の報告も報告であり、`unsure` として届くだけです。確信度でゲートすることは、何の見返りもなく recall を 7–11 ポイント失うと計測されました。

```js
"jev/quality": ["warn", {
  rubric: "full",
  reportAt: 2,                                   // "request changes" 以上のみ
  criterionAt: { unescaped_composition: 0.6 },   // 過剰に発火するやつ
}],
```

`criterionAt` は **キーごとに** マージされるので、最後の行は 1 つのカットオフを上げ、他の 7 つはデフォルトのままです。1 つの基準を再調整しても、残りが黙って動くことはありません。

これらはどれもリクエストを消費しません: キャッシュは判定を保存し、ゲートは lint のたびに再計算されます。しきい値を調整して `eslint` を再実行してください — 再び払うのはコードが変わったときだけです。

## メッセージ

1 つのルールが 5 種類のことを報告します。すべて `jev/quality` として届くので、formatter やレポートで区別するには `messageId` を使います:

| messageId | 発火条件 | 意味 |
| --- | --- | --- |
| `criterion` | 名前付き基準が自身のカットオフを超えた | **何が** 悪いかを言う唯一のもの |
| `bug` | 汎用の「誤動作する」>= `bugAt` | 単に改善の余地があるのではなく、おそらく間違っている |
| `quality` | スコア >= `reportAt`、確信あり | レビュアーなら変更を求める |
| `unsure` | スコア >= `reportAt` だが確信度 < `unsureBelow` | 修正ではなく、人が見る価値あり |
| `missing` | キャッシュに判定がなく `onMiss: "report"` | warm pass がこの関数をカバーしていない |

`criterion` メッセージは "See docs/22 for what that criterion means" で終わります — それはこのリポジトリの [docs/22](../../docs/22-code-criteria.md) で、下の表はその短縮版です。

スコアは Jev が選んだレビュアーアクションで、0–3:

| 0 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| そのまま approve | コメント付きで approve | request changes | block: 誤っているように見える |

## 名前付き基準

`rubric: "atoms"` または `"full"` では、各関数について 8 つの具体的な欠陥クラスを問います。それぞれに固有のカットオフがあります。答えが同じスケールに乗っていないからです — 同じ確率でもクラスによって意味が違います (自身のクラスに対して 0.20 から 0.94 の幅があります):

| 基準 | カットオフ | 対象 |
| --- | --- | --- |
| `api_default` | 0.25 | ライブラリ呼び出しのデフォルトがコードの想定と違う |
| `unhandled_async` | 0.57 | rejection や値が漏れる promise |
| `boundary` | 0.58 | 入力範囲の端 |
| `swallows_failure` | 0.38 | 呼び出し元が知る必要のあった失敗 |
| `name_mismatch` | 0.48 | 名前が約束することを本体がしていない |
| `lost_update` | 0.73 | suspension point をまたぐ read-modify-write |
| `unescaped_composition` | 0.26 | 呼び出し元のテキストがパースされるものに継ぎ足されている |
| `unit_or_arithmetic` | 0.28 | 誤った演算または誤ったスケール |

複数の基準が発火したとき、報告されるのは生の確率が最も高いものではなく、自身のカットオフから最も離れているもの (`p / cutoff`) です。

既知の過剰発火: `unescaped_composition` は本質的にあらゆるテンプレートリテラルに高く答えるので、カットオフは低く、あなたのコードでノイズになる可能性が最も高い基準です。上げるか、`1` より大きく設定してその基準を完全にオフにしてください:

```js
criterionAt: { unescaped_composition: 1.01 },
```

8 つは重なり合っています。`api_default` 以外のどれか 1 つを落としても、隣接するものか汎用の質問がそのクラスを捕まえます — なので不完全なリストは穴を開けるのではなく、緩やかに劣化します。

## warm pass (CLI)

```bash
npx jev-warm "<glob>" [<glob>...] [options]
node src/warm.mjs "<glob>" ...              # checkout から同じことをする
```

glob はクォートしてください — シェルではなくツールに展開させないと、`**` の挙動がシェルによって変わります。

```
15 file(s), 78 function(s), 78 unique, 0 already cached, 78 to ask
  15 request(s) planned (arm: located, rubric: full)
  15 request(s), 102365 input tokens, $0.00430
  78 verdict(s) -> .jev-quality.json
```

| フラグ | デフォルト | 動作 |
| --- | --- | --- |
| `--rubric <name>` | `vague` | `vague` \| `checklist` \| `atoms` \| `full`。ルールと一致させること。 |
| `--cache <path>` | `.jev-quality.json` | 判定の書き込み先。 |
| `--concurrency <n>` | `4` | 同時リクエスト数。 |
| `--model <id>` | サーバのデフォルト | Jev モデル。 |
| `--api-key <key>` | `$TYPESAFEAI_API_KEY` | API キー。環境変数以外の場所に置いているとき用。 |
| `--min-lines <n>` | `3` | ルールと一致させること。 |
| `--include-callbacks` | off | ルールと一致させること。 |
| `--force` | off | キャッシュを無視してすべて再問い合わせ。 |
| `--dry-run` | off | バッチ計画とトークン見積りを表示し、何も問わない。 |
| `--arm <name>` | `located` | ファイルの提示方法: `located` \| `inlined` \| `solo` \| `isolated`。実験軸で、使うべきは `located`。 |

`--dry-run` は何も費やさずにリポジトリを確認する安価な方法です:

```
  15 request(s) planned (arm: located, rubric: full)
    experiment/corpus/access.js  10 fn  ~18901 tok
    experiment/corpus/cart.js     5 fn   ~9466 tok
    ...
```

キャッシュ済みの関数はスキップされ、リポジトリ内のどこにあっても同一の関数テキストは 1 問なので、小さな変更後の再実行はほぼ無料です。

### 環境変数

| 変数 | 用途 |
| --- | --- |
| `TYPESAFEAI_API_KEY` | `--api-key` / `apiKey` オプションがなければ warm pass と `onMiss: "ask"` が使う。ルール自身は決して読まない。 |
| `TYPESAFEAI_BASE_URL` | API エンドポイントの上書き。 |
| `JEV_QUALITY_CACHE` | デフォルトのキャッシュパス (`cache` オプションが優先)。 |
| `JEV_QUALITY_ARM` | `onMiss: "ask"` のデフォルト arm。 |
| `JEV_QUALITY_MODEL` | デフォルトモデル。 |

## キャッシュ

単一の JSON ファイルで、デフォルトは ESLint を実行する場所の `.jev-quality.json`:

```json
{
  "schema": "jev-quality-3",
  "model": "jev-latest",
  "arm": "located",
  "rubric": "full",
  "written": "2026-09-18T06:49:48.955Z",
  "entries": {
    "9c85409d9217d917da74": {
      "score": 0.75,
      "confidence": 0.59,
      "bug": 0.33,
      "atoms": { "api_default": 0.38, "boundary": 0.69, "lost_update": 0.02, "...": 0 },
      "name": "median",
      "file": "experiment/corpus/stats.js",
      "line": 8,
      "at": "2026-09-18T06:49:48.955Z"
    }
  }
}
```

`name`、`file`、`line` はファイルを読みやすくするためにあり、意味を持つのはキーだけです。スコアは 0–3 スケール上の重み付き位置であって 4 レベルのどれかではありません — 上の `median` は 0.75 で `reportAt` を大きく下回っており、報告されるのは `api_default` がカットオフ 0.25 に対して 0.38 と答えたからです。

両方のルールは 1 つのキャッシュファイルを、別々のキー名前空間で共有します。`jev/rule` のエントリは `kind: "rule"` と、答えた文の草稿ハッシュを持ちます:

```json
"6a3f01c8b2d47e95f0aa": {
  "score": 2.93, "confidence": 0.93,
  "kind": "rule", "rule": "atomic-read-modify-write", "ruleHash": "1f0a94c7",
  "node": "FunctionDeclaration", "file": "src/counters.js", "line": 13,
  "at": "2026-09-18T07:02:11.480Z"
}
```

`ruleHash` があるのは、文を書き直すと同じルール id の下に新しいキーが生まれ、古い判定が残るからです。プラグインはそれを決して読みません — キーで引くので — が、ルール id で集計するものは 2 つの草稿を平均してしまいます。warm pass の `--prune` がそれらを削除します。

- **コミットするかしないか、決めてください。** コミットすれば、CI は API キーなしで lint でき、レビュアーはあなたと同じ判定を見ます。コミットしなければ、CI 実行のたびに warm pass の費用がかかります。
- **これは信頼された入力です。** このファイルを編集できるものは何でも、ルールを黙らせたり、好きなことを報告させたりできます。ビルド成果物ではなく、ESLint config と同じように扱ってください。
- **不完全なエントリはデフォルトではなくミスです。** 設定された rubric が必要とするフィールドを持たないエントリは、ゼロとして採点されるのではなく、存在しないものとして扱われます。
- **キャッシュはプラグインに対して決して throw しません。** 欠落、読み取り不能、不正な形式、間違ったスキーマ — すべて「判定なし」になり、lint は続行します。`eslint` を壊し得るレビューツールは、レビューツールがないより悪い。

## `onMiss`: キャッシュに判定がないとき

| | セットアップ | lint 時間 (12 ファイル) | 使いどころ |
| --- | --- | --- | --- |
| `"silent"` *(デフォルト)* | 先に warm pass を実行 | **31 ms** | 日常。コールドキャッシュは何も言わない。 |
| `"report"` | 先に warm pass を実行 | 31 ms | CI。判定を黙ってスキップするより失敗させたいなら。 |
| `"ask"` | なし | 4327 ms (361 ms/ファイル) | まだ warm していないコードを一度だけ見る。 |

比較として、ルールをオフにした ESLint は同じ 12 ファイルで 36 ms です: warm 済みキャッシュのコストは計測不能です。`"ask"` はリクエストを行い答えをキャッシュに畳み込む子プロセス (`execFileSync`) でルールをブロックします。100 倍遅く、fail open です — どんなエラーも lint 実行を落とすのではなく、判定なしを返します。

## コストとスケール

| | |
| --- | --- |
| フルパス、78 関数、`full` | 15 リクエスト、102,365 入力トークン、**$0.0043** |
| 関数あたり、`vague` (2 問) | $0.000017 |
| 関数あたり、`full` (10 問) | $0.000055 |
| `full` 形式での関数あたり 283 トークン | 見積りではなく計測値 |

サーバ側の硬い上限が 2 つあり、どちらも計測済みで、どちらも質問数ではありません (1 リクエストに 1220 問は問題ありません):

| 上限 | 実際には |
| --- | --- |
| **state** に 32Ki トークン | おおよそ 2300 行のファイル 1 つ |
| **リクエスト全体** に 64Ki トークン | おおよそ 230 関数 |

バッチプランナーはすべてのリクエストを両方の上限以下に保ち、超えそうなファイルは分割します。クライアントも `max_tokens_exceeded` でサーバに拒否されたバッチを半分にします。state 上限に対して大きすぎるファイルだけは分割できません — 1 ファイル 2300 行が本当の限界です。

## 何を捕まえるか

15 ファイル / 641 行 / 78 関数で計測。うち 22 がラベル付きバグ (それぞれ関数を *実行する* プローブで証明済み)、5 が smell、9 が near-miss、42 がクリーン:

- `full` はラベル付き問題 **51 中 41** を捕まえます。
- `vague` は 33 で、その *確信のある* 指摘は 15/15 正解、偽陽性 0 — 高 precision、低 recall。
- 関数自身のテキストから見える欠陥では、rubric はほとんど関係ありません (どちらでも 15/15)。特定の API の挙動という外部知識が必要な欠陥では、クラスに名前を付けることで recall が 14% から 52% に上がります。
- クリーンなコードへの 117 判定中、偽陽性 3 件。

手法とすべての数値を含む完全な write-up: [docs/21](../../docs/21-eslint-plugin-jev.md) (プラグイン、同期ルール問題、バッチング、トークン上限) と [docs/22](../../docs/22-code-criteria.md) (8 つの具体的な欠陥クラスに名前を付けると何が変わるか、そして名前を付けなかったクラスの穴がどれほど深いか)。

## 制約

チームの前に出す前に読んでください:

- **カットオフは `experiment/corpus` のコーパスにフィットされたもの** で、既に一度再フィットされています。あなたのコードでは較正ではなく出発点です。`criterionAt` が真っ先に再調整すべきものです。
- **実際のリポジトリで動かしたことがありません。** ここにあるすべての数値は 641 行のラベル付きコーパスから来ています。
- **ファイルスコープであって diff スコープではありません。** 単位は関数、バッチはファイルで、「この PR が変えたものだけ」モードはありません。大きなリポジトリでは一度全体を warm し、以後は変わったものだけ再問い合わせしますが、初回はツリー全体です。
- **決定的ではなく、autofix もありません。** 同じ関数が別の日には別の確率で返ってくることがあります — キャッシュが単なる速度最適化ではない理由もこれです: 2 回の lint 実行を一致させるものがキャッシュです。`--from` リプレイも同じ理由で存在します。
- **`error` ではなく `warn`。** クリーンな 117 関数に偽陽性 3 件は、読む分には問題なく、マージをブロックするには問題があります。
- **コールドキャッシュはデフォルトで silent です。** これは意図的な fail-open です: 判定が走ったことを知る必要があるなら、CI で `onMiss: "report"` を使ってください。
- **設定上 JavaScript のみ。** プラグインに TypeScript 固有のものはありませんが、TypeScript で計測したこともありません。
- **`jev/rule` のセレクタは黙って失敗します。** マッチしないノードはどのしきい値でも決して問われず、レポートの何もその隙間を見せてくれません。コーパスのラベル付きバグの 1 つはまさにこの形で見逃されました。過剰にマッチするセレクタを書き、文に絞り込ませてください。
- **`jev/rule` は 5 ルール・49 ノードで計測されました。** 上の 5/5 という確信ありの precision は 5 件の指摘であって、当てにしてよい率ではありません。

## 開発

```bash
npm install

npm test                     # 109 チェック、API キー不要
npm run truth                # ラベルを、コードを実行して証明する
npm run rules                # ad-hoc ルールの記録済み実行、API キー不要
npm run replay               # docs/21 の数値を再導出、API キー不要
npm run replay:criteria      # docs/22 の数値を再導出、API キー不要
npm run replay:tiers         # docs/22 の補遺: named x hard の 2x2
npm run replay:loo           # docs/22 の補遺: 基準を 1 つずつ落とす

export TYPESAFEAI_API_KEY=...
npm run warm -- --rubric full   # jev/quality: 15 リクエスト、78 関数、$0.004
npm run warm:rules              # jev/rule: 12 リクエスト、49 マッチ、$0.001
npm run lint                    # eslint、両ルール、キャッシュ済み判定を読む

npm run run -- --repeat 3       # docs/21: 4-arm の計測 (state とバッチング)
npm run criteria -- --repeat 3  # docs/22: 4-rubric の計測 (何を問うか)
npm run loo -- --repeat 3       # docs/22 補遺: 基準を 1 つ除外
npm run bench                   # async を回避する各方法のコスト
```

`--from` リプレイは実行が **記録された** ときのしきい値で採点するので、カットオフを再調整しても公開済みのレポートは書き換わりません。`--current-thresholds` を付けると、今日のデフォルトがその同じ実行に何をしたかが見えます。

```
src/functions.mjs   AST -> 判定の単位 (関数 1 つ)
src/judge.mjs       `jev/quality`: 質問、rubric、ゲート、上限
src/rules.mjs       `jev/rule`: スケール、キー、ゲート、バッチプランナー
src/cache.mjs       判定キャッシュ。プラグインに対して決して throw しない
src/index.mjs       ESLint プラグイン (両ルール)
src/warm.mjs        帯域外のバッチ処理 (と両方のバッチプランナー)
src/sync-ask.mjs    `onMiss: "ask"` がブロックする子プロセス
src/jev.mjs         依存ゼロのクライアント。サーバが拒否したバッチを分割する

experiment/corpus/     15 ファイル、641 行、78 関数、ラベル付き
experiment/labels.mjs  ラベルと、コードを実行して証明するプローブ
experiment/rules.mjs   5 つの ad-hoc ルール、両方の書き直しをコメントに保持
experiment/truth.mjs   ラベルを検証する。何も費やさない
experiment/run.mjs     計測、`--from` リプレイ付き
experiment/rules-report.mjs  各文がセレクタのマッチに何をしたか
experiment/test.mjs    fail-safe の経路と両ゲートの真理値表
```

`experiment/out-run.json` は記録済みの実行です: `npm run replay` は write-up のすべての数値を API キーなし・ばらつきなしで再導出します。初回実行の後にゲートを再調整したのはこの方法です ([docs/19](../../docs/19-jevlang.md#4-record--replay--確率的な言語に必須の道具))。
