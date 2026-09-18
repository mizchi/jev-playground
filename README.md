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
| `experiments/` | TypeScript 側の実験(チェス・ブラウザ探索・エージェント生成プロンプト) |

**どのパターンが優位かの実測レポートは [`docs/`](docs/) にあります**
([まとめと優先順位](docs/README.md))。

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
| [00](docs/00-api-notes.md) | API の実挙動(スキーマに書かれていない上限・挙動、公式パターン集の実測) |
| [01](docs/01-shell-risk.md) | シェルコマンドの危険度判定 — エージェントの実行許可ゲート |
| [02](docs/02-moba.md) | ヘッドレス 3v3 MOBA(視界と戦場の霧)を Jev にチーム操作させる |
| [03](docs/03-chess.md) | チェス、Jev vs Claude Sonnet 5 |
| [04](docs/04-agent-built-prompts.md) | エージェントに質問を設計させて動的にパイプラインを組む |
| [05](docs/05-browser-chaos.md) | [chaosbringer](https://github.com/mizchi/chaosbringer) の次操作選択を Jev に |
| [06](docs/06-ideas.md) | 次に効きそうなことの提案(優先順位つき) |

一行でまとめると、**一番効いたのは「答えの形を問題の形に合わせる」こと**でした
(順序のある結論を `choice` から `score` に変えるだけで正解率 19/24 → 23/24)。
[まとめ表](docs/README.md#効いたパターン要約)に効果と落とし穴を並べてあります。

実行:

```bash
moon run --target native cmd/patterns --                   # 公式パターン集の実測
moon run --target native cmd/shellrisk --                  # シェルコマンド判定
moon run --target native cmd/moba -- --a jev --b scripted   # 3v3 MOBA
```

TypeScript 側の実験(チェス・ブラウザ探索・エージェント生成)は
[`experiments/`](experiments/) 以下で、各ディレクトリで `npm install` してから走ります。

## 補足

- **料金**(2026-09 時点): 入力トークン `$0.042 / MTok`、出力トークン無料。15×15 の五目並べ 1 局で入力約 5.8 万トークン(≈ $0.0024)程度。
- Jev の応答は毎回 1 回の `POST /v1/systemone`(約 0.5 秒/手)。
- GIF エンジン(`WGYo90/moonbit-gif`)はバリデータ上は有効な GIF を出力しますが、**同エンジンのデコーダーは自分の出力を再デコードできません**(標準のブラウザ/ビューアでは再生可能)。
- 参考: Jev に関する解説は [Introducing System One Models & Jev(TypeSafe AI ブログ)](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、API 仕様は [docs.typesafe.ai](https://docs.typesafe.ai/introduction) と `https://api.typesafe.ai/openapi.json`。