# jev-playground

TypeSafe AI の System One モデル **Jev** を MoonBit から触るためのプレイグラウンド。
Jev は「文字列ではなく**型付きの確率判断**を返す」意思決定専用モデルです(unstructured state in, typed probabilistic decisions out)。

このリポジトリの構成:

| パッケージ | 内容 |
| --- | --- |
| `lib/` | Jev API クライアント(`GET /v1/models`・`POST /v1/systemone`、noul/choice/score 3 種の質問と型付き応答の JSON 変換) |
| `cmd/jev` | 単発質問 CLI(モデル一覧・state に対する型付き質問) |
| `cmd/gomoku` | 五目並べで Jev 同士を対戦させる CLI(毎手、盤面+着手候補を Jev に判断させる) |
| `cmd/gomoku_gif` | 対局ログ(各手の実測ミリ秒付き)を**実時間再生の GIF** に変換するツール |
| `cmd/patterns` | 公式ドキュメントの[意思決定パターン](https://docs.typesafe.ai/patterns)を実 API に対して走らせ、効果を実測する CLI |
| `cmd/shellrisk` | シェルコマンドの危険度判定(エージェントの実行許可ゲート) |
| `moba/`, `cmd/moba` | ヘッドレス 3v3 MOBA(2 レーン + ジャングル、視界と戦場の霧)を Jev に操作させる |
| `moba5/`, `cmd/moba5` | **ヘッドレス 5v5 MOBA**(3 レーン + 両サイドのジャングル + 川、レベル・アイテム・スキル・目標・ミニオン・ワード)と、**シミュレータ自身が正解を出す採点ベンチマーク** |
| `report/` | 実験 CLI 共通の整形と応答アクセサ |
| `experiments/` | TypeScript / JS 側の実験(チェス・ブラウザ探索・エージェント生成プロンプト・ESLint 合否予測) |
| `experiments/eslint-plugin-jev` | **eslint-plugin-jev** — 判定を Jev がやる ESLint プラグイン(関数ごとの score と名前付きレビュー指標 + **セレクタ 1 個と 1 文で書く ad-hoc ルール**、ファイル単位でバッチ) |
| `experiments/task-filter` | **タスク/テストランナーの filter** — `just` の依存グラフ + diff で「今何を走らせるか」を採点 |
| `justfile` | このリポジトリのチェックをタスクグラフにしたもの(`just ci` で全部、`just test-lib` で 1 つ) |
| `hooks/` | Claude Code の `PreToolUse` hook(Bash コマンドの実行許可ゲート。依存ゼロの Node スクリプト) |
| `jevdsl/`, `cmd/jevdsl` | **jevdsl** — 判断を `match` できる値にする薄いラッパー(MoonBit) |
| `jevlang/`, `cmd/jevlang` | **jevlang**(MoonBit 版)— 条件が Jev の判断である小さな言語 |
| `jevlang-js/` | jevlang(JS 版)。同じ `.jev` を走らせ、結果の一致をテストしている |
| `examples/` | `.jev` のサンプルと、API 不要で再現するための transcript |

**どのパターンが優位かの実測レポートは [`docs/`](docs/) にあります**
([索引](docs/README.md))。
読む順に 4 つの入口があります:

| | 何が書いてあるか |
| --- | --- |
| [**docs/practice.md**](docs/practice.md) | **Jev を使うときに順番に決めること**(手順書・やってはいけないこと一覧) |
| [**docs/findings.md**](docs/findings.md) | **実験ごとに何がわかったか**(1 本 = 1 ブロック) |
| [**docs/summary.md**](docs/summary.md) | やったこと / わかったことの端的な要約 |
| [**TODO.md**](TODO.md) | **残作業。** 「なぜ開いているか」と「何があれば閉じるか」を項目ごとに。**閉じ方が分からないものはそう書いてあります** |

## 必要なもの

- MoonBit ツールチェーン(`moon` 0.1.20260915 以降)
- TypeSafe AI の API キー(早期アクセス)

## セットアップ

```bash
export TYPESAFEAI_API_KEY=your_key_here
moon update   # 依存(tapi: moonbitlang/async, moonbitlang/x, mizchi/image, WGYo90/moonbit-gif)を取得
```

API キーはソースコードに書かず、環境変数 `TYPESAFEAI_API_KEY` か各 CLI の `--api-key` で渡します。

## 1. モデル一覧を確認

```bash
moon run --target native cmd/jev -- --models
# [{"name":"jev-latest",...},{"name":"jev-preview",...}]
```

## 2. 単発質問(コマンド/コマンドライン)

デモ(3 種の質問 — score / choice / noul — を 1 リクエストで並列評価):

```bash
moon run --target native cmd/jev -- --pretty
```

state を直接指定(テキスト or JSON 文字列):

```bash
moon run --target native cmd/jev -- --state "This email is a phishing attempt" --pretty
moon run --target native cmd/jev -- --state '{"amount": 299, "currency": "USD"}' --pretty
```

state と質問をファイルから:

```bash
moon run --target native cmd/jev -- --state-file state.json --questions-file questions.json
```

`questions.json` の形式(noul / choice / score を混在可能):

```json
{
  "is_spam": {
    "type": "noul",
    "instructions": "This message is spam.",
    "criteria": {
      "true": "Unsolicited advertising",
      "false": "A legitimate conversation"
    }
  },
  "tone": {
    "type": "choice",
    "instructions": "What is the tone of this message?",
    "criteria": {
      "polite": "Friendly and courteous",
      "neutral": "Calm and factual",
      "frustrated": "Angry or upset"
    }
  },
  "handler": {
    "type": "choice",
    "instructions": "Which handler owns this? (選択肢名だけで解釈させる形)",
    "criteria": { "billing": null, "technical": null, "sales": null }
  },
  "urgency": {
    "type": "score",
    "instructions": "How urgent is this request?",
    "criteria": ["Can wait", "Needs attention this week", "Needs attention today"]
  }
}
```

オプション: `--model`(既定 `jev-latest`)、`--base-url`、`--pretty`、`--api-key`

## 3. Jev vs Jev 五目並べ

```bash
moon run --target native cmd/gomoku --                     # 15x15 で 1 局
moon run --target native cmd/gomoku -- --board 9 --games 2 --verbose
moon run --target native cmd/gomoku -- \
  --player1 jev-latest --player2 jev-preview --board 15    # モデルを分けて対戦
```

毎手、盤面を state に、着手候補(石の近傍セル)を choice 質問の criteria として Jev に問い、
`WINS` / `BLOCK` / ライン長(`3o` = 3 連・片端オープン)のヒント付きで最良手を選ばせます。
API 失敗・不正手のときだけ組み込みフォールバック(勝ち手 > ブロック > 中央)を使います(統計に `fallback moves` と表示)。

主要オプション: `--board N`(1..15 推奨)、`--games N`、`--player1/--player2 <model>`、
`--verbose`(毎手の盤面表示)、`--log-path <file>`(対局ログの JSONL を出力)

## 4. 対局を実時間 GIF 化

```bash
# 1. 対局をログ付きで実行(各手の実測ミリ秒を記録)
moon run --target native cmd/gomoku -- --board 15 --log-path game15.jsonl

# 2. ログから GIF を生成(フレーム遅延 = その手の実測時間 → 実時間再生)
moon run --target native cmd/gomoku_gif -- --log game15.jsonl --out gomoku.gif
```

生成例: [gomoku.gif](gomoku.gif)(362x362 / 26 フレーム / 約 47KB、再生総時間 ≈ 対局の実測時間)。

`gomoku_gif` のオプション: `--scale`(セル辺長 px)、`--padding`、`--hold-cs`(最終フレーム表示、1/100 秒)、
`--max-cs`(フレーム遅延の上限)、`--loop` は未対応(GIF は常にループ再生)。

## 5. 五目並べ以外のパターン(実測レポートは docs/)

どの問題形状が Jev に向いているかを実 API で測った結果は [`docs/`](docs/) にあります。
各レポートは生の数値と再現コマンド付きです。

| # | 内容 |
| --- | --- |
| [practice](docs/practice.md) | **実践ガイド** — 使うときに順番に決めること |
| [findings](docs/findings.md) | **実験ごとに何がわかったか** |
| [summary](docs/summary.md) | やったこと / わかったことの要約 |
| [00](docs/00-api-notes.md) | API の実挙動(スキーマに書かれていない上限・挙動、公式パターン集の実測) |
| [01](docs/01-shell-risk.md) | シェルコマンドの危険度判定 — エージェントの実行許可ゲート |
| [02](docs/02-moba.md) | ヘッドレス 3v3 MOBA(視界と戦場の霧)を Jev にチーム操作させる |
| [03](docs/03-chess.md) | チェス、Jev vs Claude Sonnet 5 |
| [04](docs/04-agent-built-prompts.md) | エージェントに質問を設計させて動的にパイプラインを組む |
| [05](docs/05-browser-chaos.md) | [chaosbringer](https://github.com/mizchi/chaosbringer) の次操作選択を Jev に |
| [06](docs/06-ideas.md) | 次に効きそうなことの提案(優先順位つき) |
| [16](docs/16-eslint-oracle.md) | コードと ESLint ルールの評価基準だけ渡し、実装を伏せて合否を当てさせる |
| [17](docs/17-task-picker.md) | タスクランナーの大量のタスクから正しいものを選べるか |
| [18](docs/18-permission-hook.md) | Claude Code の `PreToolUse` hook にして、Bash の実行許可をゲートする |
| [19](docs/19-jevlang.md) | jevlang — 条件が Jev の判断である小さな言語を 2 実装で作る |
| [20](docs/20-jevdsl.md) | jevdsl — MoonBit から `match` できる薄いラッパー(設計ノート) |
| [21](docs/21-eslint-plugin-jev.md) | eslint-plugin-jev — 判定を Jev がやる ESLint プラグイン(関数ごとの score) |
| [22](docs/22-code-criteria.md) | 具体的な「良いコード」の指標を名前で聞くと何が変わるか + 列挙の穴の深さ |
| [23](docs/23-task-filter.md) | タスク/テストランナーの filter — グラフが「走れるもの」、Jev が「走るべきもの」 |
| [24](docs/24-adhoc-rules.md) | まだ存在しないルールを自然言語で書く — セレクタだけコードで書き、述語は 1 文 |
| [56](docs/56-moba5.md) | **本格的な 5v5 MOBA と採点できるベンチマーク** — 試合は 6-0 で勝つが、16 局面のうち 13 で「勝てない」と答えて「殴れ」と答える(**その 13 は周辺度数が強制していて、内訳の割合は私の説明文の関数だった**) |

(索引の全文は [docs/README.md](docs/README.md) にあります。)

一行でまとめると、**一番効いたのは「答えの形を問題の形に合わせる」こと**でした
(順序のある結論を `choice` から `score` に変えるだけで正解率 19/24 → 23/24)。
[まとめ表](docs/README.md#効いたパターン要約)に効果と落とし穴を並べてあります。

実行:

```bash
moon run --target native cmd/patterns --                   # 公式パターン集の実測
moon run --target native cmd/shellrisk --                  # シェルコマンド判定
moon run --target native cmd/moba -- --a jev --b scripted   # 3v3 MOBA
moon run --target native cmd/moba5 -- --bench --dry         # 5v5 の採点表と床(API 不要)
moon run --target native cmd/moba5 -- --bench --repeat 5     # 5v5 を 124 問 × 5 回で採点
moon run --target native cmd/moba5 -- --a jev --b smart     # 5v5 MOBA
```

TypeScript / JS 側の実験(チェス・ブラウザ探索・エージェント生成・ESLint 合否予測・
ESLint プラグイン)は [`experiments/`](experiments/) 以下で、
各ディレクトリで `npm install` してから走ります。

```bash
cd experiments/eslint-oracle && npm install
npx tsx src/truth.ts                                 # ESLint の正解ラベルだけ(API 不要)
npx tsx src/run.ts --repeat 5                         # 実装を伏せて合否を当てさせる(要 API)

cd experiments/task-picker && npm install
npx tsx src/run.ts --repeat 3 --scale                 # 133 タスクから正しいものを選ばせる
```

## 6. eslint-plugin-jev — 判定を Jev がやる ESLint プラグイン

`experiments/eslint-plugin-jev` は**本物の ESLint プラグイン**で、ルールは 2 つです。

| ルール | 書くもの | 判定対象 |
| --- | --- | --- |
| `jev/quality` | なし | 全関数を固定の質問セット + 8 指標で |
| `jev/rule` | **セレクタと 1 文** | セレクタに当たったノードを、その文で |

`jev/quality` は関数ごとに「レビューでどれだけ押し返すか」を `score` で出し、
**ファイル 1 個ぶんの全関数を 1 リクエストで**聞きます(依存ゼロ、ビルド不要)。

```
  1:8  warning  Jev thinks `compareTokens` does the wrong thing for some realistic
                input (misbehaves 0.71 (fires at 0.70); reviewer action 1.94/3)   jev/quality
```

```bash
cd experiments/eslint-plugin-jev && npm install
npm test                                    # 105 件、API 不要
npm run truth                               # ラベルをコード実行で検証、API 不要
npm run replay                              # 記録から全数値を再計算、API 不要
npm run rules                               # jev/rule の記録済み判定、API 不要

TYPESAFEAI_API_KEY=... npm run warm         # jev/quality: 78 関数を 15 リクエスト、$0.001
TYPESAFEAI_API_KEY=... npm run warm:rules   # jev/rule: 49 ノードを 12 リクエスト、$0.001
TYPESAFEAI_API_KEY=... npm run lint         # eslint が Jev の判定を読む(両ルール)
```

**ESLint のルールは同期関数で `await` できない**のが本題です。判定を事前に
バッチで済ませてキャッシュに置き、ルールはハッシュを引くだけにすることで
**lint 時間は何もしない lint と誤差の範囲**(31 ms 対 36 ms)に収まります。
`onMiss: "ask"` を選べばルールの中で同期リクエストもできますが 1 ファイル 361 ms。

実測は **自信のある指摘の 15/15 が本物のバグ・誤検出 0、ただし 12 バグ中 5 個しか
捕まえない**(関数 1 個 $0.000017)。捕まえるのは**契約の齟齬**、落とすのは
**特定の API の誤用**でした。→ [docs/21](docs/21-eslint-plugin-jev.md)

`--rubric full` にすると **8 つの具体的な欠陥クラスを名前で**聞きます
(関数ごとに 10 問、それでも 1 ファイル 1 リクエスト)。捕まる数が 33/51 → 41/51 に増え、
指摘が名前で返ります:

```
  5:8  warning  `applyDiscount` matches the review criterion `unit_or_arithmetic` (0.94, its cutoff is 0.28)
 13:8  warning  `increment` matches the review criterion `lost_update` (0.93, its cutoff is 0.73)
```

ただし**名前を付けても戻ったのは見逃し 6 個のうち 2 個**で、
一番効いたのは指標ではなく**指標ごとに閾値を引くこと**でした
(共通閾値 0.80 で 13/36、質問ごとなら 24/36)。

指標が効くのは**見えにくいバグでだけ**です。関数の中だけ読めば分かるバグは
naming の有無にかかわらず 15/15 で、**特定の API の挙動を知らないと見えない**バグで
14% → 52% になります。そして **8 指標は重複していて、抜いて本当に困るのは 1 個だけ**
(`api_default`、9/12 → 4/12)。→ [docs/22](docs/22-code-criteria.md)

### `jev/rule` — まだ存在しないルールを自然言語で書く

**セレクタだけコードで書き、述語は 1 文で書きます。**
`CallExpression[callee.name='fetch']` は 10 秒で書けて、「ただしリトライ
ラッパの内側で既にタイムアウトが設定されている場合を除く」は 1 週間かかる —
チームの規約が lint ルールにならない理由はいつもこれです。

```js
"jev/rule": ["warn", { rules: [{
  id: "fetch-timeout",
  selector: "CallExpression[callee.name='fetch']",
  rule: "fetch は必ずタイムアウト (AbortSignal.timeout など) を渡すこと",
  note: "リトライラッパの内側で既に設定されている場合は違反ではない",
}] }],
```

当たったノードごとに `score` を付け、**1 リクエストに最大 256 件**まで詰めます
(実際にはファイル単位のまとまりの方が先に効きます)。**セレクタはわざと
広く書く**のが正解で、`score` の 0 は「セレクタが余計なものを拾った」を意味します。

コーパスで 5 ルール・49 ノードを 12 リクエスト・**$0.0011** で判定して、
**7 件の指摘。うち自信のある 5 件は 5/5 が本物のバグ**でした。外した 1 件は
意図的に catch している関数で、**confidence 0.31 なので「指摘」ではなく
「質問」として出ました**。

効くかどうかを読むのは閾値ではなく **gap**(違反と残りの点数差)です:

```
rule                        cutoff  matches  reported  widest gap  cutoff in gap
no-string-built-query         2.50       20         2        1.82  yes
atomic-read-modify-write      2.00        7         1        1.79  yes
no-stringly-arithmetic        2.00       14         1        2.16  yes
no-swallowed-catch            1.50        4         2        0.77  yes
```

gap が広ければ閾値はどこに置いても同じ答えになり、**gap が狭いのは閾値の問題
ではなく文の問題**です。実際 5 ルール中 2 つは最初の文が失敗(gap 0.16 と 0.28)し、
文を書き直して 2.16 と 0.77 になりました。閾値は質問に入らないので、
`at` を変えても再質問はゼロです。

一方、**セレクタは静かに失敗します**。当たらなかったノードはどの閾値でも
質問されず、レポートにも出ません(コーパスのバグ 1 件をこれで落としました)。

実測と、gap をどう読むかは → [docs/23](docs/24-adhoc-rules.md)

プラグインとしての使い方(flat config、オプション全表、warm パスの CLI、閾値の
チューニング、ルールの書き方、限界)は
[experiments/eslint-plugin-jev/README.md](experiments/eslint-plugin-jev/README.md)。

## 7. Claude Code の permission hook

`hooks/jev-permission-gate.mjs` は、Bash コマンドの実行許可を Jev に判定させる
`PreToolUse` hook です(**依存ゼロの Node スクリプト 1 枚、ビルド不要**)。
既定では `ask` / `deny` しか返さず、安全と判定したときは何も出さないので、
**あなた自身の permission ルールを上書きしません**。

```bash
node hooks/test-gate.mjs --failsafe-only   # 7 つの失敗経路だけ確認(API キー不要)
node hooks/test-gate.mjs --policy-logic    # .jev ポリシーの規則を検証(API キー不要)
TYPESAFEAI_API_KEY=... node hooks/test-gate.mjs   # docs/01 の 24 コマンドで採点
```

有効化は `hooks/settings.example.json` の `hooks` ブロックを `.claude/settings.json` に
コピーします(閾値と文脈は `hooks/jev-gate.json.example` 参照)。
**このリポジトリでは意図的に配線していません** —— チェックアウトした人全員の
Bash がゲートされてしまうので。実測値と設計の理由は [docs/18](docs/18-permission-hook.md)。

**同じ判断を Pi の拡張として動かす部品は [`pi/`](pi/) です**(§11)——
Pi の `tool_call` は `ask` を返せないので、`ask` の解決の仕方だけが違います。

## 8. jevdsl — 判断を `match` できる値にする

`lib` は API をそのまま写した生クライアントです。`jevdsl` は判断を
**`(result, confidence)` のタプル**にして、MoonBit の `match` に直接載せます。

```moonbit
let jev = @jevdsl.session(client, state)

match jev.noul("家に牛乳がない") {
  (true, c) if c > 0.5 => buy("牛乳")
  (true, _) => ask_the_user()
  (false, _) => ()
}

match jev.choice("100円余ったときに買うもの", ["プリン", "ビール"]) {
  (pick, c) if c > 0.5 => buy(pick)
  (_, _) => ()
}

match jev.score("急ぎ度", ["待てる", "今日", "今すぐ"]) {
  (s, c) if s >= 1.5 && c > 0.5 => go_now()
  (s, _) if s >= 0.5 => go_today()
  (_, _) => ()
}
```

3 種すべて同じ形なので、guard に閾値を書けます。
`noul` は API が confidence を返さないので**コイン投げからの距離**
(`|p - 0.5| * 2`)を confidence にしています(生の確率は `probability()`)。

```bash
moon run --target native cmd/jevdsl --              # 1 判断 1 リクエスト(3 req / 1069 tok)
moon run --target native cmd/jevdsl -- --bundled    # 3 判断を 1 リクエスト(1 req / 435 tok)
moon test --target native -p jevdsl                 # 10 件(API 不要)
```

**複数の判断があるなら `Session::ask` で束ねてください**(アクセサは同じ)。
設計の理由と限界は [docs/20](docs/20-jevdsl.md)。

## 9. jevlang — 条件が Jev の判断である小さな言語

`if` の条件や `match` の対象が**自然文の確率判断**である DSL です。
**JS 版**(`jevlang-js/`)と **MoonBit 版**(`jevlang/` + `cmd/jevlang`)の 2 実装があり、
同じ `.jev` を走らせて結果が一致することをテストしています。

```jev
state { fridge: ["卵", "ビール"], wallet_yen: 100 }

threshold noul = 0.5

if noul("家に牛乳がない") {
  buy("牛乳")
}

let result = match choice("100円余ったときに買うもの", ["プリン", "ビール", "うまい棒"]) {
  "プリン" => buy("プリン")
  "ビール" => buy("ビール")
  "うまい棒" => buy("うまい棒")
  else => buy("牛乳")          # else 腕は gate noul を別の質問として生やす
}

let praised = score("${result} を買ったことで妻に褒められる確率", [
  "褒められない", "何も言われない", "褒められる",
])
```

```bash
node jevlang-js/bin/jevlang.mjs examples/milk.jev           # JS 版
moon run --target native cmd/jevlang -- examples/milk.jev   # MoonBit 版

node jevlang-js/test.mjs                 # 24 件(API 不要)
moon test --target native -p jevlang     # 31 件(API 不要)
scripts/jevlang-conformance.sh           # 2 実装の一致(API 不要)
```

`hooks/policy.jev` は、[7 節](#7-claude-code-の-permission-hook)の hook の判定を
この言語で書いたものです(`--policy` で差し替えられます)。

**質問文が実行前に確定している judgment は 1 リクエストに巻き上げられます**
(`examples/milk.jev` で 4 → 2 リクエスト、1501 → 867 トークン)。
`"${result}"` のように実行時の値に依存する質問だけが後から個別に聞かれます。
設計の理由と実測は [docs/19](docs/19-jevlang.md)。

## 10. タスク/テストランナーの filter

`just` で**依存グラフを先に作っておき**、今の diff を state に、
**ゴールタスク 1 つにつき `score` 1 問**を 1 リクエストで投げて、
閾値で切った集合を走らせます。前提と順序は**グラフの閉包**が足すので、
`e2e-auth` を選べば `build-web` は自動で付いてきます(Jev は依存関係を知らなくていい)。

```bash
cd experiments/task-filter && npm install
npm test                                            # 28 件(API 不要・just 不要)
TYPESAFEAI_API_KEY=... npx tsx src/cli.ts --base main   # 手元の diff を採点して `just ...` を出す
TYPESAFEAI_API_KEY=... npx tsx src/run.ts --repeat 3    # 20 ブランチのコーパスで実測
npx tsx src/run.ts --replay out/raw.jsonl           # 収集済みの行を再集計(API 不要)
```

```
   score  conf   cost  task
    1.71  0.56     4s  RUN  fmt-check
    1.68  0.52     6s  RUN  docs-links
    0.05  0.93    22s  skip typecheck-web
    0.02  0.96   320s  skip e2e-web

  p(this change alters behaviour) 0.63   p(nothing needs running) 0.18
  5 of 26 tasks: 1.7m machine / 1.1m wall  (everything: 18.5m / 7.2m, 91% saved)

  just fmt-check docs-links docs-build lint
```

合成した monorepo での実測は [docs/23](docs/23-task-filter.md):
**検出 15/15 を保ったまま machine time 68.6%**(閾値 1.25 で 75.8%)削減、
1 ブランチ **0.17 秒・$0.000131**。静的な affected 判定は 30.9% しか削れず、
glob だけにすると **14/15 に取りこぼします**。
[17](docs/17-task-picker.md) との一番の違いは**ゴール文を渡さないこと**で、
その条件だと [17 §5](docs/17-task-picker.md#5-リポジトリの文脈は要らなかった) の
「文脈は払い損」が**反転します**([docs/23 §4](docs/23-task-filter.md#4-文脈は効いた--17-との違いは意図が書かれているかどうか))。

**このリポジトリ自身でも測りました**([docs/23 §12](docs/23-task-filter.md#12-追記--このリポジトリ自身で正解ラベルを実測した))。
根の [`justfile`](justfile) がこのリポジトリのチェックをタスクグラフにしていて、
**15 個の実編集を適用して 20 レシピ全部を走らせ、終了コードを正解ラベルにしています**
(規則ではなく実測)。結論は 2 つ反転しました:

- 検出は **18/18(見逃し 0)**。ただし**このリポジトリでは glob だけの無料の静的判定に負ける**
  (80.2% 対 65.9%)—— 差はモデルではなく**グラフの扇形**で、
  共有パッケージから下流に伝播する形でないと静的解析は悲観的になりません
- **15 個のうち 9 個は何も壊しません。** 2 実装の丸めの食い違い(コメントが警告している箇所)も
  `max_choices = 255` も誰も固定していない —— フィルタの精度ではなく
  **スイートの穴**が出ました
- 効いたのは **doc コメント 1 行**。「何をするか」を「何を守るか」に書き直すだけで
  削減 53.3% → 65.9%(過剰選択 31/45 → 18/45)

## 11. pi エージェントとして動かす —— [`pi/`](pi/)

§7 は Claude Code の hook でした。**同じ判断を [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
の拡張として動かす部品は [`pi/`](pi/) にまとめてあります。**
`packages/jev-<name>/src/pi.ts` の 6 つがその実体で、
**`pi/` はそれを「1 コマンドで入る 1 つのもの」に組み立てたもの**です。

```bash
cd pi && npm install     # 6 パッケージをローカルから symlink(コピーではない)
npm run probe            # どの拡張がどの seam を取るか、実測。API キー不要
npm test                 # 12 件。API キー不要
npm run collide          # 両方入れたら何が 2 回走るか、Pi のランナーで実測
npm run load             # Pi 自身の resolver に読ませる(6 パッケージ + 2 プロファイル)
pi install ./pi/components   # 5 つを別々に
pi install ./pi/resident     # または jev-hermes 1 つ(同じ 5 つを内包)。両方は不可
pi install ./packages/jev-guard   # 1 つだけ入れることもできる
```

**2 つのプロファイルは排他です** —— `jev-hermes` は guard も自前で持つので
`resident` は `components` の代替です。両方入れると 5 seam 全部で衝突し、
**`ask` に落ちたコマンドはユーザに確認ダイアログを 2 回出します**
(`npm run collide` が Pi のランナーで実測。**block されるコマンドは
最初の gate で短絡して 1 回**、削除も 1 回 —— 2 倍になるのは ask だけでした)。

そして **npm 上の `jev-guard` / `jev-model-router` / `jev-compact` は別人のパッケージ**です
(残り 4 つは 404 —— このリポジトリのものは未公開)。
だから**入れ方はローカルパスだけ**で、`pi/` の依存も**すべて `file:` パス**、
バージョン範囲を書くと**テストが落ちます**。
6 つのパッケージ README のレシピもそれに合わせて直してあり、
**コードブロックに `npm:<このリポジトリの名前>` が現れたらテストが落ちます**。
詳細は [`pi/README.md`](pi/README.md)。

## 12. 5v5 MOBA と採点できるベンチマーク —— [`moba5/`](moba5/)

§5 の [02](docs/02-moba.md) は 3v3 で、**測れるものが勝敗しかありませんでした**。
[`moba5/`](moba5/) はそれを**ジャンルが実際に遊ばれているサイズと機構**まで広げた
別パッケージで、**3v3 側(`moba/`, `cmd/moba`)は 1 行も変えていません**。

```bash
moon run --target native cmd/moba5 -- --bench --dry        # 採点表と床(API キー不要)
moon run --target native cmd/moba5 -- --bench --repeat 5   # 同じ 124 問を 5 回、採点
moon run --target native cmd/moba5 -- --arena              # 5v5 集団戦の総当たり(API 不要)
moon run --target native cmd/moba5 -- --tournament         # 全試合の総当たり(API 不要)
moon run --target native cmd/moba5 -- --draft              # 生のステータスから編成を選ばせる
moon run --target native cmd/moba5 -- --a jev --b smart --games 2 --max-ticks 30
moon run --target native cmd/moba5 -- --a jev --b smart --verbose --replay r.jsonl
moon test --target native -p moba5                         # 45 件。API キー不要
```

増えた機構は**どれも判断を 1 つ作るために**入れてあります ——
3 レーン + 両サイドのジャングル + 川(23 ノード)、レベルと経験値、
アイテム 5 種(装備枠 3)、クールダウン付きの固有スキル、
**相手の 1 ターンを消すスタン**、遠距離の `poke`、
ドラゴン(永続)とバロン(短時間・強)、ミニオンの押し合い、ワード、2 段のタワー。

構造として一番効いているのは 1 行の規則です:

> **自陣のウェーブが居るレーンのタワーは、その champion を撃たない**(撃つ対象がミニオンになる)。

これで「タワーに単騎で立つ」は必ず負ける取引になり、
**`Farm` でウェーブを押してから殴る**が正しい手順になります。
ミニオンは**タワーしか割れない**ので、試合を終わらせるのは必ず champion です。

**`--bench` が本題です。** 31 シナリオに 124 問、**答えは全部シミュレータが出します** ——
ルールが決定的なので「この集団戦は勝てるか」は**再生すれば分かる**。
正解の出し方は `rules`(再生した)/ `arith`(ルールの算術)/ `score`(明示した目的関数)の
3 段階に分けて**問ごとに明記**し、**同点は両方正解**にします。
**`--repeat N` で同じ問いを N 回**聞き(1 回では差と引き分けが区別できないので)、
そして**出力に 2 本の基準線を並べます** ——
**床**(状態を読む手書きヒューリスティック)と
**`const`**(そのクラスで一番多い正解を機械的に答えたときの点)。

実測(`jev-latest`、2026-09、詳細は [56](docs/56-moba5.md)):

| | 結果 |
| --- | --- |
| 試合(両サイド × 2 種の bot、各 2 戦) | **6-0**、6 試合すべて自陣の構造物は満額 |
| 1 リクエストが決めたキャラ行動 | **4.86**(3v3 は 2.76)、**52 ms/体**(3v3 は 76) |
| 不正な手 | **874 判断で 0 件** |
| **124 問 × 5 回の採点** | **0.48**(class mean 0.51)対 床 **0.51**(同 0.55) |
| **ゴム印より明確に上のクラス** | **10 のうち 1 つ**(`lane` 1.00 対 const 0.71) |
| **ゴム印より下のクラス** | **3 つ**(`focus` 0.26 / `retreat` 0.41 / `item` 0.17) |
| 自己一致 | **109/124** |
| 戦場の霧の読み(23 択) | **139 tick で 14 正解 = 0.10**、相手次第で **0.02〜0.36** |

**そして一番はっきり出たのは正解率ではなく整合性でした** ——
**16 局面のうち 13 で、「この集団戦は勝てない」と答えた直後に
「いま殴れ」と答えています。** 同じ state・同じリクエスト・同じノードについて。
**2 つの問いを同じリクエストに入れていなければ見えません** ——
[02](docs/02-moba.md) が効率の話として始めた fan-out が、そのまま矛盾の検出器でした。

**ただし数えたら、その 13 は最初から情報を持っていませんでした** ——
`false` 14/16 と `fight_now` 15/16 から **14 + 15 − 16 = 13** が強制されるので、
**共起が周辺度数の下限に等しいとき、それは 2 つのゴム印の言い換え**です。
**読めるのは真値との比較**で、ルールが両立を許すのは 4 局面
(下限 0・上限 7 の内側なので**そちらは情報を持っている**)——
**13 組のうち少なくとも 9 組は間違い**(符号検定 p = 0.004〜0.012)、
**ただしどちらの問いの答えが間違っているかは、この数字は言いません。**
`fight` の閾値を「outright に勝つ」から「体の交換で負けない」に緩めても
**ゴム印に対する差は両方 +2** で、**逃げ道はその方向には無い**
(`--coherence`、API 不要)。

**そして 2 択を 3 択に割ったら、答えは「どちらか」ではなく割合になりました。**
`fight_now` を「勝つから殴る」/「勝てないが殴る価値がある」に分けて
**同じ 16 局面を同じ run の中で両方の文言で**聞くと(オラクルは同一):
**周辺度数は動かない**のに、
**「勝てない」と言って殴った 41 局面のうち 30(73%)が中央を選び**、
**残り 27% は同じリクエストで「勝つから殴る」**と答えました。
**ただし正解率は 0.50 → 0.29 に下がりました** ——
**articulate になったことと正確になったことは別**です。

**そしてその 27% も撤回になりました。** 同じ 3 択を
**4 通りの説明文**で聞き直すと(選択肢名・オラクル・truth・他の問いは全部同じ、
動かしたのは説明文と 1 本だけ並び順)、中央の割合は
**56% / 59% / 74% / 100%** に動きます ——
**1 つの文言では矛盾が 48 答え中 0 件**、別の文言では **44%**、
**並び順だけでも 74% → 59%**(文は 1 字も変えていない)。
**「モデルが矛盾しているか、私の選択肢が粗いか」の割合そのものが、
私の 3 文の関数**でした。
**文言を 6 通り変えて動かなかったのは周辺度数だけ**です。

> **このレポートは 2 度書き直しています。**
> 1 度目は `--repeat` が無く、22 問を 1 回ずつ測って
> 「calibration の向きが反転する」を所見にしていました(**標本の小ささの産物**)。
> 2 度目は `fight` クラスが偏っていました ——
> **8 問中 7 問が「体の数が多い側が勝つ」**で、床の 0.88 はほぼそれだけ。
> いまは **540 通りを再生して 4 つのバケツに分け、同数取って
> 「体を数える戦略が正確に 0.50」**にしてあります(テストで等式として固定)。
> **そして `const` 列を足した瞬間に `retreat` も 0.83 で引っかかりました。**

## 補足

- **料金**(2026-09 時点): 入力トークン `$0.042 / MTok`、出力トークン無料。15×15 の五目並べ 1 局で入力約 5.8 万トークン(≈ $0.0024)程度。5v5 MOBA は 30 tick の 1 試合で入力約 20 万トークン(≈ $0.008)、`--bench --repeat 5` は 155 リクエストで約 77 万トークン(≈ $0.032)。
- Jev の応答は毎回 1 回の `POST /v1/systemone`(約 0.5 秒/手)。
- GIF エンジン(`WGYo90/moonbit-gif`)はバリデータ上は有効な GIF を出力しますが、**同エンジンのデコーダーは自分の出力を再デコードできません**(標準のブラウザ/ビューアでは再生可能)。
- 参考: Jev に関する解説は [Introducing System One Models & Jev(TypeSafe AI ブログ)](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、API 仕様は [docs.typesafe.ai](https://docs.typesafe.ai/introduction) と `https://api.typesafe.ai/openapi.json`。