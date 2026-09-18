# Jev research notes

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)(TypeSafe AI の System One モデル)で
**どの問題形状が優位か**を実測して記録する場所です。各レポートは実 API を叩いた生の数値を含み、
再現用の CLI が付いています。

> 対象は `jev-latest`(応答は `jev-1.13.0`)、実測は 2026-09。
> 料金は入力 `$0.042 / MTok`・出力無料なので、ここの実験はどれも 1 回数セント未満です。

## 走らせ方

```bash
export TYPESAFEAI_API_KEY=your_key_here
moon run --target native cmd/patterns --                       # 00: 公式パターン集の実測
moon run --target native cmd/shellrisk --                      # 01: シェルコマンド判定
moon run --target native cmd/moba -- --a jev --b scripted      # 02: 3v3 MOBA
cd experiments/chess          && npm i && npx tsx src/run.ts   # 03: チェス vs Sonnet 5
cd experiments/agent-questions && npm i && npx tsx src/run.ts  # 04: エージェントに質問を書かせる
cd experiments/browser-chaos  && npm i && npx tsx src/run-spa.ts # 05: ブラウザ探索
python3 -m http.server -d web 8000                             # 11: リプレイを Web 再生 → :8000/replay.html
```

MoonBit 側(`lib/` `report/` `moba/` `cmd/*`)と TypeScript 側(`experiments/*`)に
分かれていて、TS 側は `experiments/shared/jev.ts` が `lib/` と同じ役割です。

## 効いたパターン(要約)

| パターン | 効果 | 出典 | 実測 |
| --- | --- | --- | --- |
| **順序のある結論は `score`、`choice` は使わない** | **正解率 19/24 → 23/24。** 質問の形を変えるだけ | 本リポジトリ | [01](01-shell-risk.md#3-順序のある結論は-score-で聞く) |
| **質問のバンドル**(speculative fan-out) | **21x 速く 8x 安く、答えは動かない**(平均差 0.011) | [docs](https://docs.typesafe.ai/patterns) | [00](00-api-notes.md#speculative-fan-out) |
| **state に構造化コンテキストを載せる** | 文字列では区別できない判断ができる | [schema](https://api.typesafe.ai/openapi.json) | [01](01-shell-risk.md#2-同じコマンドでも文脈で判断が変わる) |
| **逃げ道の選択肢 / スコープ gate** | 範囲外入力の「自信のある誤答」を塞ぐ | 本リポジトリ | [00](00-api-notes.md#closed-world) |
| **選択肢名だけの choice** | 説明文のトークンを払わずに広いメニュー(20 択で 441 tok) | [schema](https://api.typesafe.ai/openapi.json) | [00](00-api-notes.md#name-only) |
| **原子質問 + コード側合成** | 監査ログには効く。正解率への上乗せは限定的 | [docs](https://docs.typesafe.ai/patterns) | [01](01-shell-risk.md#4-分解は万能ではない) |
| **繰り返させたくない選択はコードで消す** | 言葉で禁止するより安く確実 | 本リポジトリ | [05](05-browser-chaos.md#変化-2--3-選択肢から消すほうが言葉で言うより効く) |
| **幅はランダム、深さは Jev** | 置き換えではなく併用。8 手深いゴール到達 0/3 → 3/3 | 本リポジトリ | [05](05-browser-chaos.md#1-結果) |
| **共有 state + 複数エージェント = fan-out の理想形** | 3 キャラの判断が 1 リクエスト。73 ms/キャラ | 本リポジトリ | [02](02-moba.md#1-なぜこの題材が-jev-に合うか-チーム視界--1-state-3-質問) |
| **独立エージェントは対称ゲームの膠着を解く** | scripted 3/3 引き分け → Jev 同士 6/6 決着 | 本リポジトリ | [10](10-jev-vs-jev.md#2-結果--独立させると決着する) |
| **視界の霧はプロセス境界で強制できる** | 相手の観測がワイヤーに乗らない。並行で 1 tick≈1 リクエスト | 本リポジトリ | [10](10-jev-vs-jev.md#1-構成--視界の霧を配線で強制する) |
| **criteria をその場の合法手にする** | 不正手が表現不能になる。MOBA 489 判断・チェス 37 手で 0 件 | 本リポジトリ | [02](02-moba.md#2-結果), [03](03-chess.md#2-一番の発見-反則手が表現できないことの価値) |
| **confidence を「難しさ」の指標に使う** | チェスでは ρ=-0.47 で効く。ただし条件つき | 本リポジトリ | [03](03-chess.md#3-confidence-が難しさを測っている), [07](07-escalation.md) |
| **質問はエージェント、閾値はデータ** | 閾値を合わせ直すと 10〜22 → 21〜22 に収束 | 本リポジトリ | [04](04-agent-built-prompts.md#2-原因は設計ではなく閾値だった) |
| **提案は「決定」ではなく「助言」として渡す** | 提案単独 10.3% → agent が見て決めて 5.9% | [cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion) | [08](08-skill-suggestion.md#42-提案は決定ではなく助言として効いている) |
| **state に stat を渡せば「選ぶ」問題も解ける** | 素の数値から編成をドラフト。Jev 順位 ≈ 実測、最強を conf 0.76 で | 本リポジトリ | [11](11-synergy.md#5-jev-は編成を選べるか--ドラフト) |
| **上流の小さなミスは下流の正しい判断で買い戻せる** | 弱いドラフト+Jev が 強いドラフト+scripted に 5-1。ただし相手も上手いと戻る | 本リポジトリ | [12](12-comeback.md) |
| **行動の質が買い戻せる戦略赤字は有限で、相手の強さに反比例** | handicap sweep で境界 = scripted 相手 ~20-30%、smart 相手 <20% | 本リポジトリ | [12](12-comeback.md#9-追記--取り返せる赤字の境界) |

> 一番効いたのは合成ロジックではなく**答えの形**でした。コード側の閾値をどう捏ねても
> 14/24 のままだったものが、`choice` → `score` の一手で 19 → 23 になっています。

## 効かなかった / 注意が要るパターン

| 落とし穴 | 何が起きるか |
| --- | --- |
| confidence 単独をゲートにする | 範囲外入力が conf 0.96 で誤ルーティングされる([00](00-api-notes.md#closed-world)) |
| 順序のある結論を `choice` で聞く | 隣接レベルの分割が「低 confidence」に化け、閾値が引けない([01](01-shell-risk.md#3-順序のある結論は-score-で聞く)) |
| score のラベルを直感の「ひどさ」で作る | rubric は書いた軸しか答えない。軸が混ざると単調にならない([01](01-shell-risk.md#5-rubric-は書いた軸しか答えない)) |
| 原子質問だけで判定する | 列挙し忘れた脅威クラスに穴が空く([01](01-shell-risk.md#4-分解は万能ではない)) |
| noul の criteria をトップレベルに置く | サーバーが黙って無視する。エラーは出ない([00](00-api-notes.md#noul-criteria)) |
| エージェントに質問を書かせて評価しない | 同じプロンプトで 10/24〜23/24 に振れる([04](04-agent-built-prompts.md#1-結果-書かせたままでは当たらないばらつきが巨大)) |
| score の閾値を分布を見ずに決める | rubric が実際に出す値と噛み合わず全部下位に落ちる([04](04-agent-built-prompts.md#2-原因は設計ではなく閾値だった)) |
| driver の候補一覧をステップ毎に作り直さない | SPA では 2 手目以降が古い候補から選ぶ([05](05-browser-chaos.md#4-chaosbringer-側への指摘-driver-の候補一覧が-1-ページ-1-回しか作られない)) |
| ゲートの noul を他のロスターからそのまま移す | 「スキルとは何か」の定義が埋まっている。純損失になりうる([08](08-skill-suggestion.md#43-cookbook-のゲートは-このロスターでは純損失だった)) |
| 複数の noul を平均してゲートにする | 信号を持つ 1 問が薄まる。単独のほうが強いことがある([08](08-skill-suggestion.md#43-cookbook-のゲートは-このロスターでは純損失だった)) |
| 閾値の境界に乗った決定をそのまま採る | 些細な入力差で pass/block が入れ替わる。境界帯は人間へ([09](09-guardrails.md#3-cookbook-の-15-ケースの再現)) |
| 1 リクエストの screen で全部塞げると思う | エンコードで抜ける・聞いてないハザードに穴([09](09-guardrails.md#外した-2-件--どちらも1-リクエストで-screen-の構造的限界)) |
| confidence の相関だけ見て二層構成を組む | 第二段が弱い・分布が潰れている場合に破綻する([07](07-escalation.md#結論先に)) |
| エスカレーションをランダム同予算と比べない | どう選んでも品質は上がるので、効いた証明にならない([07](07-escalation.md#4-q2--コスト品質曲線)) |
| シナジーの機構を実装せず編成だけ変える | ピールや耐性が効かないと前衛はただの的で raw DPS が勝つ。効果は機構を入れて初めて測れる([11](11-synergy.md#2-チャンピオンに多様性を持たせる)) |
| リトライ無しのクライアントで API を叩きすぎる | レート制限で全 hold、対称ゲームが 350-350 で膠着する([11](11-synergy.md#1-相互キルの同時処理)) |
| ドラフトの良し悪しを 1 つの policy だけで判定する | scripted に弱い編成が Jev には強い。順位は policy 依存([12](12-comeback.md)) |
| 弱い基準で観測した「取り返し」を一般化する | 基準を上げると蒸発する。本当に弱い編成 classic は scripted に 5-1 → smart に 0-6([12](12-comeback.md#8-追記--強い-bot-を基準にすると取り返し幅は縮む)) |

## レポート

| # | 内容 | 状態 |
| --- | --- | --- |
| [00](00-api-notes.md) | API の実挙動メモ(スキーマに書かれていない挙動・上限・パターン集の実測) | ✅ |
| [01](01-shell-risk.md) | シェルコマンドの危険度判定(エージェントの実行許可ゲート) | ✅ |
| [02](02-moba.md) | ヘッドレス 3v3 MOBA(2 レーン + ジャングル、視界と戦場の霧) | ✅ |
| [03](03-chess.md) | チェス、Jev vs Claude Sonnet 5 | ✅ |
| [04](04-agent-built-prompts.md) | コーディングエージェントに質問を組ませて動的にパイプラインを作る | ✅ |
| [05](05-browser-chaos.md) | [chaosbringer](https://github.com/mizchi/chaosbringer) の次操作選択を Jev に置き換える | ✅ |
| [06](06-ideas.md) | 次に効きそうなことの提案(優先順位つき) | 📝 |
| [07](07-escalation.md) | confidence でエスカレーションする二層構成(提案 A の検証) | ✅ |
| [08](08-skill-suggestion.md) | [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion) の追試(mizchi/skills 68 スキル) | ✅ |
| [09](09-guardrails.md) | [LLM guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails) の追試(入出力スクリーニング) | ✅ |
| [10](10-jev-vs-jev.md) | Jev vs Jev を独立プロセスで対戦(referee + player ×2) | ✅ |
| [11](11-synergy.md) | チャンピオンのシナジー(AD/AP・前衛)、相互キルの同時処理、TUI リプレイ | ✅ |
| [12](12-comeback.md) | 間違ったドラフトを正しいアクション(Jev)で取り返せるか | ✅ |

## この探索から見えている一般則

1. **1 リクエストに詰めろ。** state が一度しか送られないので、質問を足すコストは質問文のトークンだけ。
   レイテンシもほぼ増えない。迷ったら聞いておく。
2. **答えの形を問題の形に合わせろ。** 順序があるなら `score`、独立した述語なら `noul`、
   互いに排他な分岐なら `choice`。ここを間違えると confidence が読めなくなる。
3. **閉じた世界を仮定するな。** `choice` は渡した選択肢の中から必ず選ぶ。
   「どれでもない」を表現する手段(逃げ道の選択肢か、別の noul gate)を必ず用意する。
4. **state は構造化しろ。** 文字列 1 本より、判断に要る文脈を JSON で渡したほうが素直に効く。
   Jev 側の推論を強くするのではなく、**こちらが持っている情報を渡し忘れない**ための手段。
5. **分解は銀の弾丸ではない。** 原子質問はレバーを与えるが、合成規則の正しさは自分の責任になる。
   原子信号と総合質問を両方聞いて、保守的な側を採るのが一番事故が少ない。
6. **閾値はデータで決める。** どの質問を投げるかは設計だが、`score` のどこで切るかは
   実際の分布を見ないと決まらない。ラベル付きの小さなコーパスが一番効く投資
   ([04](04-agent-built-prompts.md))。
7. **設計は移せても校正は移せない。** 効いたパターンを文章で渡すとエージェントは
   構成を再現するが、閾値は当てられない。`docs/` は設計の共有には効き、
   校正の代わりにはならない。
8. **confidence が低い理由を見分ける。** 局面が難しいなら計算を足せば効く
   (チェス: 122cp → 2cp)。問いの定義が曖昧なら何に回しても効かない
   (シェル: 低 confidence の 2 件はどちらも Jev が正解)。
   後者はモデルを変える問題ではなく方針を決める問題([07](07-escalation.md#なぜドメインで分かれたのか))。
