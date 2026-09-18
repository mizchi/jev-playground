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
読む順に 3 つの入口があります:

| | 何が書いてあるか |
| --- | --- |
| [**docs/practice.md**](docs/practice.md) | **Jev を使うときに順番に決めること**(手順書・やってはいけないこと一覧) |
| [**docs/findings.md**](docs/findings.md) | **実験ごとに何がわかったか**(1 本 = 1 ブロック) |
| [**docs/summary.md**](docs/summary.md) | やったこと / わかったことの端的な要約 |

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

一行でまとめると、**一番効いたのは「答えの形を問題の形に合わせる」こと**でした
(順序のある結論を `choice` から `score` に変えるだけで正解率 19/24 → 23/24)。
[まとめ表](docs/README.md#効いたパターン要約)に効果と落とし穴を並べてあります。

実行:

```bash
moon run --target native cmd/patterns --                   # 公式パターン集の実測
moon run --target native cmd/shellrisk --                  # シェルコマンド判定
moon run --target native cmd/moba -- --a jev --b scripted   # 3v3 MOBA
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
  (82.2% 対 68.4%)—— 差はモデルではなく**グラフの扇形**で、
  共有パッケージから下流に伝播する形でないと静的解析は悲観的になりません
- **15 個のうち 9 個は何も壊しません。** 2 実装の丸めの食い違い(コメントが警告している箇所)も
  `max_choices = 255` も誰も固定していない —— フィルタの精度ではなく
  **スイートの穴**が出ました
- 効いたのは **doc コメント 1 行**。「何をするか」を「何を守るか」に書き直すだけで
  削減 52.6% → 68.4%(過剰選択 33/45 → 17/45)

## 補足

- **料金**(2026-09 時点): 入力トークン `$0.042 / MTok`、出力トークン無料。15×15 の五目並べ 1 局で入力約 5.8 万トークン(≈ $0.0024)程度。
- Jev の応答は毎回 1 回の `POST /v1/systemone`(約 0.5 秒/手)。
- GIF エンジン(`WGYo90/moonbit-gif`)はバリデータ上は有効な GIF を出力しますが、**同エンジンのデコーダーは自分の出力を再デコードできません**(標準のブラウザ/ビューアでは再生可能)。
- 参考: Jev に関する解説は [Introducing System One Models & Jev(TypeSafe AI ブログ)](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、API 仕様は [docs.typesafe.ai](https://docs.typesafe.ai/introduction) と `https://api.typesafe.ai/openapi.json`。