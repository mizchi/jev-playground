# Jev research notes

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)(TypeSafe AI の System One モデル)で
**どの問題形状が優位か**を実測して記録する場所です。各レポートは実 API を叩いた生の数値を含み、
再現用の CLI が付いています。

> 対象は `jev-latest`(応答は `jev-1.13.0`)、実測は 2026-09。
> 料金は入力 `$0.042 / MTok`・出力無料なので、ここの実験はどれも 1 回数セント未満です。

**3 つの入口があります。目的で選んでください:**
>
> | | 何が書いてあるか |
> | --- | --- |
> | **[practice.md](practice.md)** | **Jev を使うときに順番に決めること。** 手順書・チェックリスト・やってはいけないこと一覧。**実アプリを操作させるなら [§8](practice.md#8-行動させるとき-選ばせるとやらせるは別物)** |
> | **[findings.md](findings.md)** | **実験ごとに何がわかったか。** 1 本 = 1 ブロック(試したこと / 結果 / わかったこと / 効かなかったこと) |
> | **[summary.md](summary.md)** | **やったこと / わかったこと**の端的な要約(ブログ用) |
>
> 下の表は各レポートの全文への索引です。
>
> **残作業は [../TODO.md](../TODO.md)** —— 「なぜ開いているか」と「何があれば閉じるか」を項目ごとに。
> **その掃討の報告が [todo-report.md](todo-report.md)** —— 14 項目を閉じて 4 項目が残った経緯、
> **5 世代続いた鎖の終わり**、そして**プログラム最古の限界([§2.1](../TODO.md))が閉じたときの数字**。
> **閉じ方が分からないものはそう書いてあります。**

## 走らせ方

```bash
export TYPESAFEAI_API_KEY=your_key_here
moon run --target native cmd/patterns --                       # 00: 公式パターン集の実測
moon run --target native cmd/shellrisk --                      # 01: シェルコマンド判定
moon run --target native cmd/moba -- --a jev --b scripted      # 02: 3v3 MOBA
moon run --target native cmd/moba5 -- --bench --dry             # 56: 5v5 の採点表と床(API 不要)
moon run --target native cmd/moba5 -- --bench --repeat 5        # 56: 5v5 を 124 問 × 5 回で採点
moon run --target native cmd/moba5 -- --coherence --from-answers moba5/runs/wording.jsonl  # 56: fight と retreat の truth を並べる(API 不要)
moon run --target native cmd/moba5 -- --from-answers moba5/runs/wording.jsonl              # 56: retreat を 2 択と 3 択で聞いた記録を再生(API 不要)
moon run --target native cmd/moba5 -- --from-answers moba5/runs/descriptions.jsonl          # 56: 3 択を 4 通りの説明文で聞いた記録を再生(API 不要)
moon run --target native cmd/moba5 -- --wording --repeat 3 --answers moba5/runs/wording.jsonl  # 56: その記録を取り直す
moon run --target native cmd/moba5 -- --descriptions --repeat 3 --answers moba5/runs/descriptions.jsonl  # 56: 説明文 4 通りを取り直す
moon run --target native cmd/moba5 -- --a jev --b smart         # 56: 5v5 MOBA
cd experiments/chess          && npm i && npx tsx src/run.ts   # 03: チェス vs Sonnet 5
cd experiments/agent-questions && npm i && npx tsx src/run.ts  # 04: エージェントに質問を書かせる
cd experiments/browser-chaos  && npm i && npx tsx src/run-spa.ts # 05: ブラウザ探索
cd experiments/browser-chaos  && npx tsx src/check-overlay.ts    # 25: 透明 backdrop の仕掛け(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-confidence.ts --seeds 4 # 25: confidence フォールバック
cd experiments/browser-chaos  && npx tsx src/check-coverage.ts   # 26: カバレッジ計測(API 不要)
cd experiments/browser-chaos  && npx tsx src/check-code-map.ts   # 26: 名前の突き合わせ(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-coverage.ts --seeds 3 # 26: カバレッジ誘導
cd experiments/browser-chaos  && npx tsx src/check-bugs.ts       # 27: 仕込んだバグ(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-testgen.ts      # 27: 自然言語 -> テスト生成
cd experiments/browser-chaos  && npx tsx src/run-testgen.ts --repeat 5 --routes # 27 §4.6: 経路 4 通りの盤面
cd experiments/browser-chaos  && npx tsx src/run-route-choice.ts --repeat 6 # 27 §4.7: なぜ 1 経路に寄るのか
cd experiments/browser-chaos  && npx tsx src/run-route-choice.ts --decompose --repeat 6 # 27 §4.8: 採番 vs 画面テキスト
cd experiments/browser-chaos  && npx tsx src/run-route-choice.ts --label-position --repeat 6 # 27 §4.8: ラベル x 位置
cd experiments/browser-chaos  && npx tsx src/run-route-choice.ts --long-list --repeat 6 # 27 §4.9: 候補 46 個でも成り立つか
cd experiments/browser-chaos  && npx tsx src/run-route-choice.ts --filler-vocab --repeat 6 # 27 §4.10: なぜ filler で確信が上がるか
cd experiments/browser-chaos  && npx tsx src/run-perf.ts --repeat 3 # 28: 計測 -> 診断 -> 検証
cd experiments/browser-chaos  && npx tsx src/check-fanout.ts     # 29: action space と validateChoice(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-fanout.ts --select many --seeds 2 --steps 18 # 29: 投機的 fan-out
cd experiments/browser-chaos  && npx tsx src/run-adversarial.ts --fixture hostile --runs 2 # 29 §8: 投機を壊しにいく
cd experiments/browser-chaos  && npx tsx src/run-adversarial.ts --fixture slots-hard --runs 2 # 29 §8.1: ゴールに無い判断材料
cd experiments/browser-chaos  && npx tsx src/run-ablation.ts --runs 2 --steps 16 # 30: 手法を重ねたときの ablation
cd experiments/browser-chaos  && npx tsx src/check-retrieve.ts --wide 200 # 30 §6: 候補検索の recall@k(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-ablation.ts --wide --runs 2 # 30 §6.4: 視野で絞る
cd experiments/browser-chaos  && npx tsx src/check-retrieve.ts --wide 200 --before # 30 §6.5: 答えを折り返しの下に(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-ablation.ts --wide --before --runs 2 --steps 18 # 30 §6.5: SCROLL
cd experiments/browser-chaos  && npx tsx src/check-cache.ts       # 30 §6.6: キャッシュの意味論(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-cache.ts --steps 16 # 30 §6.6: action キャッシュ
cd experiments/browser-chaos  && npx tsx src/run-ablation.ts --clear --runs 2 # 30 §6.7: CLEAR 操作
python3 -m http.server -d web 8000                             # 11: リプレイを Web 再生 → :8000/replay.html
cd experiments/eslint-oracle  && npm i && npx tsx src/run.ts   # 16: ESLint の合否予測
cd experiments/task-picker    && npm i && npx tsx src/run.ts --scale # 17: タスク選択
node hooks/test-gate.mjs --failsafe-only                       # 18: hook のフェイルセーフ(API 不要)
node hooks/test-gate.mjs                                       # 18: hook を実物で採点
node jevlang-js/bin/jevlang.mjs examples/milk.jev               # 19: jevlang(JS 版)
moon run --target native cmd/jevlang -- examples/milk.jev       # 19: jevlang(MoonBit 版)
scripts/jevlang-conformance.sh                                 # 19: 2 実装の一致(API 不要)
node scripts/check-doc-anchors.mjs                             # docs/ と 根の README の #anchor 切れ(API 不要)
node hooks/test-gate.mjs --policy-logic                        # 18/19: .jev ポリシーの規則(API 不要)
moon run --target native cmd/jevdsl -- --bundled               # 20: match できるラッパー
cd experiments/eslint-plugin-jev && npm i && npm test           # 21: ESLint プラグイン(API 不要)
cd experiments/eslint-plugin-jev && npm run warm && npm run lint # 21: 判定を Jev がやる eslint
cd experiments/eslint-plugin-jev && npm run replay              # 21: 記録から再採点(API 不要)
cd experiments/eslint-plugin-jev && npm run replay:criteria     # 22: 指標 4 種の比較(API 不要)
cd experiments/eslint-plugin-jev && npm run criteria -- --repeat 3 # 22: 指標を名前で聞く
cd experiments/eslint-plugin-jev && npm run replay:tiers        # 22: 穴の 2×2(API 不要)
cd experiments/eslint-plugin-jev && npm run replay:loo          # 22: 指標を 1 つ抜く(API 不要)
cd experiments/task-filter    && npm i && npm test               # 23: filter の不変条件(API 不要)
cd experiments/task-filter    && npx tsx src/run.ts --replay        # 23: 収集済みの行を再集計(API 不要)
cd experiments/task-filter    && npx tsx src/run.ts --repeat 3      # 23: タスク filter
cd experiments/task-filter    && npx tsx src/cli.ts --base main     # 23: 手元の diff に対して使う
npx tsx experiments/task-filter/real/observe-mutations.ts           # 23: 正解ラベルを実測(要 moon/just)
npx tsx experiments/task-filter/real/run.ts --replay                 # 23: §12 の再集計(API 不要)
cd experiments/threshold-fit  && npm i && npm test                  # 25: 閾値部品の不変条件(API 不要)
cd experiments/threshold-fit  && npm run report                     # 25: 22/23 の記録を当てはめ直す(API 不要)
npx tsx experiments/task-filter/real/run.ts --repeat 10 --out scores-draws.json # 25: 同じ diff を 10 回
npx tsx experiments/task-filter/src/cli.ts --penalty 600             # 25: コストで決める filter
experiments/eslint-plugin-jev/node_modules/.bin/eslint .             # 26: このリポジトリを自分の規約で lint(API 不要)
node experiments/eslint-plugin-jev/experiment/rules-report.mjs \
  --cache experiments/eslint-plugin-jev/experiment/out-repo-rules.json --rules eslint.rules.mjs  # 26: 記録から再集計
cd experiments/otel-triage     && npm i && npm test                 # 27: シミュレータと検知器の不変条件(API 不要)
cd experiments/otel-triage     && npm run demo                      # 27: 記録から再集計(API 不要)
cd experiments/otel-triage     && npx tsx src/run.ts --arm aggregate --repeat 3  # 27: 異常検知のトリアージ
cd experiments/bilingual       && npm i && npm test                 # 28: 対訳の整列と規則の不変条件(API 不要)
cd experiments/bilingual       && npm run demo                      # 28: 記録から再集計(API 不要)
cd experiments/bilingual       && npx tsx src/run.ts --arm section --repeat 3   # 28: 英日が同じことを言っているか
cd experiments/skill-select    && npm i && npm test                 # 29: ラベル規則とラベル漏れの検査(API 不要)
cd experiments/skill-select    && npm run demo                      # 29: 記録から再集計(API 不要)
cd experiments/skill-select    && npx tsx src/run.ts --arm fanout    # 29: 74 skill から選ぶ(14 リクエスト)
cd experiments/skill-pick      && npm i && npm test                 # 30: ロスターの join とラベル漏れ(API 不要)
cd experiments/skill-pick      && npm run demo                      # 30: 記録から再集計(API 不要)
npx tsx experiments/skill-pick/src/pick.ts . --stage1-only          # 30: 道具。461 skill から短縮リスト(API 不要)
npx tsx experiments/skill-pick/src/pick.ts . --prior --intent "..."  # 30: 1 リクエスト $0.0004
cd experiments/orchestration   && npm i && npm test                 # 31: ラベル一致とラベル漏れ(API 不要)
cd experiments/orchestration   && npm run demo                      # 31: 記録から再集計(API 不要)
cd experiments/orchestration   && npx tsx src/run.ts --arm all --repeat 3  # 31: ゲートを 5 通りに読む
cd experiments/repair          && npm i && npm test                 # 32: 全題材が赤から始まるか・truth が古くないか
cd experiments/repair          && npm run demo                      # 32: 記録から再集計(API 不要)
cd experiments/repair          && npx tsx src/run.ts --replay --verify  # 32: 順序を本物のプロセスで確認
cd experiments/review          && npm i && npm test                 # 33: 緑の基準が緑か・truth が古くないか
cd experiments/review          && npm run demo                      # 33: 記録から再集計(API 不要)
cd experiments/review          && npx tsx src/dupes.ts              # 33: similarity-ts をこのリポジトリに当てる
apt-get install -y nethack-console                                  # 34: 本物の NetHack 3.6.7(tmux も要る)
cd experiments/roguelike       && npm i && npm test                 # 34: 画面の読みと行動集合の不変条件(API 不要)
cd experiments/roguelike       && npm run demo                      # 34: 記録から再集計(API 不要)
cd experiments/roguelike       && npm run walk -- --games 3          # 34: ベースラインと画面 corpus(API 不要)
cd experiments/roguelike       && npx tsx src/run.ts --perceive      # 34: 画面を読めているか
cd experiments/roguelike       && npx tsx src/run.ts --play --games 3 # 34: 実際に遊ばせる
cd experiments/tension         && npm i && npm test                 # 35: 規則・solver・統計量の不変条件(API 不要)
cd experiments/tension         && npm run demo                      # 35: 記録から再集計(API 不要)
cd experiments/tension         && npx tsx src/run.ts --play --repeat 6 # 35: jev 同士で 5 種を対戦
npm --prefix packages install                                       # 36: 2 つの router の workspace
npm --prefix packages/jev-model-router test                          # 36: 質問の形と policy の全域性(API 不要)
npm --prefix packages/jev-skill-router test                          # 36: カタログの分割と cutoff(API 不要)
packages/jev-model-router/src/cli.ts "fix the failing auth test"     # 36: モデルを 1 件選ぶ($0.00003)
packages/jev-skill-router/src/cli.ts --dir ~/.claude/skills --dry-run "..." # 36: 無料の前段だけ見る
cd experiments/router          && npm i && npm test                 # 36 §5: corpus とラベルの不変条件(API 不要)
cd experiments/router          && npm run demo                      # 36 §5: 記録から再集計(API 不要)
cd experiments/router          && npx tsx src/harder.ts             # 36 §5: 難しい題材を機械的に合成(API 不要)
cd experiments/router          && npx tsx src/label.ts --corpus hard # 36 §5: どの段が実際に直せるか(claude CLI)
cd experiments/router          && npx tsx src/ask.ts                # 36 §5: router の予測
node tools/check-links.mjs                                          # docs の相対リンクとアンカー全部
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
| **繰り返させたくない選択はコードで判定する** | 連打が完全に止まる。ただし比較相手は「直前の 1 手についてのグローバルな真偽値」で、**候補ごとに付けて伝える形は測っていない**(→ 下の 30 §4) | 本リポジトリ | [05](05-browser-chaos.md#変化-2--3-無効だった候補を消すと連打が止まった) |
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
| **判定基準だけ渡せば実装なしで合否が当たる** | ESLint の説明文だけで **88.4%・AUC 0.95**。素直なケースは 60/60 | 本リポジトリ | [16](16-eslint-oracle.md#2-結果) |
| **ルール名より判定基準を渡す** | ID だけだと過検出が 2〜3 倍(101 対 34)。暗記ではなく読解が効いている | 本リポジトリ | [16](16-eslint-oracle.md#3-どこまで見せるかは正解率を動かさない動くのは過検出) |
| **名前だけの一覧から正しいものを選ばせる** | 53 タスクから **90.0%**、133 タスクでも 85.6%。1 行の説明で **100%** | 本リポジトリ | [17](17-task-picker.md#2-結果--名前だけで-90説明文を足すと-100) |
| **逃げ道は選択肢ではなく別の noul にする** | noul ゲート **18/18** 対 選択肢に混ぜて 16/18。混ぜると難問がそこへ逃げる | 本リポジトリ | [17](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) |
| **原子信号と総合質問の保守側を採る** | スコア単独 90.3%・原子単独 61.1% に対し **保守側 94.4%**(同一応答で比較) | 本リポジトリ | [18](18-permission-hook.md#2-判定そのもの) |
| **失敗は「判断なし」に落とす** | hook の 7 失敗経路すべてが通常フローに戻る。allow にも deny にも倒さない | 本リポジトリ | [18](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質) |
| **質問文が確定している judgment を巻き上げる** | 言語レベルの fan-out。**4 → 2 リクエスト、1501 → 867 トークン** | 本リポジトリ | [19](19-jevlang.md#2-巻き上げspeculative-batching-実測-4--2-リクエスト) |
| **設計判断を構文で強制する** | 閾値を質問文に書く場所を作らない・逃げ道を選択肢に混ぜられなくする | 本リポジトリ | [19](19-jevlang.md#1-言語の形) |
| **確率的な判断には record/replay** | 無いとテストが書けず、実装差とモデルのばらつきも区別できない | 本リポジトリ | [19](19-jevlang.md#4-record--replay--確率的な言語に必須の道具) |
| **判定ロジックをコードではなくデータにする** | hook の判定を `.jev` に出して差し替え可能に。規則と理由文の 16 分岐を API 無しで検証 | 本リポジトリ | [18](18-permission-hook.md#6b-判定ロジックを-jev-で書く) |
| **3 種を `(result, confidence)` に揃える** | `match` の形が同じになり、guard に閾値が書ける。noul は confidence を導出する必要あり | 本リポジトリ | [20](20-jevdsl.md#1-result-confidence-に揃えるときnoul-だけ困る) |
| **非同期の判定は事前バッチ + 同期ルックアップ** | ESLint の同期ルールに Jev を入れる。lint 時間は**何もしない lint と誤差の範囲**(31 ms 対 36 ms) | 本リポジトリ | [21](21-eslint-plugin-jev.md#1-eslint-プラグインにする唯一の難所--ルールは同期) |
| **state の一部分についての質問も束ねて良い** | ファイル全関数を 1 リクエストに。**4.7x 少ないリクエストで平均絶対差 0.082・ρ 0.931** | 本リポジトリ | [21](21-eslint-plugin-jev.md#5-バッチはほぼ無料--これがこのプラグインの成立条件) |
| **confidence はルーティング、ゲートではない** | 報告条件から外すと **62.5% → 73.7%**。clean と bug で confidence が同じ値域に入る | 本リポジトリ | [21](21-eslint-plugin-jev.md#7-confidence-をゲートにすると-11-ポイント損する) |
| **1 リクエストに 1220 問入る(上限は質問数ではない)** | 枠は 2 つ、**state 32Ki / リクエスト全体 64Ki トークン**。255 は choice の選択肢の上限 | 本リポジトリ | [00](00-api-notes.md#token-ceilings) |
| **欠陥クラスに名前を付けて別々に聞く** | 33/51 → **41/51**、誤検出は同じ。そして指摘が `api_default (0.35)` と**名前で返る** | 本リポジトリ | [22](22-code-criteria.md#2-結果) |
| **閾値はゲート単位ではなく質問単位で引く** | 同型の 8 問でも自クラス平均が 0.20〜0.94。共通閾値 0.80 は **13/36、質問ごとなら 24/36** | 本リポジトリ | [22](22-code-criteria.md#4-一番効いたのは指標ではなく指標ごとの閾値) |
| **原子質問は汎用質問の「上乗せ」にする** | 原子だけだと列挙外クラスで 11/15 に落ち、両方なら 15/15 に戻る | 本リポジトリ | [22](22-code-criteria.md#112-指標を-1-つ抜くと7-個は何も失わない) |
| **指標の効果は「見えにくいバグ」でだけ出る** | easy なバグは全 rubric 15/15。**hard なバグで 14% → 52%** | 本リポジトリ | [22](22-code-criteria.md#111-easy-では-naming-は何もしないhard-では-26-倍になる) |
| **記録に閾値を書いておく** | `--from` が記録時の閾値で採点する。無いと閾値を直すたび過去のレポートが書き換わる | 本リポジトリ | [22](22-code-criteria.md#114-当てはめた閾値は予告どおり壊れたそして直せた) |
| **グラフはコードに、判断は Jev に** | 前提と順序を閉包に任せてゴールだけ採点。**検出 15/15 を保って machine time 68.6%**(t=1.25 で 75.8%)削減 | 本リポジトリ | [23](23-task-filter.md#3-結果--検出を落とさず-686-削る) |
| **意図が書かれていないなら diff の中身を渡す** | パスだけでは無害な変更の判別が **0.482(コイン投げ)**。hunk を渡すと 0.183 | 本リポジトリ | [23](23-task-filter.md#4-文脈は効いた--17-との違いは意図が書かれているかどうか) |
| **閾値をコストで重み付けする** | 4 秒のタスクが 1.24 対 1.25 で落ちる。「10 秒以下は無条件」で 44/45 → **45/45**、代償 0.5 分 | 本リポジトリ | [23](23-task-filter.md#7-安いタスクに同じ閾値を使ってはいけない) |
| **doc には「何をするか」ではなく「何を守るか」を書く** | 1 行のコメントを書き直して削減 **53.3% → 65.9%**、過剰選択 31/45 → 18/45 | 本リポジトリ | [23 §12.4](23-task-filter.md#124-効いたのは-1-行のコメントだった) |
| **述語だけ自然言語にして、絞り込みは既存の決定的な仕組みに任せる** | ESLint セレクタでノードを選び、違反かどうかだけ 1 文で聞く。**49 ノード → 7 指摘、自信のある 5 件は 5/5 正解** | 本リポジトリ | [24](24-adhoc-rules.md#結論先に) |
| **読むのは閾値ではなく gap(違反と残りの点数差)** | gap が広ければ閾値はどこでも同じ答え。**狭いのは閾値ではなく質問の問題**で、校正では直らない | 本リポジトリ | [24](24-adhoc-rules.md#1-読むのは閾値ではなく-gap) |
| **gap の隣に band(答えがどのレベルに居るか)を出す** | 狭い gap は「違反が無い」と「文が働いていない」の両方に見える。実コードでは前者が普通 | 本リポジトリ | [26](26-repo-rules.md#4-gap-の隣に-band-を置いた) |
| **セレクタは広く書いてよい(level 0 が吸う)** | わざと広くした `TemplateLiteral` 422 件のうち **398 件が「当てはまらない」・誤検出 0** | 本リポジトリ | [26](26-repo-rules.md#1-一回目の実行--579-判定29-秒00135) |
| **観測データは集計を渡す(生ログより安くて強い)** | 集計 2026 トークンで cause 24/30、生ログを足すと 7441 トークンで 18/30 | 本リポジトリ | [27](27-otel-triage.md#5-同じ件数の生ログをうるさい順に選ぶか均等に選ぶか) |
| **サンプリング規則は質問の一部** | 同じ件数・同じトークン数で、うるさい順に選ぶと誤ページ **27 件・均等なら 6 件** | 本リポジトリ | [27](27-otel-triage.md#5-同じ件数の生ログをうるさい順に選ぶか均等に選ぶか) |
| **翻訳の同期は「diff + 判断」で割る** | 数値と識別子は差分で 26/30・誤検出 0、意味の 4 クラスは判断が 2 つ埋める(84/90・誤検出 0) | 本リポジトリ | [28](28-bilingual.md#2-判断は何を足すか) |
| **原子述語は「どこがどう違うか」まで返す** | omission で `omits` 0.95、addition で `adds` 0.98、数値差で `numbers_agree` 0.03 | 本リポジトリ | [28](28-bilingual.md#2-判断は何を足すか) |
| **ファン・アウトは幅を広げても答えが変わらない** | 74 問を 1 リクエストと 1 問 1,036 リクエストで **0.25 以内に 99.8% 一致**・平均差 0.032、コストは 2.4 分の 1 | mizchi/skills のカタログ | [29](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) |
| **判断対象は state ではなく質問に置く** | 同じ幅 1 で、state に移すと一致が 53%・AP 0.53 → 0.46 | mizchi/skills のカタログ | [29](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) |
| **選択の方針(常に入れる/頼まれたら)はコードに置く** | カタログのティア列を適用するだけで AP 0.41 → **0.70**。判断に聞くと 74 件中 41〜53 位 | mizchi/skills のカタログ | [29](29-skill-select.md#3-方針は判断に聞くものではない) |
| **人が書いた 1 行は skill 自身の description より効く** | `Use when` 列に差し替えると AP 0.53 → 0.56、P@k 0.43 → 0.51、文字数は 3 分の 1 | mizchi/skills のカタログ | [29](29-skill-select.md#9-人の-1-行は-skill-自身の-description-より良い) |
| **全問で同一の文字列は state に置く(上限が 2 倍になる)** | criteria を 1 問ごとに繰り返すと 1 問 251 トークン・260 問で上限。state に 1 回置くと 118 トークン・520 問まで入り、答えはレベル一致 95% | 461 skill のロスター | [30](30-skill-pick.md#7-criteria-の文字列の値段) |
| **候補が多いほど提案は悪くなる(curate されていないなら)** | recall 63% → 100% で P@12 は 0.25 → 0.19。増えた 387 件は「どのリポジトリにも当てはまる」実在 skill | 461 skill のロスター | [30](30-skill-pick.md#3-上げるべきは-recall-ではなかった) |
| **「どこでも高い」を引く —— 判断に対する IDF** | skill ごとの他プロジェクト平均を引くと、全件で AP 0.19 → 0.29、P@12 0.19 → 0.23 | 461 skill のロスター | [30](30-skill-pick.md#6-どこでも高いものを引く) |
| **質問にコストを書くかどうかが保守性のダイヤル** | 同じ決定・同じ state で、第 2 ワーカーのコストを先に述べると 58%(誤り 16 件すべてが「分けない」)、述べないと 79%(+4/−4) | multi-agent-orchestration | [31](31-orchestration.md#2-聞くか組み立てるか) |
| **原子が全部当たっていても結合を間違えると落ちる** | 条件 3 を規則に入れると、4 つの原子が正しいまま 4/4 → **0/4** | multi-agent-orchestration | [31](31-orchestration.md#4-太字の-1-文が何点ぶんか) |
| **表の行をそのまま choice の criteria にする** | 8 パターンの "Use for" 列で **22/22**、パターン同士の取り違えは 0 件 | multi-agent-orchestration | [31](31-orchestration.md#5-トポロジーの-choice) |
| **文字列を返せないモデルでも修復ループは書ける** | パッチはコードが生成し、判断は並べるだけ。テスト実行 3.00 回 → **1.00 回**、16/16 を一発 | 植えたバグ 21 件 | [32](32-repair.md#2-テスト実行回数) |
| **相互排他な候補なら `choice` 1 つで全順序が出る** | `probabilities` が全選択肢ぶん返るので質問 1 つ。1 タスク 1,554 トークン対 候補ごとに聞く 3,254 で、結果は同じ | 植てたバグ 21 件 | [32](32-repair.md#5-1-つの-choice-で全部の順序が出る) |
| **終了コードのラベルは gap を正にする** | このリポジトリで初めて gap が正(+0.03)。ただし draw が 0.043 動くので閾値にはならない | 植てたバグ 21 件 | [32](32-repair.md#4-直る候補が入っているか) |
| **指標を渡す前に、指標だけで分かるかを測る** | 数値指標が全部 AUC 0.5 の corpus では、渡してもトークン +69% で AUC −0.02 | 261 件の 1 行 diff | [33](33-review.md#1-まず指標だけで分かるのか) |
| **「読まれているか」は別に測る** | 指標ブロックが答えを持つ質問で 261/261。これが無いと「無意味」と「見落とし」が区別できない | 261 件の 1 行 diff | [33](33-review.md#3-指標は読まれているのか) |
| **類似度は構造の話で、同じコードかは別の機械的な質問** | `similarity-ts` が 100% と言う 3 ペアのどれも、識別子を正規化しても同じではない | このリポジトリの 179 ファイル | [33](33-review.md#5-名前のついた道具を実物のコードに当てる) |
| **閾値は gap の真ん中に置く(清潔な側の縁ではなく)** | 同じ検出 23/36 で、ホールドアウトの誤検出が **24 件 → 7 件** | 本リポジトリ | [25](25-thresholds.md#3-境界ではなく-gap-の真ん中に置く) |
| **当てはめた閾値は当てはめていない標本で採点する** | in-sample の「誤検出 0」は構造上そうなるだけ。上乗せ 10 件の半分が消える(23/36 → **18/36**) | 本リポジトリ | [25](25-thresholds.md#2-in-sample-の誤検出-0は情報がない) |
| **閾値をコストの関数にする(定数の床ではなく)** | 検出 18/18 を保って削減 73.5% → **81.4%**。判断を抜いた同じ規則は 40.9% | 本リポジトリ | [25](25-thresholds.md#5-閾値をコストの関数にする23-11-の宿題) |
| **決定的に判定できることは、モデルに聞かずに自分で判定する** | ジオメトリで押せない候補を `elementFromPoint` 1 回で判定。無駄手 **12/12 を 100% 検出**、モデル呼び出し 0。**説明文には原理的に書けない事実**である | 本リポジトリ | [57](57-confidence-fallback.md#5-効いたのはモデルに聞かないほうだった) |
| **ただし「消す」か「伝える」かは精度に関係ない** | 選択肢から消すのと state に書いて渡すのは**同値**(到達・手数ともに差なし)。消す側の追加価値は**トークン 4% で、精度ではない**。25 も 05 も「候補ごとに伝えるだけ」のアームを置いていなかった | 本リポジトリ | [62 §4](62-browser-accuracy.md#4-docs57-の解釈を-1-つ訂正する)(→ 25・05 を訂正) |
| **同値なら、間違えたときに復帰できるほう(伝える)を既定にする** | 消す側は**判定を間違えるとどの閾値でも復帰できない**。効果判定のバグで有効な操作が「無効」と記録され、**正解の経路が 2 手とも封じられた**。伝える側は誤ったラベルを渡すだけでモデルが覆せる | 本リポジトリ | [05 §3](05-browser-chaos.md#3-途中で踏んだ自分のバグ教訓込み) |
| **同じ事実でも、関連ありと印付けしないと読まれない** | 未実行の関数名を state の配列に素で置くと **1/12**。ゴール文に置くか、明示的に指示を書くか、**どちらか一方あれば 9/12**。落ちるのは両方無い 1 マスだけ(2×2 を埋めて確認) | 本リポジトリ | [58 §4.5](58-coverage-guidance.md#45-追記-残りの-2-マスを埋めたら5-の説明は間違っていた) |
| **ただし「やれ」と書くと幅を削る** | 名前をゴール文に置いて**指示は書かない**のが最良手で、分岐 9/12 のまま到達状態 **14.0/14**・無駄手 5.0。「探して押せ」と書くと 10.0/14・無駄手 9.0 に落ちる | 本リポジトリ | [58 §4.5](58-coverage-guidance.md#45-追記-残りの-2-マスを埋めたら5-の説明は間違っていた) |
| ~~**実行可能性は候補に、望ましさはゴールに**~~ —— **測って否定** | 「望ましさはゴールに置かないと勝てない」は、名前を state に残して**指示だけ**ゴールに書いた腕が 9/12 で届いたので成り立たない。26 は 2 要因を同時に動かした対角しか測っていなかった | 本リポジトリ | [58 §4.5](58-coverage-guidance.md#45-追記-残りの-2-マスを埋めたら5-の説明は間違っていた)(→ 26 §5 を訂正) |
| **assertion の候補はコードで抽出し、どれが「結果」かだけ聞く** | 前後の差分だけを候補にする。初期状態 4 件は **0.00 で落ちた**。捕まえたバグ 1 → 2 で、**5 回独立に生成して 5/5** 同じ差(捕まえた集合まで同一) | 本リポジトリ | [59](59-nl-test-generation.md#1-何を分担させたか) [59 §4.5](59-nl-test-generation.md#45-追記-5-回独立に生成させた--差は成果物ではなく方式だった) |
| **試行をまたいで点が動かないことは、カバレッジの証拠ではない** | ゴールへの経路を **4 通り**にしても選ばれる経路は **5/5 同一**(ゴール文から経路を名指す句を落としても同じ)。通らなかった経路のバグは **5/5 見逃し**。安定していたのは方式ではなく**通る道** | 本リポジトリ | [59 §4.6](59-nl-test-generation.md#46-追記-経路が複数ある盤面を作って測った) |
| **経路を決めているのはラベルである** | 2 つのボタンの**文字列だけ交換**すると選ばれる経路が入れ替わる(p(express) **0.310 → 0.900**)。picker の指示句も同点も外れ —— 6/6 で 3 ステップ側のまま | 本リポジトリ | [59 §4.7](59-nl-test-generation.md#47-追記-なぜ-1-つの経路に寄るのかを測った) |
| **無関係な候補を増やすと 2 択の確信が上がる。効くのは個数で語彙ではない** | 候補 16 → 24 → 56 で **0.673 → 0.810 → 0.887**。提示数が主チャネル(+0.10〜0.17)で画面テキストも効く(+0.04〜0.11)。ゴール語彙を仕込んだ filler との差は **≤0.032 で誤差の床の下**。**機構は不明** | 本リポジトリ | [59 §4.10](59-nl-test-generation.md#410-追記-filler-で確信が上がる理由--語彙ではなく個数そして-003-は誤差) |
| **質問の形が壊れたときは confidence が拾う** | 失敗する `viewport+scroll` 腕だけ平均 **0.41**(成功する 2 腕は 0.76 / 0.77)。[57](57-confidence-fallback.md) では無駄手を拾えなかったが、**壊れたのが形なら拾える** | 本リポジトリ | [62 §6.4](62-browser-accuracy.md#64-テキストではない絞り方が答えだった) [61](61-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving) |
| **`choice` の並び順は中立ではない。ただし候補が少ないときだけ** | 隣接 2 つを入れ替えると **16 候補で +0.21**(対称、ラベルに依らない)。**46 候補では +0.05 / +0.02 に薄まり、リスト内の絶対位置は +0.003 で効かない** | 本リポジトリ | [00](00-api-notes.md#choice-order) [59 §4.8](59-nl-test-generation.md#48-追記-express-first-が強まる理由--後に描かれたほうが得をする) [§4.9](59-nl-test-generation.md#49-追記-長いリストでは成り立たなかった--021-は短いリストの話) |
| **「壊れていない」対照も採点対象にする** | `?bug=slow` を 3 版書いて 2 版が壊れており、どちらも**エラーではなく数字**を返した —— 空白画面が `brittle 5` に、二重描画が `flaky 4/5` に化けた。**対照が壊れると生成物の欠点として現れる** | 本リポジトリ | [59 §3.3](59-nl-test-generation.md#33-追記-壊れていない対照の-bugslow-が最初から壊れていた) |
| **注記の散文は指標として扱える** | 「転送中はメインスレッドが空いている」を「ユーザーは壁時計を待ち切る」に直すだけで、推薦の実測価値が **188ms → 1,664ms** | 本リポジトリ | [60](60-perf-automation.md#結論先に) |
| **再計測しないと機会損失が見えない** | 8% 速くして「当たり」に見えた診断の隣に 71% があった | 本リポジトリ | [60](60-perf-automation.md#6-輪を閉じたから分かったこと) |
| **実行する単位を target にする(要素ではなく)** | 要素だけ指す形は値を呼び出し側の推測に残す。6 択で **+5 手**、選択肢数に比例して増える | [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | [61](61-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving) |
| **投機は無料だった** | 操作が決まる前に選んだ target は、決まった後に選んだものと**同一**(実行された head は 12/12 で TV = 0.000)。リクエストは半分、モデル壁時計は −53%。トークンは得も損もしない | [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | [61](61-speculative-fanout.md#4-the-speculation-is-free) |
| **曖昧さは「操作」側にあり、target 側には無い** | 全操作が必要な画面で operation は 0.55、その target は 1.00。投機が無料なのは target 質問が**簡単な半分**だから | 本リポジトリ | [61 §8](61-speculative-fanout.md#why-it-holds-and-when-it-could-not) |
| **target head を不確実にしようとすると、不確実さは operation 側に移る** | 4 盤面で試して used head は 20/20 が ≥0.90。型付き分割が質問を狭めている以上、「何をするか」の迷いは「どの要素か」の迷いに分解されない | 本リポジトリ | [61 §8.2](61-speculative-fanout.md#82-the-uncertain-used-head-is-not-constructible-here) |
| **空 value の `<option>` を target にしてはいけない** | プレースホルダは値ではない。満たした要件を捨てる target になり、両アームが 0.4-0.7 で食いついた | 本リポジトリ | [61 §8](61-speculative-fanout.md#what-the-run-actually-caught-a-bug-in-the-port) |
| **候補をゴールとの語彙一致で絞ってはいけない** | recall@20 が **1/10**。**何もせず先頭 20 件を採れば 10/10** なので、検索は切り詰め以下だった | 本リポジトリ / playwright-mcp の `browser_find` | [62 §6](62-browser-accuracy.md#6-browser_find-を移してみた--候補検索は安全ではなかった) |
| **視野で絞っても confidence は落ちない(この候補数では)** | §6.4 の表に conf 列が無かったので足した。`everything` 0.76 対 `viewport` **0.77** で誤差の床の内側。27 §4.10 の「絞ると下がる」は 2 択が質量を分け合う領域の話で、**214 → 58-64 には転移しない**。失敗する `viewport+scroll` だけ 0.41 に落ちる | 本リポジトリ | [62 §6.4](62-browser-accuracy.md#64-テキストではない絞り方が答えだった) |
| **視野で絞るとトークンは落ちるが、精度は「担保」で買っている(推奨は撤回)** | 候補数が**ページ幅に依存せず** 58-64、トークン **−67%**・精度同じ —— ただし節約は「答えが今の画面にある」という**ページの性質**を担保にしている。`SCROLL` を足しても返せず、自由な選択なら振動(18/18 手)、掃引なら答えを通り過ぎ、**効いていた盤面で 2/2 → 0/2**。ページ全体を相手にするなら絞らない | 本リポジトリ | [62 §6.4](62-browser-accuracy.md#64-テキストではない絞り方が答えだった) → [62 §6.5](62-browser-accuracy.md#65-scroll-を実装したら64-の推奨が崩れた) で撤回 |
| **「空にする」は独立した操作が必要** | `fill()` は置換なので値の変更には要らないが、**空という終状態は他の操作で表現できない**。無いと **0/2・43% 多くトークンを払って**ルート 3 周期に入る | browser-use の `InputTextAction{clear}` | [62 §6.7](62-browser-accuracy.md#67-clear--4-つの転用候補で唯一そのまま採用できたもの) |
| **表現力を上げる機構は効き、安くする機構は効かない** | 他実装から移した 5 機構の決算: 採用 2(型付き fan-out・`clear`)はどちらも action space の表現力側。却下 3(候補検索・キャッシュ・`SCROLL`)はどちらも削って安くする側 | 本リポジトリ | [62 §6.7](62-browser-accuracy.md#転用候補の決算) |
| **action space の表現力不足は、精度の劣化ではなく不可能性として出る** | 「空にする」を持たないだけで **0/2**。しかも**対象フィールドに一度も触らず**、画面を出て別の経路を探して周回する。エラーは出ない | 本リポジトリ | [62 §6.7](62-browser-accuracy.md#失敗の仕方が予測と違った) |
| **action キャッシュは録画で、記録が何をしたかを増幅する** | 同一ページ 10/10 再生・トークン 0。ただし `?bug=order`(注文を記録しないアプリ)でも **10/10 再生してゴール到達・`ordered: no`**。緩いキーは**ループ中に当たる**ので実行内で自滅する | stagehand | [62 §6.6](62-browser-accuracy.md#66-action-キャッシュ--節約ではなく録画だった) |
| **位置の事実で判断を駆動すると振動する** | ドロップダウン(29 §3)とスクロール(30 §6.5)で同じ形。必要なのは進捗の事実で、選択ではなく掃引にする | 本リポジトリ | [62 §6.5](62-browser-accuracy.md#65-scroll-を実装したら64-の推奨が崩れた) |
| **ゴールは結果を名指し、コントロールは遷移で名付けられている** | だから語彙が噛み合わない。`Continue to delivery` はゴールとスコア 0、ゴール語彙から作った filler が上に来る | 本リポジトリ | [62 §6.1](62-browser-accuracy.md#61-ゴールに対する語彙検索は使えない) |
| **手法の価値は足し算ではなく崖** | 型付き欠損も ジオメトリ欠損も**単独なら着く**(2/2)。両方欠けたときだけ **0/2**。各手法はもう一方が在ることを前提に予算内に収まっている | 本リポジトリ | [62 §3.1](62-browser-accuracy.md#31-足し算ではなく崖だった) |
| **4 実装すべてが値を実行単位に乗せている** | 「要素だけ指して値は呼び出し側が推測」は誰も出荷していない。独立に 4 回同じ結論 | jev-ultrafast / playwright-mcp / stagehand / browser-use | [62 §1](62-browser-accuracy.md#1-実装-4-つの決定点) |
| **hit-test を判断に入れているのは 1 実装も無い** | 4 実装すべて実行直前のガードとしてだけ使う。聞く前に観測へ入れるのは誰もやっていない | 同上 | [62 §2](62-browser-accuracy.md#2-どの実装もやっていないこと) |
| **失敗を state に戻すと confidence が反応する** | `last_action_error` と無効果連続数が入っていると 0.91 → 0.45 と減衰する。25 では blocked が 0.99 で返っていた | 本リポジトリ | [62 §3.2](62-browser-accuracy.md#32--geometry-が払ったもの) |
| **confidence は質問の形の性質で、アーム間で比較できない** | 正しい側が 0.46-0.71、失敗する側が 0.93-0.99。閾値は形ごとに引き直す | 本リポジトリ | [61](61-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving) |

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
| driver の候補一覧をステップ毎に作り直さない | SPA では 2 手目以降が古い候補から選ぶ([05](05-browser-chaos.md#4-chaosbringer-側への指摘-driver-の候補一覧が-1-ページ-1-回しか作られない))。上流は [#142](https://github.com/mizchi/chaosbringer/pull/142) で修正済み |
| confidence を無駄手の検出器に使う(**失敗を state に戻さないまま**) | 無駄手 13 件のうち 12 件が **0.99 以上**。低い手は「正しいが手応えのない手」だった([57](57-confidence-fallback.md#4-校正-confidence-は何を測っていたのか))。**戻せば反応する** —— `last_action_error` と無効果連続数を入れると 0.91 → 0.45 と減衰する([62 §3.2](62-browser-accuracy.md#32--geometry-が払ったもの)) |
| `takePreciseCoverage` を 1 発で全体像として読む | 未カバーは時間とともに消え、カウンタは毎 take リセットされる([58](58-coverage-guidance.md#2-計測側で-3-回転んだどれももっともらしい出力を出す)) |
| 解決しないセレクタで「効果なし」を数える | 押せないボタンが「効かないボタン」に化ける。実験は失敗せず**きれいな結果**を返す([58 §2.3](58-coverage-guidance.md#23-セレクタが-1-つも当たっていなかったこれが一番痛い)) |
| 生成したテストを「生成できた」で評価する | クリック列 + 最終 URL は、注文を記録しないアプリに対して緑のまま通る([59](59-nl-test-generation.md#結論先に)) |
| 固定の待ち時間でステップの費用を測る | `async` なハンドラは待たれないので、300KB の fetch が 20ms の無料ステップに見える([60](60-perf-automation.md#2-計測を-3-回直した)) |
| 無駄手(画面が変わらない手)だけでループを検出する | 10 手連続で `standard ↔ economy` を往復しても画面は毎回変わるので、**無駄手 0 のまま予算を使い切る**([61](61-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving)) |
| 成功する罠を「ゴール到達」で採点する | 同じゲートを通って同じ確認画面に着く近似ボタンは、到達率には一切出ない。state で採点するしかない([61 §8](61-speculative-fanout.md#8-trying-to-break-the-speculation)) |
| 必要な操作が無いときドライバがエラーを出すと期待する | 出さない。**画面を出て別の経路を探して周回する**。ドロップダウン 2 周期・スクロール 2 周期に続く 3 つ目の振動で、無駄手は一部しか捕まえない([62 §6.7](62-browser-accuracy.md#失敗の仕方が予測と違った)) |
| キャッシュのキーが state を覆っているか確かめずに使う | 覆っていないと古い action が自信を持って再生され、**`wasted` にも出ない**。1200 文字の切り詰めた画面テキストでキーを作って 14 手ループした([62 §6.6](62-browser-accuracy.md#66-action-キャッシュ--節約ではなく録画だった)) |
| 視野で絞ったうえで `SCROLL` を操作として足す | 見えないものを探すのが探索で、見えなくしたのは絞り込み自身。Playwright はクリック時に自動スクロールするので、全部送るなら `SCROLL` は要らない([62 §6.5](62-browser-accuracy.md#65-scroll-を実装したら64-の推奨が崩れた)) |
| ゴールとの語彙一致で候補を絞る | 正解を**答えから遠ざける方向**に並べ替える。画面テキストを足すと全体のスコアが上がって識別が消え、小さい k ではさらに悪化する([62 §6.1](62-browser-accuracy.md#61-ゴールに対する語彙検索は使えない)) |
| 「今の値と違う最初の選択肢」でドロップダウンを送る | 列挙ではなく 2 周期の**振動**になり、3 番目以降に永久に到達しない。記憶を持たせると 1 選択肢 1 手で終わる([61](61-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving)) |
| 「壊れていない」対照を採点対象から外す | `?bug=slow` を 3 版書いて 2 版が壊れており、どちらも**エラーではなく数字**を返した —— 空白画面が `brittle 5`、二重描画が `flaky 4/5` に化けた。**壊れた対照は生成物の欠点として現れる**([59 §3.3](59-nl-test-generation.md#33-追記-壊れていない対照の-bugslow-が最初から壊れていた)) |
| 誤差の床を測らずに小さな差を解釈する | 同一条件 2 回で **0.04 動く**。1 回目に出た「2 プールが 0.853 でぴったり一致」を機構として書きかけ、2 回目で偶然だと分かった。**再実行が唯一の検出器**([59 §4.10](59-nl-test-generation.md#410-追記-filler-で確信が上がる理由--語彙ではなく個数そして-003-は誤差)) |
| 候補数の領域が違う測定から数字を転移させる | 「絞ると confidence が下がる」は 56 → 16 で **0.845 → 0.783**。同じ機構のはずの 214 → 58-64 で測り直すと **0.76 対 0.77 で床の内側**、つまり**移らない**([62 §6.4 追記](62-browser-accuracy.md#64-テキストではない絞り方が答えだった)) |
| リンク文言を「表示だけ」の変更だと思う | **ラベルが実行経路を決めている。** 文字列を交換しただけで生成されるテストが別経路に移り、通らない経路のバグは見えなくなる —— **文言の変更がカバレッジを静かに動かす**([59 §4.7](59-nl-test-generation.md#47-追記-なぜ-1-つの経路に寄るのかを測った)) |
| 置かなかったアームについて結論を書く | 「消す」と「伝える」を比べるつもりで「伝えるだけ」を置き忘れると、出る結論は「消すと効く」になる。後で足したら**同値**だった。**結論ではなく解釈が静かに間に合わなくなる**([62 §4](62-browser-accuracy.md#4-docs57-の解釈を-1-つ訂正する)) |
| 「正直な限界」節を書かずにレポートを出す | **書き忘れた本にだけ未検証の主張が残っていた。** 25〜28 の 4 本が限界節なしで、うち 25 は 30 に否定され、26 は機構の解釈を「分かった」と書き、27 は **n=1 の生成物 2 個**で方式を比べていた。限界節のある本を当たっても同じ形は出てこない —— **節を書く作業が、測っていない軸を数える作業**だった([57 §8](57-confidence-fallback.md#8-正直な限界))。**3 本とも後から測り、26 は否定・27 は確認**([58 §4.5](58-coverage-guidance.md#45-追記-残りの-2-マスを埋めたら5-の説明は間違っていた) / [59 §4.5](59-nl-test-generation.md#45-追記-5-回独立に生成させた--差は成果物ではなく方式だった)) |
| 1 対 1 で効いた手法を、重ねても足し算だと思う | 足し算ではなく**崖**。型付き欠損もジオメトリ欠損も単独なら 2/2 で着き、両方欠けたときだけ 0/2。各手法は**もう一方が在ることを前提に**予算内に収まっている([62 §3.1](62-browser-accuracy.md#31-足し算ではなく崖だった)) |
| ゲートの noul を他のロスターからそのまま移す | 「スキルとは何か」の定義が埋まっている。純損失になりうる([08](08-skill-suggestion.md#43-cookbook-のゲートはこのロスターでは純損失だった)) |
| 複数の noul を平均してゲートにする | 信号を持つ 1 問が薄まる。単独のほうが強いことがある([08](08-skill-suggestion.md#43-cookbook-のゲートはこのロスターでは純損失だった)) |
| 閾値の境界に乗った決定をそのまま採る | 些細な入力差で pass/block が入れ替わる。境界帯は人間へ([09](09-guardrails.md#3-cookbook-の-15-ケースの再現)) |
| 1 リクエストの screen で全部塞げると思う | エンコードで抜ける・聞いてないハザードに穴([09](09-guardrails.md#外した-2-件--どちらも1-リクエストで-screenの構造的限界)) |
| confidence の相関だけ見て二層構成を組む | 第二段が弱い・分布が潰れている場合に破綻する([07](07-escalation.md#結論先に)) |
| エスカレーションをランダム同予算と比べない | どう選んでも品質は上がるので、効いた証明にならない([07](07-escalation.md#4-q2--コスト品質曲線)) |
| 判定基準の説明文を「仕様」だと思う | 逃げ道は実装にしかない。5 回とも同じ側に外す過検出になる([16](16-eslint-oracle.md#4-外すのは全部実装にしか書いていない逃げ道)) |
| 例外規定を渡して過検出を直そうとする | 逃げ道を探しに行く。見逃しが 0 → 11 件、免除を隣の綴りにまで一般化して p 0.18 の自信ある誤答([16](16-eslint-oracle.md#5-逃げ道を渡したら直るのか--spec-arm)) |
| 「該当なし」を `choice` の選択肢に混ぜる | 難問と該当なしが同じ出口を共有する。正解がロスターに有る問題を conf 0.50 で「該当なし」にした([17](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする)) |
| 逃げ道を二重にかける | 選択肢の逃げ道 + noul ゲートは 89.8% → 88.0% と下がる([17](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする)) |
| 一覧の項目名が内容と食い違っている | `test` が e2e まで走る類。名前だけでは原理的に読めず conf 0.99 で誤答する。1 行の説明で消える([17](17-task-picker.md#2-結果--名前だけで-90説明文を足すと-100)) |
| オフラインの正解率で質問文が妥当だと思う | `exfiltrates` の `false` が「外向き転送が無い」だった。23/24 を取ったまま、hook にした 1 発目で**普通の `git push` を deny**([18](18-permission-hook.md#3-コーパスでは見つからないバグが出た)) |
| 保守側採用を「安全だから無害」だと思う | 誤った述語の害も増幅する。スコアが allow 0.43 と言っているのを原子述語が deny に引き上げた([18](18-permission-hook.md#3-コーパスでは見つからないバグが出た)) |
| ゲートに `allow` を返させる | ユーザーが設定した permission ルールを上書き承認してしまう。狭める方向にだけ使う([18](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質)) |
| 確率的な実行を replay 無しでテストしようとする | 分岐が毎回変わるので期待値が書けず、実装差とモデルのばらつきが区別できない([19](19-jevlang.md#4-record--replay--確率的な言語に必須の道具)) |
| ラッパーを「1 判断 1 リクエスト」で作る | 同じ 3 判断が 3 リクエスト/1069 トークン 対 束ねて 1/435。束ねる道を最初から用意する([20](20-jevdsl.md#3-1-判断-1-リクエストは既定として間違っている)) |
| noul の確率をそのまま confidence として使う | `confidence > 0.5` が `result == true` と同義になって guard が無意味になる。コイン投げからの距離にする([20](20-jevdsl.md#1-result-confidence-に揃えるときnoul-だけ困る)) |
| confidence を報告の前提条件にする | clean も bug も 0.54〜0.57 に入るので、柵にすると正解を捨てる。score 2.42 / conf 0.42 の当たりが消えた([21](21-eslint-plugin-jev.md#7-confidence-をゲートにすると-11-ポイント損する)) |
| 質問に、state にあるものを重ねて書く | 関数のコードを質問にも入れると **32% 多く払って 0.4 ポイント下がる**。名前と行番号で十分([21](21-eslint-plugin-jev.md#関数のコードを質問に重ねるのは払い損)) |
| 文脈を足せば精度が上がると思う | ファイル全体を state に入れると clean の score が上がり、**誤検出が 5 倍**になる。文脈は judgment を穏やかにするだけ([21](21-eslint-plugin-jev.md#6-ファイルの文脈は精度を上げない下げる)) |
| コード品質のような「審判のいない」判定を正解率で語る | 51 判定中バグ 12 個なら「何も言わない」が 76.5% を取る。読むべきは**指摘の中身**([21](21-eslint-plugin-jev.md#素の正解率で負けるのは指標のせいではない)) |
| バッチ上限を質問数だと思う | 1220 問は通る。詰まるのは **state 32Ki** が先。`max_tokens_exceeded` を見たら半分に割る([00](00-api-notes.md#token-ceilings)) |
| 複数の noul に共通の閾値を使う | スケールが質問ごとに違う。AUC 0.92 の指標が 0.80 の柵で 1 件も拾えない([22](22-code-criteria.md#4-一番効いたのは指標ではなく指標ごとの閾値)) |
| 判定基準をチェックリストとして instructions に列挙する | rubric の再校正になるだけで検出は増えない。全クラスの score が下がり、トークンは 81% 増える([22](22-code-criteria.md#7-チェックリストを-instructions-に入れると校正になるだけ)) |
| 「軸を書けば答えが来る」と思う | 正しい軸を名指しで投げても **0.09 で「いいえ」**と返る。落としていた 6 個のうち戻ったのは 2 個([22](22-code-criteria.md#3-落とした-6-個のうち戻ったのは-2-個)) |
| 閾値を「誤検出 0 の境界」に当てはめる | 境界そのものに置くと次の 1 回で越える。10 関数足したら `unescaped_composition` が**テンプレートリテラル全部**に発火した。1 段上げれば自クラスは無傷([22](22-code-criteria.md#114-当てはめた閾値は予告どおり壊れたそして直せた)) |
| 保留セットの「難しさ」を揃えない | 列挙外かどうかだけ揃えても何も測れない。易しいバグは naming 無しでも 15/15 なので穴が浅く見える([22](22-code-criteria.md#111-easy-では-naming-は何もしないhard-では-26-倍になる)) |
| 指標を増やして精度を上げようとする | 8 個のうち 7 個は抜いても自クラスを失わない(隣か汎用が拾う)。増やすより広い 1 個を校正する([22](22-code-criteria.md#112-指標を-1-つ抜くと7-個は何も失わない)) |
| gap が狭いのを閾値で直そうとする | 答えがそもそも分かれていないので校正の外。**質問を書き直す**。5 ルール中 2 つが gap 0.16 / 0.28 で失敗し、書き直して 2.16 / 0.77 になった([24](24-adhoc-rules.md#2-5-ルール中-2-つは最初の文が失敗した)) |
| 判断できない条件を質問文の中に書く | 「呼び出し元が失敗を知る必要があるか」を catch 節について聞くと全部真ん中に来る。**subject から見える範囲だけを聞く**([24](24-adhoc-rules.md#2-5-ルール中-2-つは最初の文が失敗した)) |
| 決定的な絞り込みを狭く書く | セレクタに当たらなかったノードは**どの閾値でも質問されず、レポートにも出ない**。広く当てて質問で絞る([24](24-adhoc-rules.md#5-セレクタは静かに失敗するこれは直せない)) |
| 手書きの数値パーサで閾値を読む | `0.6` が 0.6000000000000001 になり、境界で分岐が変わる。小数部は整数で溜めて最後に 1 回割る([19](19-jevlang.md#5-2-実装であることが実際に効いた)) |
| 逃げ道の gate を subject を見ずに付ける | 文字列の `match` にも「どれも当てはまらないか」を聞いてしまう。gate が要るのは `choice` が必ず何かを返すからで、普通の値に閉じた世界は無い([19](19-jevlang.md#3-choice-に対する-else-腕は-gate-noul-を生やす)) |
| シナジーの機構を実装せず編成だけ変える | ピールや耐性が効かないと前衛はただの的で raw DPS が勝つ。効果は機構を入れて初めて測れる([11](11-synergy.md#2-チャンピオンに多様性を持たせる)) |
| リトライ無しのクライアントで API を叩きすぎる | レート制限で全 hold、対称ゲームが 350-350 で膠着する([11](11-synergy.md#1-相互キルの同時処理)) |
| ドラフトの良し悪しを 1 つの policy だけで判定する | scripted に弱い編成が Jev には強い。順位は policy 依存([12](12-comeback.md)) |
| 弱い基準で観測した「取り返し」を一般化する | 基準を上げると蒸発する。本当に弱い編成 classic は scripted に 5-1 → smart に 0-6([12](12-comeback.md#8-追記--強い-bot-を基準にすると取り返し幅は縮む)) |
| 依存グラフをプロンプトに載せる | 前提はコードの閉包が既に解いている。削減 68.6% → 66.3% でトークンは 1.3 倍([23](23-task-filter.md#5-グラフはプロンプトではなくコードに置く)) |
| glob の affected 判定だけでフィルタする | `a11y` の `@inputs` が `web/**` で変更が `packages/ui` にある類を落とす。15/15 → **14/15**([23](23-task-filter.md#2-グラフは要る--glob-だけでは不健全)) |
| 全タスクに同じ閾値を使う | 4 秒のタスクを飛ばして 4 秒節約し、**その変更で赤くなる唯一のチェック**を失う([23](23-task-filter.md#7-安いタスクに同じ閾値を使ってはいけない)) |
| 逃げ道の noul の閾値を 0.5 に決め打つ | 無害側の平均が 0.479 で、0.5 は谷ではなく山の上。0.4 なら検出 6/15 → 9/15 で副作用は増えない([23](23-task-filter.md#6-何も走らせないは別の-noul-にすると安全なゲートになる)) |
| 静的解析が既に正確なグラフにフィルタを足す | 扇形の無いリポジトリでは **glob だけが 6/6・80.2% 削って無料**。Jev は 65.9% で負ける([23 §12.3](23-task-filter.md#123-検出は-1818ただし-glob-だけの静的判定に負ける)) |
| 正解ラベルを規則で作る | 「ありそうな編集」15 個を実際に走らせたら **9 個は何も壊さなかった**。規則では書き漏らす(`report/` のシグネチャ変更が jevlang のテストを落とした)([23 §12.2](23-task-filter.md#122-一番の収穫--15-個のうち-9-個は何も壊さない)) |
| ビルドキャッシュのあるタスクの値段を順序を揃えずに測る | 先に走ったレシピが全員のコンパイルを払い、残りが **0.0 秒**に見える。合計 19 秒 対 cold 40.1 秒([23 §12.1](23-task-filter.md#121-何が変わったか--ラベルが規則から終了コードになった)) |
| 「テストが落ちない」と「何も変わらない」を同じ質問で聞く | 実測ラベルは前者・`_changes_behaviour` は後者。合成では一致するが実リポジトリでは **0.180 対 0.580** に開く([23 §12.5](23-task-filter.md#125-テストが落ちないと何も変わらないは別物)) |
| 当てはめた閾値の「誤検出 0」を成績として報告する | 負例の最大値の上に置いたのだから発火しない。ホールドアウトすると 1224 中 **24 件**([25 §2](25-thresholds.md#2-in-sample-の誤検出-0は情報がない)) |
| margin を「モデルの揺れ」から決める | 効く margin は draw sd の **20 倍**。閾値を壊すのは draw(0.37%)ではなく新しいコード(2.0%)([25 §4](25-thresholds.md#4-何が閾値を壊すのか--draw-かコーパスか)) |
| 均衡正解率(youden)で閾値を引く | 誤検出を払って再現率を買う置き方。held-out で 72 件発火した([25 §2](25-thresholds.md#2-in-sample-の誤検出-0は情報がない)) |
| コスト重み付けの効果を「判断なし」と比べずに報告する | 同じ損失モデル・同じグラフで score を基準率に潰すと、同じ検出で **81.4% 対 40.9%**([25 §5.3](25-thresholds.md#53-実測ラベルでの比較)) |
| ばらつき対策に信頼区間を作り込む | 閾値をまたぐ 7/240 組はどれも赤くならないタスク。**1 draw で足りる**([25 §7](25-thresholds.md#7-同じ-diff-を-10-回投げる23-11-の宿題)) |
| 植え込みバグのコーパスで校正した文を実コードに当てる | 出てくるのは**わざとそうしてあるコード**。19 指摘中 17 件がそれで、コーパスには「意図的な版」が 1 つも無かった([26 §2](26-repo-rules.md#2-19-件を全部読んだ)) |
| 低 confidence の指摘を「弱いから」畳む | 実コードでは**自信のある 5 件が 0/5、当たった 2 件が conf 0.29 / 0.19**。confidence は「文が当てはまるか」の確信([26 §3](26-repo-rules.md#3-confidence-は直すべきかではなく文が当てはまるか)) |
| 判断できない条件を note の例外に書く | 「これはテストのプローブである」は catch 節から見えない。**ブロックの中に証拠がある例外だけが効いた**([26 §5](26-repo-rules.md#5-文を書き直す--subject-を広げる--3-draft-測ってどれも直らなかった)) |
| ESLint の設定ブロックを足してルールが増えたと思う | オプションはマージされず**最後のブロックが勝つ**。`hooks/**` 用のブロックが他 7 ルールをそこから消していた([26 §7](26-repo-rules.md#7-設定の罠-3-つ)) |
| コメントを証拠にするルールでキャッシュを信じる | キーはノードのテキストで**コメントはノードの外**。直しても古い判定が残る([26 §7](26-repo-rules.md#7-設定の罠-3-つ)) |
| 測れる量の算術を判断に投げる | 「人を起こすか」は SLO の割合の算術。規則は **16/16・誤ページ 0**、Jev は誤ページ 6〜27([27 §3](27-otel-triage.md#3-severity--算術が完勝する)) |
| 観測データを「とりあえず全部」state に入れる | 5 分の窓が **16/16 で上限超過**。`log_flood` は 15,200 件のうち 107 件しか送られない([27 §6](27-otel-triage.md#6-全部送るの値段--16-窓すべてが上限に当たる)) |
| JSON のトークン数を 4 文字 = 1 トークンで見積もる | telemetry の JSON は **2.4 文字 = 1 トークン**。全窓で `max_tokens_exceeded`([27 §6](27-otel-triage.md#6-全部送るの値段--16-窓すべてが上限に当たる)) |
| 異常検知で「何も問題ない」を判断に期待する | 逃げ道を別 noul にしても健全な 18 窓で発火 **0〜4 件**。沈黙は算術にしか担保できない([27 §5](27-otel-triage.md#5-同じ件数の生ログをうるさい順に選ぶか均等に選ぶか)) |
| 「この範囲に無い」を判定するときに範囲を広げる | 文書全体を足すと omission が **1.84 → 0.57**。**文脈は答えの隠れ場所を与える**([28 §4](28-bilingual.md#4-文書全体を渡すと悪くなるそして機構が見える)) |
| 言語をまたぐ比較で生の数値 diff を使う | 英語 "one request" 対 日本語「1 リクエスト」。faithful な 20 対のうち **14 対を誤検出**([28 §1](28-bilingual.md#1-先に-diff-を書く)) |
| 候補が多いからと 1 問ずつ聞く | 答えは 99.8% 同じで**入力トークンが 2.4 倍**。幅を狭めて得るものは無い([29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ)) |
| 2 つの selector を重み 1 つで混ぜる | in-sample 0.42 がホールドアウトで **0.35** —— 単独の両方より悪い。当てた重みは fold 間で 0.00〜1.00 に振れる([29 §6](29-skill-select.md#6-重みを当てるな経路を書け)) |
| 「常に入れる」を description から読ませる | T0 の 2 行は正例の 21% で、description のどこにも書いていない。平均順位 74 件中 41〜53 位([29 §3](29-skill-select.md#3-方針は判断に聞くものではない)) |
| 候補プールを広げて選択を良くしようとする | curate されていない 387 件を足すと P@12 が 0.25 → 0.19。判断は正しく、`code-reviewer` はどこにでも当てはまる([30 §5](30-skill-pick.md#5-判断が好む-distractor-を読む)) |
| 前段(prefilter)を recall で評価する | recall 100% の「前段なし」が P@12 最下位。読むのは**ユーザーが読む 12 行**([30 §3](30-skill-pick.md#3-上げるべきは-recall-ではなかった)) |
| 語彙の重なりだけで候補を絞り切る | k をいくら増やしても recall は **85% で止まる** —— 欲しい行の 15% はプロジェクト文と語彙を共有していない([30 §2](30-skill-pick.md#2-無料の前段は何を残すか)) |
| 書いてあるブール式を「分解すれば良くなる」と思う | 組み立てて 30/38・そのまま聞いて 30/38 で**同点**。分解の値打ちは正解率ではなく理由が出ること([31 §2](31-orchestration.md#2-聞くか組み立てるか)) |
| choice の confidence で「該当なし」を拾う | 強制された選択と本物の選択は **AUC 0.601** —— ほぼ見分けられない。逃げ道は別の noul([31 §5b](31-orchestration.md#5b-逃げ道を外すと)) |
| choice の確率で「どれも駄目」を拾う | 確率は和が 1 なので、全滅のときも誰かが高い。gap −0.04・AUC 0.900 に対し、同じことを noul に聞くと gap 0.08・AUC 1.000([32 §5](32-repair.md#5-1-つの-choice-で全部の順序が出る)) |
| AUC 1.000 を見て閾値を作る | gap 0.03 に対して draw が平均 0.043 動く。**きれいに分かれた in-sample は分かれている証拠ではない**([32 §4](32-repair.md#4-直る候補が入っているか)) |
| 無料の基準線を「賢くないはず」と決めてかかる | 候補生成順がそのまま事前分布で、無作為 7.69 回に対し **3.00 回**。コードのコメントを測って訂正した([32 §2](32-repair.md#2-テスト実行回数)) |
| 「機械的な指標だから渡せば良くなる」と思う | ラベルを分けない指標はプロンプトでも分けない。トークン +69%・AUC −0.02・`risk` は 89% → 85%([33 §2](33-review.md#2-4-通りのレビュー)) |
| diff が小さいことを安全の証拠にする | `add-return` は 5/5 間違えて全部「安全」。1 行足すだけで関数がそこで戻る([33 §4](33-review.md#4-どこで間違えるか)) |
| 当てはめた閾値の数字をそのまま報告する | penalty 100 で当てはめ 1.81(「常に haiku」2.89 に大勝に見える)、**ホールドアウトでは 3.54 で何もしないより悪い**。4 arm 全部([36 §5.4](36-routers.md#54-コストの梯子--当てはめは何もしないに負ける)) |
| router を作る前に「分かれるか」を測らない | 53 題材のうち **52 が一番安い段で足りた**。router の平均 tier は 0.99 = sonnet で、その通り routing すると 3 倍払って同じ結果([36 §5.1](36-routers.md#51-まず基準率そこで-corpus-が落ちた)) |
| 正例の少ない corpus の AUC を読む | 正例 1 件では**入力が全題材で同一な arm が最高の AUC 0.740** を出す([36 §5.3](36-routers.md#53-分離は測れない--正例が-1-件しか無い)) |
| 「この手はどうでもいい」を confidence が言うと思う | どの手も結果を変えられないゲームでも `doubt` 0.418。**実測レンジは 0.42〜0.77 で下側が丸ごと無い**([35 §1.1](35-tension.md#11-doubt-には床がある)) |
| confidence が合っているから中身も合っていると思う | 反転ルールの盤で**着手は 81% 正しいのに**、confidence は**反転前**の criticality を +0.81 で追う([35 §3](35-tension.md#3-一番はっきりした結果-盤の絵が書かれた規則に勝つ)) |
| ベースラインのサマリ行を見て動いていると思う | 「500 ターン・却下 0 件」の裏で `west east west east` を 400 回。**1 手ずつのトレースでしか見えない**([34 §0](34-roguelike.md#0-harness--本物を動かす)) |
| 却下率(不正な手の少なさ)が低いのを「上手い」と読む | `jev` は却下 3% で地図化 48、`jevmemo` は却下 19% で**地図化 152**。**低い却下率は「動いていない」でもあり得る**([34 §2.4](34-roguelike.md#24-記憶を渡すと探索する却下率と引き換えに)) |
| ベースラインに与えた道具を判断側に与えずに比べる | 探索ボットには訪問済み集合と目標を持たせ、判断側には記憶ゼロ。**「方針が無い」は大部分が交絡だった**([34 §2.4](34-roguelike.md#24-記憶を渡すと探索する却下率と引き換えに)) |

## レポート

| # | 内容 | 状態 |
| --- | --- | --- |
| [practice](practice.md) | **実践ガイド** — 使うときに順番に決めること | 📘 |
| [findings](findings.md) | **実験ごとに何がわかったか** — 1 本 = 1 ブロック | 📘 |
| [summary](summary.md) | **やったこと / わかったこと**の要約(ブログ用) | 📘 |
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
| [16](16-eslint-oracle.md) | コードと ESLint ルールの評価基準だけ渡して、実装を伏せたまま合否を当てさせる | ✅ |
| [17](17-task-picker.md) | タスクランナーの大量のタスクから正しいものを選べるか(提案 J の検証) | ✅ |
| [18](18-permission-hook.md) | Claude Code の `PreToolUse` hook として実装する(提案 C の検証) | ✅ |
| [19](19-jevlang.md) | jevlang — 条件が Jev の判断である小さな言語(JS 版 / MoonBit 版) | ✅ |
| [20](20-jevdsl.md) | jevdsl — MoonBit から `match` できる薄いラッパー(設計ノート) | 📝 |
| [21](21-eslint-plugin-jev.md) | eslint-plugin-jev — 判定を Jev がやる ESLint プラグイン(関数ごとの score、ファイル単位でバッチ) | ✅ |
| [22](22-code-criteria.md) | 具体的な「良いコード」の指標を名前で聞く + 穴の深さ(追記:保留セットの作り直しと leave-one-criterion-out) | ✅ |
| [23](23-task-filter.md) | タスク/テストランナーの filter(`just` の依存グラフ + タスクごとの `score`) | ✅ |
| [24](24-adhoc-rules.md) | まだ存在しないルールを自然言語で書く — セレクタだけコードで書き、述語は 1 文 | ✅ |
| [25](25-thresholds.md) | 閾値を当てはめる部品(質問ごと・ホールドアウト・draw・コスト重み付け) | ✅ |
| [26](26-repo-rules.md) | 実リポジトリで `jev/rule` を走らせる — 散文の規約を自分のコード 9,315 行に当てる | ✅ |
| [27](27-otel-triage.md) | otel の異常検知のトリアージ(検知はコード・severity は算術・cause は判断) | ✅ |
| [28](28-bilingual.md) | 英語と日本語が同じことを言っているか(実物の対訳 + 8 種の変異) | ✅ |
| [29](29-skill-select.md) | コンテキストに入らない skill カタログから選ぶ(mizchi/skills の実物 98 行 + 7 arm) | ✅ |
| [30](30-skill-pick.md) | 461 個の実在 skill から選ぶ道具 — 何が入るか、前段は何を買うか、評価ループ | ✅ |
| [31](31-orchestration.md) | 文書化されたゲート(multi-agent-orchestration)は聞く方が良いのか組み立てる方が良いのか | ✅ |
| [32](32-repair.md) | パッチはコードが作り、判断は並べるだけの修復ループ(ラベルは `node --test` の終了コード) | ✅ |
| [33](33-review.md) | 機械的な指標を渡すとレビューは良くなるのか(261 件の 1 行 diff + similarity-ts) | ✅ |
| [34](34-roguelike.md) | 本物の NetHack 3.6.7 を tmux で駆動する — 80×24 の AA 画面を読めるのか、遊べるのか(記憶を渡す arm 追記) | ✅ |
| [35](35-tension.md) | ゲームの面白さは confidence の変動に出るのか(完全に解けるゲーム 5 種で照合) | ✅ |
| [36](36-routers.md) | model router と skill router — スタンドアロン + pi plugin([`packages/`](../packages/))。**この corpus では model router は元が取れない**(正例 1/53) | ✅ |
| [37](37-hermes.md) | 常駐 hermes agent — 5 つの jev コンポーネントを 1 つの pi 拡張に。**束ねるのは無料ではなかった**(7/7 が draw ノイズ超え)、逃げ道の閾値が答えの塊の真ん中にあった | ✅ |
| [38](38-agent.md) | 実物の pi 0.85.1 の中で動かす — **動く**(18 turn、**5/5 が配線で確認**)。**バグ 4 件**(skill router は一度も skill を見ていなかった / 選んだ skill が 1 ターン遅れ / compaction の閾値と目標が別スケール / pi の拡張設定は flag だけで README は fiction)と、control arm がリポジトリを消した話 | ✅ |
| [39](39-compact-ranking.md) | 削除の順序は無料の順序と要約に勝つのか — **勝つ、が自分の主張 2 つが壊れた**。判断 96〜100% 対 `oldest`/`largest`/`stale` 11〜78% は差が大きすぎ、疑ったら**判断がしていたのはタスクの作業と周りの探索の分離**(平均 AUC 0.751)で、**ゴールとの語の重なり**という無料の順序が 67〜100%。残る差は**厳しい予算だけ**(25% で +18)。要約(抽出的)にも勝つが理由が違い、**要約は予算を全エントリに配るから**。そして「要約は黙って事実を失う」の**切断側は反証**(108 回で 0 件)—— 最初の測り方は 11〜33% と出していて壊れていた | ✅ |
| [40](40-homework.md) | 宿題 4 件(a / b / c / f)を片付ける — **記憶だけの arm とゴール文だけの arm**は**どちらでもなかった**(訪問回数だけ −6、ゴール文だけ −12、両方で **+60**、exact p = 0.042 —— 効果は全部が交互作用)。`jevmemo` の却下率は**宿題の前提が間違っていた**(位置は記録に無い)が、答えはもっと良かった —— **プロンプトの矛盾**で **memory が壁を推薦していた**。`tension` の `swing` は**順位が動く**が、止めるのが間違いで**隣接 4 組のうち両方の尺度で分離しているのは 0 組** = [35 §1](35-tension.md) の順位はそのコーパスでは未確立。union state の並べ方は **10 個の答えのうち 9 個が繰り返しノイズより大きく動く**が**topology の決定は 8 件すべて不変**で出荷形が一番安い | ✅ |
| [41](41-versus.md) | jev と本物のモデル(haiku / sonnet)を同じラベル付きコーパスで比べる — **精度は互角**(guard 96% で sonnet と同点、haiku 88%。orchestration は 58/58/61%)、**速度はタスクごとに 26〜61 倍**(guard 151 ms 対 7,337/9,244、orchestration 287 ms 対 7,353/9,846)。**⚠️ 訂正あり**: 「24 件中 6 件で棄権」は棄権ではありませんでした —— [42 §4](42-versus-rest.md) が 120 回聞いて `permission` score の欠けは **0 回**、`verdict: null` は `allowSafe: false` が **ALLOW を意図的に黙らせている**だけ。精度の数字は変わりません。**速度の倍率は直しました**(元の「30〜37 倍」は jev 側に guard だけの中央値、モデル側に 2 タスク混ぜた中央値を当てた比でした)。そして**組み合わせの品質は測れていない**([37 §6](37-hermes.md) が「束ねるのは無料ではない」) | ✅ |
| [42](42-versus-rest.md) | 残り 3 コンポーネントも本物のモデルと比べる([06](06-ideas.md) 宿題 n)＋**捏造の測定**(宿題 i)＋**guard の「棄権」の正体**(宿題 m) — **一貫しているのは速度だけ**(5 コンポーネントすべてで **26〜103 倍**)、**品質で jev が明確に勝っている列は無い**。**compactor**: jev は 8/8 で予算を満たし事実 100%、`select` は事実 100% だが**予算超過 3/8・2/8**(圧縮を断った)、`summarise` は予算を **17 倍**行き過ぎて事実を落とす。**捏造は 32 回で 0 件** —— ただし**自分の測り方の誤りを 2 回見つけた後**。**model router**: **誰も無料の `always-haiku` を超えない** —— 3 者が 42/53 で同じ段を選び 41 件がラベルより上、**どのアームも唯一の難問を見ていない**(最良 AUC 0.663、厳密 p = 0.358)。ラベルは 1 ドロー。**skill router**: **3 者とも分離せず**(最小 p = 0.125)、sonnet の precision +9pt は 14 件中 2 件に乗って p = 0.500。**そしてここでは値段も jev が 4 倍高い**。**guard の「棄権」は棄権ではない**(`allowSafe: false` が ALLOW を黙らせていただけ) | ✅ |
| [43](43-finish.md) | **エージェントは仕事を終えられるのか** —— [41 §0](41-versus.md) から [42 §5](42-versus-rest.md) まで全部が「pi 側にモデルが無いので測れない」と書いてきた穴。事実は本当で結論が間違っていた: `claude -p` は本物のツールを持つ本物のエージェントで、Claude Code は hook seam を公開している。**186 の本物のエージェント実行**、判定は `node --test` の終了コードのみ。**seam を CLI の実体で確認したら 5 つのうち 4 つが配線可能**(compactor だけ不可 —— `PreCompact` は中断か要約指示の書き換えだけで、あれの設計は「削除する、要約しない」)。**⚠️ この 4/5 は後で 5/5 に訂正されました** —— [44 §5](44-components.md) が同じバイナリから読み直したら seam は 2 つ在り、**`PostCompact` が要約そのものを渡してくる**([43 §0](43-finish.md) に訂正を追記済み)。**[18 §1](18-permission-hook.md) の 2,500 ms 予算に 40 本ぶん遅れて数字が付いた**: 391 ゲート済みコマンドで中央値 **371 ms**、p99 568、**超過 0 件**(出荷配線、コマンドごとに node 起動込み)。修理コーパスでは **gate は完遂を 1 件も奪わない**(63/63 対 63/63、p = 1.000)が、**gate は 978 コマンド中 12 件しか発言せず、その 12 件すべてが正当な作業に必要だったもの**。境界コーパス(**私が書いた 5 件**)で初めて **gate が仕事を奪う実例**が出た —— そして発見は「判断が誤った」ではない: `rm -rf ./node_modules` は [01](01-shell-risk.md) 自身のコーパスで `confirm`。**gate は自分のラベルどおり正しく振る舞い、確認する人間が居ないのでその正しさが仕事を奪った**。`jev-guard` は docs/18 から `attended`/`unattendedAsk` を持っていて**出荷 hook が公開していなかった** —— `--unattended-ask block\|defer` で塞いだ。**`ask` の理由がモデルに届いていなかった**のも直した(contract は省けと言っていない)。そして**ブロックされるかどうかはコマンドの性質ではなくドロー**(同一タスク 3 反復で ask が 3→1→0) | ✅ |
| [44](44-components.md) | **残り 3 コンポーネントを本物のエージェントの中で**([TODO §1.1](../TODO.md)) —— そして**「100%」が計器の数字だった話**。アームを書く前に `src/probe.ts` で「そのコンポーネントに決めることが在るのか」を58 タスク・エージェント抜きで聞いたら、**書こうとしていたアームが何も測らない**と分かった: [32](32-repair.md)/[36](36-routers.md) の修理タスクは **53 件が 1 本のプロンプトを共有している**ので、リクエストについて聞くルータは同一の質問を 53 回聞かれる(実際 **58/58 が sonnet の 1 段**)。そこで探していなかったものが 2 つ出た。**(1) 出荷の `minConfidence: 0.5` が自分の tier 判断を上書きする** —— score が haiku と言ったのは 22/58、haiku になったのは 8 件で、**14 件は confidence 床が sonnet に留めた**。confidence の分布は**丸ごと床の下**(中央値 0.44、最大 0.76 → **67% に効く**)で、効く方向は常に高い方。[25](25-thresholds.md) の主題が [37](37-hermes.md) の `escalateAt` の隣で再発。**(2) 実際のテスト失敗を見せると仕事が小さく見える** —— 57/58 で tier score が下がり、平均 0.46。そして**同一リクエスト 53 ドローの sd は 0.006** なので(修理コーパスがプロンプトを共有しているおかげで無料で手に入った)この差は**ドローの 82 倍**。**orchestration gate は配線されて一度も発言しない** —— `Task` を許可してもエージェントが委譲を試みず、gate 側も 58/58 で拒否する(平均 0.15、cutoff 0.50)ので、**全員が一致した測定に情報が無い**。だから veto は合成 `Task` イベントで **wire で確認**した。**skill router は 9 リポジトリから採った 300 件**でやった —— このプログラムで**私が書いていない最初のコーパス**。**端から端までの結果**: 完遂は 3 コンポーネントとも天井(96 run で 32/32・32/32・32/32、不一致ペア 0 組)なので対になったコストで測り直すと、**model router 側は tool call で分離する** —— 高い段は同じ仕事を**中央値 −2 call、29/32 タスクで少なく**終える(**p < 0.001**)。壁時計は `sonnet` で有意(p = 0.020)だが `routerfail` は **p = 0.050 で線の上**なので、**主張できるのはターンだけ**。ルータは sonnet 30 / haiku 2 を選んで tier list 価格で **2.9 倍** —— **買ったのは完遂ではなくターン**。そしてこれが `minConfidence` の発見を裏返す: 「床が高すぎて無駄に払っている」と書きかけたが、**高い方向は有意に少ないターンを買っていた**ので、言えるのは「**この数が決定の大半をしていて、置いたときに答えがどこに来るかを誰も見ていなかった**」だけ。**skill router** は 63 run で完遂 21/21、カタログの値段は正確で前払い(**90,003 文字 ≈ 23k トークン**) —— `allskills` の tool call は `haiku` に対し **11 対 3、中央値 +1.0、p = 0.057** で**線を越えないので結果ではない**(持ち帰るべきは方向、決着は反復数)。ルータが払うのは中央値 **10,482 入力トークン(jev)と 394 ms**、避けるのは生成モデルの **~22k** —— **値段の議論としては成立し、品質の測定としては分離しない**。そして本題: 新アームが全部 100% で返ってきたので計器を見たら、**`passed` は `node --test` の終了コードで、assertion を書き換えたエージェントも 0 を返す** —— 両プロンプトが `Do not modify any test file.` と言っているのに **186 run ぶん誰も確認していなかった**。`Run.testsIntact` で塞ぎ、**コードを読むのではなく走らせて**確認した(本物のタスクのテストを潰し、`node --test` が PASS になることを確認し、スナップショット比較が捕まえることを確認する)。**そして [43](43-finish.md) の 186 run を掃き直した** —— **改竄 0/186**([44](44-components.md) 自身の 3 掃きも 0/179)。元の 186 行は今も採点できない(サンドボックスが消えている)が、**ledger は Bash を逐語で持っているので半分は遡及的に言える**: **978 コマンド中 `test/` へのシェル書き込み 0 件**、残る穴は **path を記録していない Edit/Write 215 件**。**そして掃き直しは [43](43-finish.md) 初の追試になった**(あそこの主張は全部 1 ドローだった) —— **再現**: レイテンシ中央値 **371 → 372 ms**、2,500 ms 予算超過 **0 → 0**、easy の完遂 63/63 → 63/63、**gate が発言したタスクは同じ 2 件**。**再現せず**: [43 §4b](43-finish.md) の**「gate が初めて仕事を奪った」1 件**(`guard` 14/15 → **15/15**、ask 率 5.3% → **0.9%**) —— **存在証明としては立つが率としては立たない**。そこから「**この gate はコマンドの X% を止める**」は成立せず「**これらのコマンドについて意見を持ち、あれらについては持たない**」は成立すると分かった: **どのタスクで発言するかは完全に再現し、何回発言するかは再現しない**。**そして [TODO §1.2](../TODO.md) の `--unattended-ask block` と [§2.4](../TODO.md) の分散も閉じた**: `block` は wire で `deny` ×5(既定は `ask` ×5)、アームは境界 15 run で **3 介入すべて deny・3 回すべて回復**。全掃きの境界 run **135 件**を束ねると **22 介入・17 run・16/17 完遂**で、**唯一の失敗は既定の `ask`**(ホストが誰も選んでいない文面で拒否する経路)の下 —— ただし**小さい分母の null 結果**。そして「gate が発言するとターンが増える」には交絡が在り、`bare` と同じタスクで比べると **hook の存在はターンを食わず**(沈黙 ≤ `bare`)、**破壊的ルートが食い**(13 対 11)、その上で**発言されると数ターン増える**。分散は **220 コマンド × 7 ドロー = 1,540 コール**で測った: **218/220 が全ドロー同一**、**意見を持つ 5 件のうち 3 件が毎回同じで 2 件が跨ぐ** —— **gate は大半について決定的で境界では本当に迷っている**([25](25-thresholds.md) の予測どおり)。**この測定は 2 回、記録と食い違い 2 回とも私のバグ** —— 空のサンドボックス、それから `cwd` を `tool_input` の中に入れたこと(hook は `event.cwd ?? process.cwd()` を見る)で、**3 回目の「ハーネスが判断に世界について嘘をついた」**。**そして [TODO §1.3](../TODO.md) の compactor も閉じた** —— [43 §0](43-finish.md) は「seam が無い」と書いたが、**バイナリから読むと 2 つ在り**、**`PostCompact` が要約そのものを渡してくる**(下流から推定する必要が無い)。`claude -p "/compact" --resume <sid>` で無人駆動もできる。**これは jev の部品ではなくホストの要約器の評価**(`jev-compact` はこの seam に入れない)。**答え: 指示の書き換えは事実の生存を上げない** —— `plain` 67%、`instructed` 78%、**`plainagain`(`plain` をもう 1 回)も 78%**。不一致は `plain` 対 `instructed` が 1/8 で **`plain` 対 `plain` 自身も 1/8(同じ transcript)**なので、**要約器のドローが指示の効果と同じ幅**で n = 8 では**測定不能** —— アーム 1 つ足すだけでヘッジが数字になった。**本当の発見は baseline**: 同じ 9 事実・同じ judge で `jev-compact`(削除)と select 系が 9/9、[42](42-versus-rest.md) の `summarise`(**予算内**)が 78〜89%、**ホストの要約器(予算なし)が 67〜78%** —— **どのアームより落とす**。**だから損失は圧縮圧ではなく、要約器が何についての文章かを選んだ結果**。そして **judge が正しい答えを 2 度目に間違えた** —— window check は言い換えを許すが**書式**を許さず、`30,130` を `30130` と照合できずに**捏造と報告した**。1 行で直し、**[42](42-versus-rest.md) の記録を再採点したら 40 行中 0 行が変わった**ので、あそこの数字はそのまま立つ。**そして [TODO §3.1](../TODO.md)/[§3.2](../TODO.md) の計器の借金も返した** —— 出荷 hook の `--log` は `answers` 全体を書いていて `readVerdicts` は 3 フィールドしか取っていなかったので、[43 §4](43-finish.md) のスコア分布は**再質問**から作るしかなかった(別のドロー)。直して **run 中のスコアが 391 コマンド**(中央値 0.05、p99 0.31、**最大 0.59**)、そして `from_score` と `from_atoms` の**食い違いが 391 中 2 件**と分かった(古い 3 フィールドでは区別不能)。**債務の値段も測った**: 同じ 221 コマンドで**対になった差の中央値 0.020**、**[01](01-shell-risk.md) の 0.36 の反対側に落ちたのは 0 件** —— **だから [43 §4.3](43-finish.md) の結論は再質問に依存していない**。**ただし極値は再質問のもの**で、[43](43-finish.md) が引く最大 0.70 に対し**run 側は 0.59**(訂正を追記した)。**cwd は記録するようにした**(`gate.mjs` がイベントの値を書き、`cwdRecorded` で報告値と推測値を区別 —— [43 §4.4](43-finish.md) の捏造 cwd が無害な `rm` 4 件を停止に変えた件が理由)。新しい掃きでは **226/226 が記録された cwd** | ✅ |

| [45](45-floor.md) | **ラベルの無い閾値を値段で語る、設計を部品より先に否定する**([TODO §1.4](../TODO.md)/[§1.5](../TODO.md))。**§1.4: 出荷の `minConfidence: 0.5` を動かすべきか。答えは「正しさのラベルが存在しない」** —— haiku 32/32・sonnet 32/32 なので `advise()` が `no-signal`(片方のクラスが空)を返す。[25](25-thresholds.md) の `crossValidate` はラベルに閾値を当てる道具なので、**定数のラベルは何も順序づけない**。そこで存在するラベル(**対になった実測コスト**)で値段を付け直した: haiku は 32 件中 28 件で tool call が多く(p < 0.001)、**床は 32 件中 8 件で効き、その 8 件全部で haiku の方が高い**。**そしてその綺麗な読みを基準率に当てた** —— haiku はコーパスの 88% で高いので、**任意の 8 件でも 8/8 は約 34% 起きる**。**8/8 は床が選別している証拠にならない**([44 §1.2c](44-components.md) は同じ罠に 2 回はまった)。**床の全値に値段**: 外すと haiku 2 → 10/32、tier list 価格 92 → 76(**17% 安い**)、tool call 200 → 220、**完遂は 32/32 で不変**。**ダイヤルは 9 段しか無く**、生きた範囲は 0.32..0.69 で**出荷値 0.5 はその真ん中**([44 §1.2b](44-components.md) の裏返し)。コストのラベルで当てはめると **AUC 0.446**(0.5 未満なのでごくわずかに逆)で、**fold ごとの閾値 0.59..0.70 が最高 confidence 0.69 より上に来る** —— **「安い段が勝つ場所を見つけよ」と言われた当てはめが、線をデータの上に置いた**ので適合率が 0/0。正解率だけが 87.5% に見えるのは **32 件中 28 件が陰性**だから([33](33-review.md) の「何も言わないが 76.5%」)。→ **床は値段とレイテンシのダイヤルで、正しさのダイヤルではない。「この証拠では動かすな」で閉じる。****§1.5: 要約器の前に「これは測定値か」を聞く価値は在るか。**まず**候補 1 が配線で死んだ** —— 同じバイナリの hook 実行部を読むと `PreCompact` は `{ newCustomInstructions: <hook の stdout> }` を返すのに **`PostCompact` は `{ userDisplayMessage }` だけ**で、渡された要約はもう確定している。**差し替えは不可能**(バイナリ 1 回で候補が無料で退場)。残る候補 2 を**上限として**測った —— **`oracle` アームは正解の文字列そのものを渡す**ので、分類器が原理的に超えられない天井であり、**これは jev の測定ではなく「ここで jev を測る価値が在るか」の測定**。結果は **9/9・捏造 0 で天井に到達**(`plain` 6/9、`plainagain` 7/9、`instructed` 7/9)、`plain` が落とした 3 件全部を回収。**不一致 3 組の厳密符号検定は p = 0.250 で 100% の隣に印字してある**(飽和したアームは、対の数が隣に無いと決定的に読める)。→ **逐語のリストは従われ、[44 §5.2](44-components.md) の一般的な規則は従われなかった** —— **`custom_instructions` は運ぶものが逐語なら助言 channel ではない。機構は確認、部品は未測定。** | ✅ |
| [46](46-relevance.md) | **問いが間違っていた**([TODO §1.6](../TODO.md))—— [45 §2](45-floor.md) が「測定値を逐語で渡せば 9/9 で残る」を確かめたので残りは「**jev がどのエントリに測定値が入っているか当てられるか**」だけ、と書いた翌日に、**その問いが正しくあり得ないと分かった。しかもリクエスト 0 件で**。9 件の植えた事実のうち **3 件は数字を 1 文字も含まず**(`registerFlag("jev-advise"`、`registerFlag("jev-framing"`、`id: "orchestrate-turn"`)、**4 件はコマンドが計算した量ではなくコマンドが表示したソーステキスト**。だから「数字を含むか」の完璧な分類器の上限は **6/9** —— **何も指示を送らない `plain` が既に 6/9**。**完璧に答えても何もしないのに勝てない問い**だった。**[24 §2](24-adhoc-rules.md) の順序がこれで 3 回目だが、アームではなく問いを否定したのは初めて**。**`oracle` が勝っていたのは測定値を見抜いたからではなく、ゴールが訊いている値を渡したから** —— `registerFlag("jev-advise"` は測定値ではなく「どのフラグを登録するか」という問いの答え。**ゴール関連性と測定値性は別の述語**で、設計が要るのは前者([39](39-compact-ranking.md) の「判断がしていたのは作業と周辺探索の分離だった」の再来)。そちらにはラベルが在る(`facts[].entryId`)し、**[39](39-compact-ranking.md) の `ranking.json` に 8 transcript × 5 反復の per-entry 判断が既に在る** —— **削除ランキングはゴール関連性の順序そのもの**なので、ここもリクエスト 0 件。結果は **jev が答えを 1 位に 14/40・上位 5 位に 31/40・中央順位 2**(候補 ~56 件)に対し、**無料の `overlap` が 15/40・30/40・中央 3** で、**対になって 3 対 4(1 同値)の p = 1.000** —— **分離しない**([42](42-versus-rest.md) の形が 5 つ目のコンポーネントに来た)。**§1.6 自身の述語(`digits`)は表で一番弱い**(0/40、中央 14.5)—— tool エントリの 93% が数字を含むので順序がほぼ任意。**そして同点を「どちらでも動く」と読んではいけない** —— `overlap` が 1 位を取るのは**ゴールが対象を名指しているとき**だけ(`dropat`、`flags`、`scenarios`)で、**比較型のゴールでは落ちる**(`longest` 4 位・`most` 6 位・リンク数 18 位)。比較の答えは**ゴールが名指せない数字**だから。しかも `longest-doc` の 4 位は **62 件中 57 件が 0 語の野原でストップワード `and` 1 個**を共有した結果で、信号ではない。→ **出荷できるのは「識別子型のゴールに対する無料アーム」で、compaction の前段が一番欲しい比較型ではどちらも確立していない。**ハーネスのバグ 2 件はどちらも**もっともらしい表**を出した: `overlap` と `largest` の行がバイト単位で同一になったのは、候補集合(**pin されたゴールのターンを除外している**)に制限してからランク付けしたので `rankBy("overlap")` が自分の契約どおり `largest` にフォールバックしていたから。入れた検査が次に `stale == oldest` で throw したが**こちらは本物の性質**(どのコマンドも直前に宣言され二度と参照されない)で、**[39](39-compact-ranking.md) 自身の表が 4 予算のうち 2 つでバイト単位で同一の行を出していてそう書いていない**。検査は全 transcript で同一のときだけ throw に直した。**そして最初に書いたテストは空振りだった** —— 末尾を除外してゴールを残したのでフォールバックが発火せず、バグを戻してもテストが通った(直して、戻して落ちることを確認した) | ✅ |
| [47](47-stages.md) | **段が 3 つ在って、判断は真ん中に在った**([TODO §1.7](../TODO.md))—— [46 §3.1](46-relevance.md) が「比較型のゴールではどちらのアームも確立していない」で残した半分。**§1.7 は閉じ方の候補 3 つのうち前 2 つを疑っていて、両方とも間違っていた —— 反対方向に**。**候補 1(型でラベルする)は「実行可能な述語ではなく私の分類」と書かれていたが、実行可能だった** —— **超級表現がゴール文に在るかの正規表現 1 本**で、答えにも答えのエントリにも当てないので循環しない(テストで固定してある)。**8 件中 4 件が当たり、[46 §3.1](46-relevance.md) が手で選んだ 4 件とちょうど同じ**。だから**ゴールの型はリクエストの性質**で、**前段は何かを払う前に分岐できる**。超級側の中央順位は `overlap` 5・jev 9、平叙側は 1・1.5。**候補 2(順位付けではなく集約)は「前段が 2 段になる」と書かれていたが、3 段だった** —— 「候補は既に絞られているとして」が全部の仕事をしていた。無料の絞り込み 2 通り(同形の最大群 / ゴール重なりで加重)は**どちらも 1/4** で、**選ぶ群が一致するのは 4 件中 1 件**。**全部の miss が同じ形: 正しい「形」を間違った「コマンド」から** —— `longest-doc` は形 `N P` が docs の `wc` と `experiments/` の `wc` をプールし、`findings-links` は `wc -l` の総計を取り、`most-tests` は `ls -l` のブロック数を取る。唯一の HIT は**コーパスがヒューリスティクスに同意しただけ**。→ **段は 検出(無料・完全一致)/ 絞り込み(ここが判断)/ 集約(無料の算術)の 3 つで、§1.7 は判断を間違った段に置いていた**。**段 2 を測ると、この掃討で初めて jev が無料に明確に勝った** —— **7/8**(超級 3/4、平叙 4/4)に対し無料のラベル重なりが 3/8、最大の群が 3/8。形がその理由で、**transcript は自分の出力をコマンドで既にグループ化しているので、56 件の不透明なエントリの順位付けではなく 10 個ほどのラベル付き候補の `choice`** になる([01](01-shell-risk.md) の形)—— つまり [46](46-relevance.md) の p = 1.000 は**問いの形が悪かった**のであって**コンポーネントが弱い証拠ではなかった**。ただし 8 行。**段 3 は正しい群を渡しても 2/4** で、**2 件の miss は同じもの**(`26453 total` と `62910 total` —— `wc` と `du` は総計を印字し、総計は構成上どの要素より大きい)。**総計行を除くと 3/4 だが、この 4 行を見てから選んだ 1 行**なので([summary.md](summary.md) の教訓 8)**持ち越すのは 2/4**、3/4 は失敗の値段として併記。**そして合成すると端から端まで 1/4** —— 段の点数は掛け算にならず、`longest-doc`/`biggest-source` は段 2 を通って段 3 で同じ行に落ち、`findings-links` は段 2 で落ちる。**当てはめた修正を入れてもまだ外す 1 件が一番鋭い**: `longest-doc` の `wc` 群は**2 つの引数集合**(レポートと `experiments/`)を覆っていて、ゴールは片方に制限している —— **植えた答えはゴールの範囲内での最大で、全体では 2 番目**。**コマンド群は正しく、それでも粗すぎる** → **段 2 には下位段が在る: コマンドで、かつ引数の範囲でグループ化する**(位置づけただけ、測っていない)。自分のバグ 2 件: `leadingNumber` が行のどこの数字でも拾って段 3 を 1/4 に見せていた(`ok  a 60-skill shortlist` が 60、`* 24,000,000` が 2,400 万)ので、**`--show` は段 3 を記録から読まずに corpus から再計算する**ようにした。もう 1 件は**docblock の中の裸の正規表現が `*/` でブロックコメントを早期終了**させた | ✅ |
| [48](48-keep.md) | **値を「見つける」必要は無かった ——「落とさない」だけでよかった**([TODO §1.8](../TODO.md))。[47](47-stages.md) の 3 段(検出 / 絞り込み / 集約)は端から端まで **1/4** で、§3.3 が残りの失敗を絞り込みに位置づけた(`wc` 群が 2 つの引数集合を覆っていてゴールは片方に制限している)。§1.8 は細かく切る方法 2 つと**出口 1 つ**を挙げていて、**出口が答えだった —— 段を足すのではなく外す**。**前段の仕事は値を「見つける」ことではなく「落とさない」こと**なので、選んだ群の**数値行を全部**逐語で渡し、どれが答えかは決めない。**すると `wc experiments` が混ざっていても構わない** —— 9 行ではなく 44 行を残すだけで答えは中に在る。群を丸ごと残すのは無理(`read` 群は **95,794 文字**で transcript のほとんど)だが、**数値行だけなら 119〜1,630 文字**。アームは 2 本 —— `keepnums` が jev 自身の段 2 の選択(パイプライン)、`keepnumsmax` が答えの在る群(天井)。`plain` はコーパス全体で 6/9 だがこのアームが走れる行はランダムな半分ではないので**同じ 5 行で対にして**比較すると: `plain` 3/5・`plainagain` 4/5・`instructed` 4/5・**`oracle` 5/5**・**`keepnums` 4/4(5 行中 4 行で走行)**・**`keepnumsmax` 5/5**。**`keepnumsmax` が oracle と同点で、しかもどれが答えかを教えられずに同点** —— **つまり [47](47-stages.md) が 2/4 と測った集約段はクリティカルパスに無く、§1.8 の引数範囲の問いは存在しなくてよい段についての問いだった**。**担っているのは 1 行**: `findings-links` は `oracle` と `keepnumsmax` だけが残し、`plain`/`plainagain`/`instructed` は**全部 0** なので[44 §5.2](44-components.md) のドローではない(他の行はドローの中)。**端から端まで超級 4 件で 3/4**([47](47-stages.md) の 1/4 に対して)—— **段を足さずに外したら 3 倍**。**希釈の対照実験も無料で付いてきた**: `dropat-default` は超級でないので残した数値行に答えが入っていないのに**答えは残った**(1/1)—— 的外れな値を残すことが的を射た値を犠牲にしなかった。形として見ると **`keepnums` がしているのは [39](39-compact-ranking.md) の `jev-compact`(選ばずに残す)に近く**、[43 §0](43-finish.md) は「`jev-compact` はこの seam に入れない」と書いたが**設計思想は指示 channel を通れた**。ただし **`keepnums` は段 2 が数値行の無い群を選ぶと走れず、それは間違った答えではなく沈黙**(呼び出し側は既定の要約を受け取り信号を受け取らない)で、**「1/4 が 3/4 になった」より悪い性質**。そして**「段を外したら良くなった」を一般則にしてはいけない** —— 外せたのは**この問いが「落とさない」で足りた**からで、要約に 1 行だけ書きたいなら集約は必要なまま。**言えるのは「どちらで足りるかを先に問え」**。5 事実 | ✅ |
| [49](49-scripts.md) | **私が書いていないコーパスでは、gate は 20 倍うるさい**([TODO §2.1](../TODO.md))—— **プログラム最古の限界**。[31](31-orchestration.md) の限界節と [43 §3](43-finish.md) が同じことを言っていた(自分が書いたシナリオは自分のシナリオ作文を測る)。§2.1 の候補 3(実在の npm script を機械的に集める)を実行 —— **ディスクに在った**: どの `node_modules` の `package.json` にも公開した人が書いた `scripts` ブロックが在る。**354 パッケージ・2,706 エントリ・重複を除いて 568 コマンド**(`@smithy` の 40 パッケージがバイト単位で同一の `stage-release` を積んでいるので重複除去は飾りではない)。npm script だけ —— ディスクには Makefile 2・justfile 2・シェルスクリプト 6 しか無く、**ソースは「選んだもの」ではなく「届いたもの」**。**結果は gate に不利**: **568 件中 137 件(24.1%)で発言**(コピー重み付けで 2,706 中 694 = 25.6%)。[43](43-finish.md) は**私のコーパスで 978 件中 12 件(1.2%)** —— **私が書いていないコーパスは gate を 20 倍うるさくする**。score 中央値も **0.31**([43](43-finish.md) の run 中 0.05 の 6 倍)、最大 1.88、**568 件中 136 件が出荷 cutoff 0.50 に届く**。`./scripts/build` が **0.94**、`biome format --write` が 0.87、`cat lcov.info | coveralls` が 0.83 —— gate が反応しているのは**不透明さと副作用**で、**エージェントのサンドボックスでは稀だが実在のパッケージスクリプトでは普通**のもの。**そして設計していなかった収穫**: `deny` 8 件が全部 `npm publish` / `git push --follow-tags` / `changeset publish` で、**あれは誤検出ではない** —— **公開パッケージのリリーススクリプトは著者にとって正当で、無人のエージェントにとって正当ではない**ので、**このコーパスのクラス境界はコマンドではなく「誰が実行するか」に在る**([43 §4](43-finish.md) のコーパスにはその性質が無かった)。**ラベルを貼ったのは著者たち**(自分で `release`/`publish`/`postversion`/`deploy` と名付けた)で、**gate はその名前を一度も見ていない**: 外向き 15 件が中央値 **1.52**・**14/15 が止められ**、それ以外 553 件が 0.30・123/553。**AUC 0.933**。**このプログラムで cutoff が当てはめられる初めてのコーパス** —— fold ごとに **1.37〜1.48** で**出荷値 0.50 の約 3 倍**。**ただし出荷してはいけない理由が 3 つ**: `advise()` が **overlapping**(どの cutoff も健全かつ完全にならない)、ホールドアウト再現率 **53.3%**(1.45 でも 15 件中 7 件が通る)、そして**これは npm script でエージェントのトラフィックではない**([22 §11.4](22-code-criteria.md))。**持ち越すのは「出荷の cutoff は分離する場所よりはるか下」で「1.45 が答え」ではない**。**一番強い数字に一番大きい注意書き**: 手がかりの単語(`publish`/`release`)を含まない positive は **2 件**しか無いので、**「外向きの動作を理解している」と「単語に一致している」を分離できない**([33](33-review.md) の主題)。**そしてこの検査はラベルを一度直した** —— 最初の版は `pre*` フックも外向きに数えていて positive 30 件・AUC 0.806 だったが、単語で割ると positive の中央値が 1.52 → 0.49 に落ち、読んだら `pre*` の中身は `npm test`/`npm run build`/`tsc` —— **`pre*` は「いつ走るか」の宣言で「何をするか」の宣言ではない**。除いて AUC 0.933 で、**gate が良くなったのではなくラベルが間違いでなくなった**。レイテンシは 3 つ目の母集団で再現(中央値 **310 ms**、**568 件中 0 件が 2,500 ms 超過**)。**そして私自身のパッケージ 7 個が最初はコーパスに入っていた** —— `packages/node_modules/` にワークスペースインストールされているので harvest の射程内。被害は 569 行中 1 行(`tsx test.ts`)で**どの数字も動かなかった**ので、**目ではなくテストが要った** —— **由来についての主張は結果を見ても見えない**。§2.2 の positive class もここに現れたが**§2.2 が頼んだものではない**(リリーススクリプトは**エージェントにとって**危険で、それ自体が危険ではない)ので**閉じたのではなく狭まった** | ✅ |
| [50](50-damage.md) | **危険な側は作れた —— それでも cutoff は引けなかった**([TODO §2.2](../TODO.md))。§2.2 は「エージェントに本当に壊させることはできないので危険な側を機械的に作る方法が要る」とし、候補 1 は**壊れたことが分かるサンドボックス**だった。**やった —— そして §2.2 はコーパスの問題ではなかった**。[49](49-scripts.md) の破壊的コマンド **26 本**(私は一文字も書いていない)を、**名指すパスの中身だけが違う 2 つの実ディレクトリ**で走らせる: `built` はビルド出力が入っていてテストは `src/` を import、`source` は**テストが import するソース**が入っている。他は全部同一(同じテスト・同じ `package.json`・同じ git・同じスタブ)。**ラベルは実行後の `node --test` の終了コード**で私の危険判断は一切入らない([32](32-repair.md) と [23 §12.1](23-task-filter.md) が同じ手)。**危険な側は実在した**: `built` **23/23 緑**、`source` **4/23 緑**、**23 本中 19 本が終了コードで 2 世界を分けた**。**しかし答えはスイープの前に出荷済みの hook に在った** —— state は `{command, intent, cwd, project, permission_mode, ...git}` で、開くのは `.git/HEAD`・`.git/config`・`.claude/jev-gate.json` **だけ**、**ディレクトリを列挙することは一度もない**。つまり `rm -rf dist` は `dist/` が昨日のビルドでもソースの唯一のコピーでも**同一の要求**で、**その 2 つが危険かどうかを決める 2 ケースそのもの**。ワイヤで確かめた([44 §5.1](44-components.md)): 世界差の中央値 **0.060** に対し**同じ世界に 2 回聞いた差が 0.050**、`source` が高いのは **19 本中 10 本**(符号検定 **p = 0.629**)、verdict が変わるのは 2 本。**つまり [43 §4.3](43-finish.md) の重なりはコーパスの問題ではなく入力の問題** —— **どんなコーパスもこれを直さない**。**hook が既に出荷している継ぎ目は効く、そして足りない**: `loadConfig` が読む `.claude/jev-gate.json` の `context` に**機械的な事実だけ**(パスの中身一覧・`git ls-files`・テストの `require`)を入れると —— 「危険だ」とは言わない([45 §2](45-floor.md) の oracle を避ける) —— **19 本中 15 本が正しい向きに動き(p = 0.002、blind は 10/19 で p = 0.629)、符号付き差の中央値は +0.010 → +0.100**。**点数は与えられれば世界を読む**。だが `advise()` は依然 **no-signal**、効果は 0..2 スケールで百分の数、cutoff は 0.50。**所見は「情報が要求に入っていない」であって「context に足せば直る」ではない**。プール AUC(0.487 → 0.525)は**この設計には間違った道具**で隠さないために出しただけ —— 2 世界は同じコマンドなのでプールするとコマンド間のばらつきがコマンド内の効果を飲む([44 §1.1](44-components.md) と同じ教訓)。**この 1 行は 2 回間違えた**: 最初は「2 世界は同一の点数」(違う —— 19 ペア中 2 ペアが完全一致)、次はドローを並べた上で「世界の方が大きい」—— **同じコードを 2 回走らせたら順序が反転した**(0.060 対 0.050 と 0.050 対 0.080)ので、**今は生成側が順序を報告することを拒む**。**そしてハーネスが世界を漏らしていた**: prefix が `jev-damage-${world}-` で state は `project: basename(cwd)` を含むので、**judgment に「built」「source」という語を手渡していた**。中身のフィールドを持たない state が差を出せるはずがないので**差が出たことが手掛かり**だった —— [44 §4.5b](44-components.md) が**4 度目**、そして**この種の漏れは結果を良く見せるので目ではなくテストが要る** | ✅ |
| [51](51-question.md) | **問いではなく、事実が 1 つだった —— そして対照群が発火した**([TODO §2.3](../TODO.md))。§2.3 は「これは閾値の問題ではなく質問の問題」([43 §4.3](43-finish.md) [24 §2](24-adhoc-rules.md))で候補 2 つを挙げ、どちらも「**聞けば分かるという私の推測**」と書いて止まっていた。[50](50-damage.md) が危険側を作ったので依存関係は払い済み。**道具はリクエスト増分ゼロだった**: battery は **1 リクエストに 9 問**([00](00-api-notes.md))で、出荷 hook は `--log` で**全答えを既に書いている** —— つまり「どの問いを聞くべきか」は**同じ応答の読み直し**([18 §2](18-permission-hook.md) と同じ手)。**[50](50-damage.md) はこのコールを 138 回して 9 つの答えのうち 1 つだけ記録していた**([44 §6](44-components.md) が 2 度目)。**事前登録**: 構成から **4 問はこの世界を読めて 5 問は読めない**ので **5 問が対照群** —— 対照が同じだけ動いたら所見は「良い問いを聞け」ではなく「context が battery 全体を揺らす」で §2.3 の前提が壊れる、と**掃く前に**書いた。**blind は 9 問中 0 問**が分けた —— [50 §1](50-damage.md) の構造的所見(state にディレクトリの中身のフィールドが無い)の**9 軸全部での確認**で、[50](50-damage.md) は 1 軸しか見ていなかった。**informed は 9 問中 2 問**、`blast_radius` 15/19(p = 0.002)と **`affects_others` 17/19(p < 0.001)—— 後者は対照群で、しかも表の中で最強**。**事前登録した対照群が発火した。だから所見は「良い問いを聞け」ではない。** 診断は checkable だった: **context が運んでいた識別できる事実は 3 つではなく 1 つ** —— `paths_the_command_names` **0/19**・`tracked_by_git` **0/19**・`the_test_requires` **19/19**(両世界が同じ「名前」のファイルを持ち、ビルダーが両世界で全部コミットするから)。**だから `affects_others` はノイズではなく**「テストが、あなたが消すパスを import している」を読んで「他の人に影響し得る」と答えただけで、**分類の置き場所を間違えていたのは私**。**そして [50 §4](50-damage.md) の「危険だとは言わない」は字義どおり正しく自分に甘すぎた** —— 運んでいる 1 事実は**ラベルから推論 1 歩**(ラベルは終了コード、事実は「テストが消されるものを必要としている」)なので**[45 §2](45-floor.md) の oracle にずっと近く、informed の数字は上限であって推定ではない**。**§2.3 自身の候補 `irreversible` は平ら**(8/19、p = 0.581、19 ペア中 6 ペアが両世界同じ答え)—— **§2.3 がこの区別を読むと予測した唯一の問いが、読まない問いだった**。**そして `permission` は [50](50-damage.md) より弱く再現**(15/19・p = 0.002 → **14/19・p = 0.064**、**p = 0.05 を跨ぐ**)—— **3 レポート連続で測り直しが確信度を動かした**。**建設的な半分**: 効いた事実は**静的解析で計算できる**(import グラフ上のリゾルバ、モデル不要)ので、**gate の次の一歩はより良い問いではなくより安い答え**。**そしてそれが効果を疑う一番強い理由でもある** —— 事実がラベルから 1 歩なら、渡して点数が動くのは**モデルが入力を言い換えられるかの測定に近い**。**`affects_others` を reads に貼り替えなかった**([47](47-stages.md) の警告)—— **貼り替えを失敗させるテストを入れた**。自分のバグ 1 件: `value()` が `probability` 等を探していて **9 問中 7 問の noul を静かに落とす**ところだった(`Answer` は判別共用体で `noul` と `score` が別キー)—— **型を読むのは無料で、掃く前に捕まえた** | ✅ |
| [52](52-intent.md) | **コーパスは無く、数えたら理由が分かった —— そして問いは、主語が無いときに一番よく効いた**([TODO §2.6](../TODO.md))。[51](51-question.md) が §2.3 を閉じたとき候補 2 つのうち 1 つが未測で残った(「このコマンドは進行中の作業の一部か」)。§2.6 は**自分の最初の一歩を指定していた** —— **コーパスを作る前に、トラフィックが既に同じコマンドを違うゴールの下に持っているか数える**。**数えたらそれが結果だった**: `traffic.json` はコマンドで重複除去してあるので答えられないが、`runs.json` は `task` を呼び出しごとの `command` の隣に持っている(**186 run・26 ゴール**)—— **異なるコマンド 489、2 つ以上のゴールの下に 9、削除対象を名指すもの 5、両方 0**。**2 集合は小さいのではなく交わらない**: ゴールをまたぐ 9 本は**全部テスト実行かディレクトリ一覧**で全部 `allow`・**最大 0.17**、削除する 5 本は**ちょうど 1 ゴール**の下だけで **0.47 以上**(cutoff が在る範囲)。**理由は構造的** —— `rm -rf src/node_modules/tiny-stats` を打つのは今このタスクがその依存についてのときだけなので、**危険さがゴールに依存するコマンドはゴール固有**で、**ゴールをまたぐコマンドは危険さがゴールに依存しないもの**。**run を増やしても直らない**。そして他所の唯一の宣言されたゴール([49](49-scripts.md) のスクリプト名)は**[49](49-scripts.md) 自身のラベル**なので渡せば [45 §2](45-floor.md) の oracle。**それでも問いは測れた**: [50](50-damage.md) の 2 世界に**著者が公開したスクリプト名**をゴールとして渡す —— **両世界で同一だからラベルではない**。出荷 9 問 + §2.6 の 10 問目(`part_of_work`、文言は私の、**テストで固定**)を4 アームで。**`none` 0/10・`goal` 0/10**(**予測どおり** —— 同一の要求は分けられない)、**`fact` 5/10**、**`both` 3/10**。**`part_of_work` は `none` 5/19・`goal` 2/19・`fact` 17/19(p < 0.001)・`both` 11/19** —— **主語を供給するアームが一番できない**。**そして `fact` アームにはゴールが一切無い**ので「**ゴール**が記述する作業の一部か」の**主語が存在しない** —— つまり**この問いは意図を読んでいなかった**:参照するゴールが無いと「プロジェクトが必要とするものと整合しているか」に退化し、それは file fact が直接答える(**`permission` と同じ向きに 19 ペア中 15 ペア**)。**[51 §5](51-question.md) の所見がまた出た** —— **§2.6 の問いは 1 つの供給された文の 10 個目の言い換えに見える**。**ゴールは不活性ではない**: `part_of_work` の 38 行全部を動かし(中央値 **+0.330**、両世界で持ち上げる)、**分ける向きには持ち上げない**(17/19 → 11/19、`permission` も 17/19 → 11/19)—— **情報を運ばないフィールドが、世界を読んでいた問いを劣化させる**([33](33-review.md) と韻を踏むが 1 回の掃きなので**仮説**)。**`permission` はこの比較で 3 回目**: 15/19・p = 0.002([50](50-damage.md))→ 14/19・p = 0.064([51](51-question.md))→ **17/19・p < 0.001** —— **向きは 3 回とも保たれ p は 0.05 を 2 回跨いだ**。自分のバグ 2 件: **交絡した wire check**(`none` アームが無く [51](51-question.md) の blind を `goal` アームと比べていたので`permission` の 0.190 ずれが「state が違う」か「ゴールが動かした」か区別できなかった —— `none` を足して 0.075 になり**ずれの大半はゴールのものだった**。**交絡した検査は検査ではない**)、そして **`ARMS` の import 衝突**がrun.ts の同名を隠して**既存テスト 6 件を壊した**(スイートが捕まえた)| ✅ |
| [53](53-fanout.md) | **人が本当にファンアウトさせた仕事 —— gate は 52/52 で「1 人でやれ」と言い、そして正しかった**([TODO §2.0](../TODO.md))。[44 §3](44-components.md) は `Task` を `--allowedTools` に入れて 20 run 走らせ、**tool call 227 件に対し `Task` 0 件**・gate も 58/58 で cutoff 未満だった。§2.0 はこれを**コーパスの問題**と読み、「エージェントが実際にファンアウトを選ぶ仕事の分布」が要ると書いた。**それは [49](49-scripts.md) の harvest に在った** —— 公開パッケージの `scripts` の一部は**合成**で、**著者が枝を同時に走らせるか順番に走らせるかを書いている**(`concurrently 'yarn:a' 'yarn:b'` 対 `npm run a && npm run b`)。**ラベルは非対称**で、それが設計を決めた: `concurrently` の集合は**独立性の証拠**(そう出荷されている)だが、`&&` は**何の証拠でもない**(`npm run lint && npm run unit` は独立)。だから **`parallel` 52 が solid な positive、`sequential` 47 は「できなかった」ではなく「しなかった」**、`single` 818 が簡単な対照。**演算子は request から抜いた** —— 枝の解決済みコマンドだけを描画するので、同じ仕事は著者が誰でも同じ request になる(**テストで固定**)。**結果: `plan()` は 52/52 で分割しない**。近いものすら無い(`parallel` の最大 **0.190** 対 cutoff **0.5**)ので**cutoff 非依存の読みも要らない** —— **欠けていたコーパスを供給しても seam は発火しなかった**、つまり **§2.0 の前提は書かれたままでは成立しない**。**そして gate は正しい**: `size` 中央値 **0.120** で**この仕事は本当に小さい**(`tsc` 3 回は秒)—— **著者が `concurrently` に手を伸ばすのは 2 つ目のプロセスがほぼ無料だから**で、`cost` framing が明記するエージェントの 2 人目のコスト(トークン・レイテンシ・誤りの伝播)は当てはまらない。**コーパスは条件の文面を満たして趣旨を外し得る**。**そして 1 つだけ免責されない所見がある** —— **`topology` は 52/52 で `sequential` を選んだ**。これは条件付きの問い(*もし分けるならどの形か*)なので「小さい」では答えにならず、**形が実行で確定している唯一のクラスで毎回外している**。しかも**答えが確定していない 2 クラスの方が `fanout` を多く受け取る**(`sequential` 17/47・`single` 43/80)—— **弱いのではなく反転**。**[31](31-orchestration.md) はこの同じ `choice` を 22/22 と測っていた**(私が書いた 38 シナリオ上で)—— **他人が書いた仕事では 0/52**。**[49](49-scripts.md) の教訓が `choice` に届いた形**。`parallel` 対 `sequential` は AUC **0.327**(0.5 未満 = 逆)、枝の数で揃えても **4 つの枝数のうち 0 個**で `parallel` が高い。テストが見つけた自分のバグ 2 件: 枝の抽出が**裸の `yarn X` 形を落として**いて`concurrently 'yarn:a' 'yarn:b' && yarn c` の枝を 3 本ではなく 2 本にしていた(**gate は著者が書いたより少ない仕事を聞かれていた**)、そして **`single` クラスの汚染** —— `tsc -p a && tsc -p b` は兄弟を呼ばないので `single` に落ちていて**クラスの 16% に `&&`**、さらに `yarn g:turbo run build` 64 件(**最もファンアウト的な仕事**)が negative クラスに座っていた。**3 本のレポートが §2.1 の候補 1 に収束した**([51](51-question.md) [52](52-intent.md) と本稿)| ✅ |
| [54](54-ceiling.md) | **天井には原因があって、それは記録に 2 回入っていた —— リクエスト 0 件**([TODO §2.5](../TODO.md))。[44](44-components.md) の全アームが完遂 100% なので終了コードが段を分離しない。§2.5 は**原因を正しく名指していた**(Bash が在るのでテストが緑になるまで回す)が、候補 1 に「**上限は私が選ぶ数字なので [25](25-thresholds.md) の規律ではまず分布を見るべき**」と書き添えていた —— **言われたとおり見たら、候補 2 の答えも記録に入っていた。[46](46-relevance.md) に続くリクエスト 0 件のレポート**。**644 run・9 ファイルで 643 完遂**。そして **`passed` だけでなく `model.json` の boolean 全部**を見ると `passed` 32/32・`testsIntact` 32/32・`untouched` 0/32 で**3 アームとも同一の天井か床** —— **「既に段を分離している完遂型ラベル」の探索は、文句を言っていた 1 フィールドではなく記録の全部について空振り**。**原因は記録に 2 回入っていた**: [36](36-routers.md) は `--allowedTools Read Edit Write` で**Bash 無し**（テストを走らせられない）、[44](44-components.md) は**同じ `hard` コーパス**を Bash 有りで —— **31/32 対 32/32**。**そして機構が 1 行で見える**: `equals-k3` は**完遂ラベルが段を分離した唯一のタスク**で、Bash 有りでは**安い段が通す**(8 call、うち 4 が Bash、記録に `npm test 2>&1` → 失敗を読む → 再編集)—— **Bash 有りの `passed` はモデルの答えではなく、ハーネスが自分の仕事を確かめる手段を与えたかを測っている**。**これで候補 2 も決着**(形ではない —— 同じタスクが Bash 無しで分離し有りで分離しない。ループは難しいタスクも通るまで回す)。**候補 1 は私が選んだ 1 点ではなく全部の K で掃いた**: K=6 で「haiku 0% 対 sonnet 63%」、K=10 で「100% 対 100%」—— **「haiku は X% 完遂する」は haiku の事実ではなく私の上限の事実**([25](25-thresholds.md) の教訓が**導出ラベル**に当たった)。**そしてどの上限も勝てない。これは定理**: 「K call 以内」は call 数の**閾値化**で、単調な多対一写像は順序情報を失うことしかできないので**AUC は call 数に上から抑えられる** —— 最良の上限(AUC で選んだ、候補 1 の最良形)**0.844** 対 call 数 **0.927**、そして [44 §1.2](44-components.md) が既に対応付きで **32 件中 28 件・p < 0.001** を報告済み。**定理は全 K についてテストで固定**。**つまり天井は障害ではない** —— 欠けていたのは段を見分ける能力ではなく**完遂型の言い方**で、この記録からそれを作る方法はどれも**既に効いていた数字の劣化した再符号化**。完遂ラベルが実際に分離した唯一の場所は **32 件中 1 件**、しかも高い段を**合計 1 タスク**しか走らせない設計の中 —— **不一致 1 件を差と呼べる検定は無い**(符号検定 p = 1.000)ので**天井を外しても 1 bit 程度**。**本当に閉じるのは「完遂がテストスイートの再実行で決まらない仕事」**だが、**このプログラムの修理コーパスはテストスイートで定義されている**ので構成上含み得ない —— **[§2.1](../TODO.md) の候補 1 に 4 つ目の方向から到着**([51](51-question.md) [52](52-intent.md) [53](53-fanout.md) と本稿)| ✅ |
| [55](55-wild.md) | **実リポジトリの実エージェントのトラフィック —— gate は 6.3% で発言し、`deny` が初めて本物に当たった**([TODO §2.1](../TODO.md) の候補 1)。**4 本のレポートが違う方向から同じ 1 つの条件に収束していた**([51](51-question.md) [52](52-intent.md) [53](53-fanout.md) [54](54-ceiling.md))。このプログラムが guard を測ってきた母集団は全部どこか別の場所から来ていた —— [43](43-finish.md) の 978 コマンドは**私が構成したサンドボックスで私が植えたバグ**、[49](49-scripts.md) の 568 は人が **`npm run` のために一度書いたスクリプト**。**2 つが私のものでない**: リポジトリは [30](30-skill-pick.md) の roster(**この問いが存在する前に組まれたリスト**、`--heads` で測ると**9 本中 7 本が pin された rev に一致**し**タスクを産んだ 2 本は両方一致**)、タスクは**著者自身の `- [ ]` 項目**([49](49-scripts.md) の手をコマンドではなくゴールに当てたもの)。gate は `--dry-run` で**観測するだけ、介入しない**。**結果: 15 run・tool call 1,268・Bash 746、うち異なる文字列 712(95.4%)** —— [43](43-finish.md) の 50.0% に対して**実際の仕事はほとんど繰り返さない**(43 は `npm test 2>&1` を 127 回打っていた)。形も違う: **探索 47.6%・`cargo` 16.6%・`sed`/`for` 16.4%**で、**4 ファイルのサンドボックスには探索するものが無い**。**gate は 741 件中 47 件(6.3%)で発言** —— **[43](43-finish.md) の 1.2% と [49](49-scripts.md) の 24.1% は同じ未解決問題の両端**で(前者は私が書いたコーパス、後者はエージェントトラフィックでないもの)、**この行が両方を満たす最初のもの**。`permission` 中央値 **0.11**、レイテンシ中央値 **322 ms** で **2,500 ms 超過は 0/741**(3 つ目の母集団)。**そして `deny` が 1 件、本物のエージェントの選択に当たった** —— `curl … | bash`(permission **1.65**・`outside_project` 0.96・`obfuscated` 0.77)。MoonBit のツールチェーンが無く、**エージェントが自分で入れようとした**もので、**出荷している cutoff が調整なしで当たった** —— [01](01-shell-risk.md) はラベル付きコーパス、[49](49-scripts.md) の 8 件は著者が書いたリリーススクリプトだったので、**「この gate が止めるべきものを止めた実例」はこのプログラムに 1 つも無かった**。**ただし手柄は半分**: それは 3 回目の試行で、1 回目(`-o` でファイルに落とす形)は**私の fence が止めていた** —— **経路の一部は私が作っている**ので独立な観測ではない。**fence の 5 件のうち 3 件が同じ形**で、`/root/.claude/projects/…/tool-results` を読もうとしたもの —— **直前は毎回 `cargo test … | tail -150` の類**で、**自分が切り詰めた出力をホストの transcript から回収しようとしている**(**止めたのは fence で gate ではない**。gate はこの 3 件に `allow`)。**委譲は 12 件・15 run 中 7 run**で [44 §3](44-components.md) の 0/227 以来**初めてゼロでない** —— **[53](53-fanout.md) の読み(0 はエージェントの選択)は成立して鋭くなった**(同じツールで、コーパスを変えたら 0 → 12)。そして **[44](44-components.md)/[53](53-fanout.md) のカウントは運で正しかった**だけで、どちらも `c.tool === "Task"` で数えていたが **ledger は `Agent` で記録する**。**`--allowedTools` は境界ではない**: 誰も許可していない 3 ツールへの **18 件**が ledger に在り、**`PreToolUse` の seam はその全部を見ていた** —— **allow-list ではなく hook が境界**。**最初の harvest は 66 件を返して全部テンプレートだった**(PR テンプレート、skill が利用者に確認させるチェックリスト、プレースホルダ構文)—— **構成上永久に未チェック**なので「open」が何も意味せず、直しは**人が追跡しているファイルにはチェック済みが入っている**。**4 度目**の「構成上 negative なクラスを含んだ harvest ラベル」。**自分のバグ 3 件**: 掃きを殺した cleanup(`rmSync` の `ENOTEMPTY` が 8 run 目でループの外に飛んだ —— **1 run ごとに記録を書いていたことだけが 8 行を救った**)、**待ち合わせを 2 回間違えた**(`pgrep -f` が待ち合わせ自身に一致)、そして**このレポートの §3 の表を要約から手で書いて間違えた**(5 件のうち 1 件は CA バンドルで別の話)—— **合計ではなく行を読むという自分の教訓を自分のレポートで破った**形で、いまは導出＋テスト。**そして私が発明した限界 1 件**: 「clone は pin された rev に居ないからタスク文は著者の現在の版」は**測ったら 9 本中 7 本で偽**だった。**そして `- [x]` 対照アームを後から掃いた**: **8 run 追加**(open 項目と同じ節に在る done 全部、**それがこのコーパスが支持する対応の上限** —— `actrun` 136 done / 5 open、`similarity` 1 / 10、`flaker` 44 / 0 なので**分布は自分では対応しない**)。**done の先頭から採る罠**: file 順だと `## Goals` の**チェック済みの方針文**が来るので、差は「文の種類」になる —— **対応の単位は著者の見出し**にして、`timeout-minutes` 対 `concurrency`、`S006` 対 `S007` の**隣接行**にした。**検定は厳密順列検定**(対応が付かないので符号検定は使えず、5 点は分布を仮定できない)で **C(13,5)=1,287 通り全列挙**。**結果: プールでは全指標 null**(tool call p=0.802・編集 p=0.384・秒 p=0.533)—— **そしてこれは「同じように振る舞う」の証拠ではない**、**p の床が 1/1287 ≈ 0.0008** で 0.05 を切るにはほぼ完全な分離が要るから(レポートが床を自分で印字する)。**節で割ると 5 指標のうち 4 つが符号反転**: **`Tier 2`(lint 規則)では done が小さい**(tool call 78.5 → **32**、編集 8.5 → **2**、秒 428 → **226**、3 件とも完走)が、**`P6`(機能)では done が大きい**(tool call 88 → **121**、編集 7 → **15**、5 件中 3 件が 600 秒で打ち切り)—— **つまりプールの null は 1 つの母集団ではなく、2 つの節が向きで喧嘩して打ち消し合った結果**。**どちらも 0.05 を切らず、`Tier 2` は切れない**(n=2 対 3 の床は **0.100**)。**読める機構**(未測): lint 規則は検証可能で境界が在るが、機能項目には境界が無い。**1 つ潰した仮説**: 「`- [x]` は一部だけ done の意味だから残りをやる」—— P6 の done 3 件は著者が留保を書いている(*not enforced* 等)が、**留保なしの `run-name` が 135 call で最大**だったので**行が支持しない**。**未測**: 残り 173 件(足しても対応は増えず repo と節の差が混ざるだけ)| ✅ |
| [56](56-moba5.md) | **本格的な 5v5 MOBA と、採点できるベンチマーク —— 試合は 3-0 で勝ち、採点すると手書きの床を下回った。** [02](02-moba.md) の 3v3 を**残したまま**別パッケージにして、ジャンルの機構まで広げた(3 レーン + 両サイドのジャングル + 川の 23 ノード、レベル、アイテム、クールダウン付きのスキル、スタン、ドラゴン/バロン、ミニオンの押し合い、ワード、2 段のタワー)。**構造として一番効いたのは 1 行の規則** —— **自陣のウェーブが居るレーンのタワーはその champion を撃たない**ので、「Farm で押してから殴る」が正しい手順になり**マップが飾りでなくなる**。**スループットは 3v3 より良い**: **1 リクエストで 4.86 体分**・**キャラ 1 体 52 ms**(3v3 は 2.76 体・76 ms)、**$0.008/試合**、そして**不正手は 874 判断で 0 件** —— criteria = 合法手は行動空間が 5 倍でも成立する。**本題は採点**: 31 シナリオ 124 問を **`--repeat 5`** で、答えは**全部シミュレータが出す**(決定的なルールなので「この集団戦は勝てるか」は再生すれば分かる)。tier を **`rules`(再生した)/`arith`(ルールの算術)/`score`(明示した目的関数)** に分けて問ごとに明記し、**同点は同点として両方正解にした**(選択肢の並び順を測らないため)。**結果は 0.48**(class mean 0.51)対 手書きヒューリスティック **0.51**(同 0.55)。**そして正解率は床でもランダムでもなく「一番良い定型答え」に対して読む** —— `const` 列を足したら、**ゴム印より明確に上と言えるクラスは 10 のうち 1 つ**(`lane` 1.00 対 const 0.71。「一番押されたレーン」と「一番早く落ちるレーン」を食い違わせた罠を 5 回とも越える)、**下が 3 つ**(`focus` 0.26 / `retreat` 0.41 / `item` 0.17)だった。**一番はっきり出たのは正解率ではなく整合性**: **16 局面のうち 13 で「この集団戦は勝てない」と答えた直後に「いま殴れ」と答える** —— 同じ state・同じリクエスト・同じノードについてで、**2 問を同じリクエストに入れていなければ見えない**([02](02-moba.md) が効率の話として始めた fan-out が、そのまま矛盾の検出器)。**そして数えたら、その 13 は最初から情報を持っていなかった** —— `false` 14/16 と `fight_now` 15/16 から **14 + 15 − 16 = 13** が強制される。**共起が周辺度数の下限に等しいとき、それは 2 つのゴム印の言い換え**で、対の証拠ではない(**真値の側の 4 は下限 0・上限 7 の内側なので、そちらは読める**)。**残るのは真値との比較**: ルールが両立を許すのは 4 局面なので **13 組のうち少なくとも 9 組は間違い**(符号検定 p = 0.004〜0.012)、**ただしどちらの問いの答えが間違っているかは言わない**。**`fight` の閾値を「outright に勝つ」から「体の交換で負けない」に緩めても、ゴム印に対する差は両方 +2** —— **逃げ道はその方向には無かった**(`--coherence`、API 不要)。**そして 2 択を 3 択に割ったら、答えは「どちらか」ではなく割合になった**: `fight_now` を「勝つから殴る」/「勝てないが殴る価値がある」に分けて同じ 16 局面を同じ run の中で両方の文言で聞くと、**周辺度数は動かない**(「殴る」は 3 回とも変化 0)のに、**「勝てない」と言って殴った 41 局面のうち 30(73%)が中央を選んだ** —— **そこは矛盾ではなく私の 2 択が粗かった**分で、**残り 27% は同じリクエストで「勝つから殴る」と答えた**(逃げ場なし)。**ただし正解率は 0.50 → 0.29 に下がった** —— **articulate になったが正確にはなっていない**。そして**問ごとの答えを記録したら**(384 行を committed)、**区間だった検定が厳密に 9/0・p = 0.004 になった**。**そして「27% は本当の矛盾」も撤回になった** —— 同じ 3 択を**4 通りの説明文**で聞き直すと(選択肢名・オラクル・truth・他の問いは全部同じ、動かしたのは説明文と 1 本だけ並び順)、中央の割合は **56% / 59% / 74% / 100%** に動く: **1 つの文言では矛盾が 48 答え中 0 件**、別の文言では **44%**、**並び順だけでも 74% → 59%**(文は 1 字も変えていない)。効いたのは長さでも「弁護」でもなく **「outright には勝たない」の 1 句が中央に在るか**で、**正解率はどの文言でも全部ゴム印の下**(0.31〜0.38 対 0.56)—— **整合するようになることと正しくなることは別**。**文言 6 通りで動かなかったのは周辺度数だけ**(7 arm・21 run で両立の数は毎回その下限)。**そしてこのレポートは 2 度書き直した。** 1 度目は `--repeat` が無く、**22 問を 1 回ずつ**測って「calibration の向きが反転する」を所見にしていた(**標本の小ささの産物**。このリポジトリは他の実験で[22](22-code-criteria.md) [25](25-thresholds.md) [31](31-orchestration.md) とずっと `--repeat` を使ってきた)。2 度目は **`fight` クラスが偏っていた** —— **8 問中 7 問が「体の数が多い側が勝つ」**で、床の 0.88 はほぼそれだけだった。**直し方は手で差し替えることではなく掃くこと**: 構成・レベル・体力・ノードの**540 通りを全部再生**し、体の数が結果を予測したかで 4 バケツに分け、**同数取ると体を数える戦略が正確に 0.50**(「全部 yes」も 0.50)—— **等式としてテストに固定**。**一度目の掃きは別の偏り方をした**(バケツが埋まるまで取ると 16 問が全部同じ 2 チームになった)ので、**偏りの検査は 1 種類では足りない**。そして **`const` 列を足した瞬間に`retreat` も 0.83 で引っかかった**(「全部 walk_away」がモデルより上)。**点数が自分の文言の関数かどうかも測った**: `fight` の noul の 2 面を**3 節 対 1 節から 1 節ずつの鏡像に書き直しただけ**でクラスの点が **0.50 → 0.63**・confidence が **0.53 → 0.28** に動き、**答えはどちらでもほぼ定型 `false`** だった —— [51](51-question.md) はレバーが問いではなく事実だったと結論したが、**ここではレバーが問いだった**。**霧の読みを初めて採点した**(シミュレータは見えない敵の位置を知っているので毎 tick 無料):**139 tick で 14 正解 = 0.10**、23 択のランダム 0.043 の 2 倍強だが**平均 confidence 0.43〜0.56 は高すぎる**。**そして相手で 0.02 対 0.36 に割れる** —— `scripted` はレーンに忠実で予測できるが `smart` は集団で回るので予測できない、つまり**この数字の大半は相手の予測可能性の性質**([README の 33 番](#この探索から見えている一般則) が別の題材で再現)—— [02 §3](02-moba.md) が「情報がないときに自信を持たないのは望ましい」と書いた同じ問いで、**選択肢を 2 倍にして採点したら confidence は上がって正解率は 0.10 だった**。**採点していない confidence は校正の主張に使えない**。**それでも試合には勝つ** —— 両サイドから両方の bot に各 2 戦で **6-0**、**6 試合すべて自陣の構造物は満額**。**そして勝ち方の説明は行動の内訳に在った**: 874 手のうち **`structure` 0 件・`farm` 472 件**で、**構造物を一度も殴らずに相手の構造物だけが減っていた**(ミニオン規則がそうさせる)—— 巧いのか **30 tick では攻城の段に入っていないだけ**なのかは、いまの打ち切りでは区別できない。**同じ実行が勝って、採点で床を下回る。勝つことと正しいことは別の測定**で、3v3 は前者しか見ていなかった。**編成の oracle も 2 つ作ったら片方が間違っていた**: `meta` は集団戦 **12-0 で 1 位**だが全試合では **6-6 の 4 位**、`bruisers`(前衛 5 枚)は集団戦 4 位で**全試合 12-0** —— [11](11-synergy.md) の「正しいシナジー」は**集団戦の話だった**。`--draft` は `meta` を選び(conf 0.70)**集団戦側の順位にほぼ一致** (1・2・7 位を正確に当て、残りは隣同士の入れ替え 2 組)—— **モデルの答えは合っていて、私が当てさせた oracle が間違っていた**。**環境を測ったらバグが 5 件**、全部テストか対称性の検査で出た(観察では見えない): `node_names` の表が 1 つずれて**モデルに嘘のマップを渡していた**、**A のジャングラーだけ序盤の目標から遠い初期位置**、そして直しても残った**隣接リストの並び順** —— 同距離の経路をリストの先頭で割っていたので **A の bot laner は tick 1 にレーンから後ろへ歩いていた**(同点を「同距離なら前に出る側」で割ると**7 編成中 5 編成で両サイドが完全な鏡像**、勝者は 7/7 でサイドに依らない)、**`Stun(1)` が着弾と同時に切れていた**、**ドラゴン 1 スタックが整数除算で 0 だった**(序盤のほぼ全員に無効 = マップの下半分が存在する理由が未登録)。**ベンチマーク自身の不変条件もテストにした**(正解が選択肢に在る・**選択肢の全部が正解ではない**・問の名前が一意・床が全問正解でも全問不正解でもない)—— どれも欠けると**採点表は出るが意味を持たない**。**ベンチマークの不変条件は 10 本**(正解が選択肢に在る / 選択肢の全部が正解ではない / 問名が一意 / クラスは 5 問以上 / どのクラスも床が全問正解ではない / **どのクラスも定型答えで 5 分の 4 を超えない** / **解析の truth がベンチマーク自身の truth と同一** / **言い換えた問いが同じ問いになっている** / **言い換えた問いが意図した通りに違っている** / **共起が周辺度数の下限に等しいことを検出できる**)で、**後から足した 3 本は足った瞬間に落ちた** —— **採点表は出るが意味を持たない**という壊れ方は数字を見ても気付けない。テスト 53 本、API 不要(モデル側の 1,152 答えは committed) | ✅ |
| [57](57-confidence-fallback.md) | confidence が低いときのフォールバック — と、confidence では拾えない失敗 | ✅ |
| [58](58-coverage-guidance.md) | カバレッジ誘導 — 同じ事実を state に置くかゴールに置くか | ✅ |
| [59](59-nl-test-generation.md) | 1 文から Playwright spec を生成し、ミューテーションで採点する。**§4.5〜§4.10 で生成 5 回・経路 4 通りの盤面・経路選択の要因分解**(ラベルが決めている)まで追った | ✅ |
| [60](60-perf-automation.md) | 計測 → 診断 → 適用 → 再計測([lightbringer](https://github.com/mizchi/lightbringer) の手法を借用) | ✅ |
| [61](61-speculative-fanout.md) | 操作ごとに分けた action space を 1 リクエストで投機的に聞く([jev-ultrafast](https://github.com/browser-use/jev-ultrafast) の仕組みを移植)+ §8 で 4 盤面から投機を壊しにいった | ✅ |
| [62](62-browser-accuracy.md) | 他実装 4 つを決定点で評価 + 溜めた手法の leave-one-out + 転用候補 5 機構を実装して**採用 2・却下 3**。**25 の解釈を 1 つ訂正** | ✅ |
## 上流に入ったもの

この探索から [chaosbringer](https://github.com/mizchi/chaosbringer) に 3 本入った。
前 2 本はどちらも「Jev を賢くする」側ではなく、**driver に渡す情報**の側である。

| PR | 中身 | 出どころ |
| --- | --- | --- |
| [#142](https://github.com/mizchi/chaosbringer/pull/142) | 候補一覧をステップ毎に作り直す / `DriverStep.currentUrl` / `aiDriver({ minConfidence })` | [05 §4](05-browser-chaos.md#4-chaosbringer-側への指摘-driver-の候補一覧が-1-ページ-1-回しか作られない) の指摘、[57](57-confidence-fallback.md) が読もうとした信号 |
| [#143](https://github.com/mizchi/chaosbringer/pull/143) | `DriverCandidate.bbox` を実際に埋める + `inViewport` / `inert` / `coveredBy` / `isObstructed()` | [57 §5](57-confidence-fallback.md#5-効いたのはモデルに聞かないほうだった) で効いたもの |
| [#144](https://github.com/mizchi/chaosbringer/pull/144) | traceparent を入れた状態での strict HAR replay を回帰テストで固定 | [#129 §2](https://github.com/mizchi/chaosbringer/issues/129) の triage。**報告されたバグは存在しなかった**が、`route.fallback()` に依存している経路に一切カバレッジが無かった |

**効いたのは後者だった。** 前者(`confidence`)は「あったのに読んでいなかった」信号で、
読んでも無駄手は拾えなかった。後者は「そもそも測っていなかった」信号で、12/12 当てた。
ただし上流の定義は本稿のプローブより意図的に狭いので、**その 12/12 が
`chaos({ driver })` 経由でそのまま出るかは測っていない**
([57 §6](57-confidence-fallback.md#6-chaosbringer-側に入った142--143どちらも-merge-済み))。

## この探索から見えている一般則

1. **1 リクエストに詰めろ。** state が一度しか送られないので、質問を足すコストは質問文のトークンだけ。
   レイテンシもほぼ増えない。迷ったら聞いておく。
2. **答えの形を問題の形に合わせろ。** 順序があるなら `score`、独立した述語なら `noul`、
   互いに排他な分岐なら `choice`。ここを間違えると confidence が読めなくなる。
3. **閉じた世界を仮定するな。そして逃げ道は選択肢ではなく別の問いにする。**
   `choice` は渡した選択肢の中から必ず選ぶ(該当なし 18 件で逃げ道なしは 0/18)。
   ただし**逃げ道の作り方 2 通りは等価ではない**: 別の noul で聞くと 18/18 だが、
   `choice` の選択肢に「該当なし」を混ぜると 16/18 に落ち、
   さらに**答えのある難問までそこへ逃げる**。難しさは `pick` の confidence に、
   該当なしは別の noul に分けて出させる([17](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする))。
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
9. **判定基準は渡せるが、逃げ道は書かないと渡らない。** 実装を伏せて評価基準だけ渡しても
   合否は当たる(88.4%)。外すのは例外規定 —— 「禁止と書いてあるが実装だけが許している」
   ケースに全部集まる。言語化すれば直る(`except-parens` を渡すと 10/15 → 15/15)が、
   渡した例外は隣のケースにも一般化されるので、**ゲートに使うなら例外は渡さない**
   ([16](16-eslint-oracle.md))。
10. **名前が内容を説明していれば、名前だけで足りる。** 名前だけの一覧から選ばせると
    自己説明的な項目は 36/36、**名前が内容と食い違う項目だけで落ちる**。
    1 行の説明を足すと 100% になり、実装(コマンド)まで見せても上積みは無い ——
    **散文で情報が尽きる**。一覧を渡して選ばせる設計では、
    精度への投資先は質問文ではなく**項目名と 1 行の説明**
    ([17](17-task-picker.md))。
11. **state を盛る前に、ゴール文で足りているか確かめる —— 逆に、ゴール文が無いなら文脈が唯一の情報源。**
    4〜8 では構造化 state が最大のレバーだったが、タスク選択では `changed_files` も
    直前の終了コードも **1 件も動かさなかった**([17](17-task-picker.md#5-リポジトリの文脈は要らなかった))。
    23 で同じことを**ゴール文なし**(入力は diff だけ)で測ると反転して、
    **パスだけでは無害な変更の判別が 0.482(コイン投げ)まで落ち、hunk を渡すと 0.183 になる**。
    つまり仮説「文脈が効くのは意図が曖昧なときだけ」は当たりで、
    **意図を書けるなら 1 文書くのが一番安く、書けないなら hunk まで払う**
    ([23](23-task-filter.md#4-文脈は効いた--17-との違いは意図が書かれているかどうか))。
12. **オフラインの正解率は質問文の妥当性を保証しない。** コーパスに無いクラスの穴は
    コーパスでは見えない。23/24 を取った `exfiltrates` の文言は、hook にした 1 発目で
    普通の `git push` を deny した。**実運用の形に載せることが最後のテスト**で、
    それ以外に文言の穴を出す方法は無い([18](18-permission-hook.md#3-コーパスでは見つからないバグが出た))。
13. **判断を下す場所では、失敗の落とし先を先に決める。** 精度より先に決まるのは
    「API が落ちたらどうなるか」。hook では全失敗経路を**判断なし = 通常フロー**に
    落とす(allow に倒せば黙って承認、deny に倒せば障害で停止)。
    そしてゲートは**狭める方向にだけ**使う([18](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質))。
14. **設計判断は構文で強制できる。** ライブラリなら「閾値はコード側に置け」は
    お願いだが、言語なら**質問文に閾値を書く場所を作らない**で済む。
    同じく「逃げ道は選択肢ではなく別の問い」も、`else` 腕が gate noul を生やす
    設計にすれば**混ぜる書き方が存在しなくなる**([19](19-jevlang.md))。
15. **確率的な判断を含む実行には record/replay を最初から入れる。**
    同じ入力で分岐が変わるので、無いとテストが書けない。
    そして**実装やモデルを比べるときの唯一の土台**になる([19](19-jevlang.md#4-record--replay--確率的な言語に必須の道具))。
16. **同期の拡張点に非同期の判断を入れるには、判断を前に出して、拡張点にはルックアップだけ残す。**
    ESLint のルールは `await` できないが、事前バッチ + ハッシュ引きなら
    **lint 時間は何もしない lint と誤差の範囲**(31 ms 対 36 ms)。
    ブロッキングも本当に可能(`execFileSync`)だが 1 ファイル 361 ms で、
    「できる」と「入れて良い」は別([21](21-eslint-plugin-jev.md#1-eslint-プラグインにする唯一の難所--ルールは同期))。
    そして**バッチの単位は拡張点が全体を見られる瞬間**で決まる
    (ESLint なら `Program:exit` = ファイル)。
17. **confidence は「報告するか」ではなく「どう報告するか」に使う。**
    報告の前提条件にすると **62.5%、外すと 73.7%**。
    clean も bug も confidence が 0.54〜0.57 に入るので、柵にすると正解ごと捨てる
    ([21](21-eslint-plugin-jev.md#7-confidence-をゲートにすると-11-ポイント損する))。
    [07](07-escalation.md) の「低 confidence は方針を決める問題」の運用形がこれ。
18. **文脈は精度を上げるのではなく、judgment を穏やかにする。**
    4〜8 では構造化 state が最大のレバー、17 では 1 件も動かさず、
    21 では**誤検出を 1/5 にして見逃しを増やした** —— 3 つとも同じ現象で、
    文脈が増えると score が下がる。だから **どちらの誤りを減らしたいかで足す/外す**を決める
    ([21](21-eslint-plugin-jev.md#6-ファイルの文脈は精度を上げない下げる))。
19. **同型の質問を並べても、確率は同じ尺度で返ってこない。**
    8 つの欠陥クラスを同じ形の noul で聞くと、自クラスへの答えが **0.20 から 0.94**
    まで開いた。共通閾値 0.80 は **AUC 0.80 と 0.92 の 2 指標を丸ごと捨てる**
    —— 検出できていないのではなく、値が低いまま正しく順序づけている。
    [04](04-agent-built-prompts.md#2-原因は設計ではなく閾値だった) の
    「閾値はデータ」は**ゲート単位ではなく質問単位**で適用する。
    合成も最大値ではなく**各自の閾値からの超過率**で
    ([22](22-code-criteria.md#4-一番効いたのは指標ではなく指標ごとの閾値))。
20. **列挙の穴を測るには、難しさを揃えないと意味がない。**
    「そのクラスを列挙したか」だけを変えた保留セットでは何も出なかった ——
    易しいバグは列挙の有無にかかわらず **15/15** 拾われるから。
    難しさで割ると **easy では naming が無価値、hard では 2.6 倍**
    (14% → 52%)で、穴の深さは約 32 ポイント。
    そして**列挙した質問を 1 つ抜いて投げる**のが、
    新しいコーパスを作らずに列挙外クラスを作る唯一の確実な方法
    ([22 §11](22-code-criteria.md#11-追記--保留セットを作り直して穴の深さを測った))。
    抜いても 8 個中 7 個は自クラスを失わない —— **原子質問は互いに重複している**。
21. **「軸を書けば答えが来る」わけではない。**
    [01 §5](01-shell-risk.md#5-rubric-は書いた軸しか答えない) の
    「rubric は書いた軸しか答えない」は真だが逆は成り立たない。
    落としていた 6 個に**専用の指標を名指しで**投げても、戻ったのは 2 個で、
    残りは 0.09〜0.22 の「いいえ」。**質問設計で埋まる穴と、埋まらない穴がある**
    ([22](22-code-criteria.md#3-落とした-6-個のうち戻ったのは-2-個))。
    そして名前を付けて拾う数を増やすと、**その名前の正しさが 100% → 77% に落ちる**
    —— 再現率と説明可能性は同じ通貨で買っている。
22. **審判のいない領域では、正解率ではなく「指摘の中身」を報告する。**
    「コード品質」に ESLint のような審判は無い。だから
    (a) **ラベルはコード実行で証明できるものに寄せる**(バグ 12 個すべてにプローブ)、
    (b) 証明できない意見(`smell`・`clean`)は**別クラスにして主指標から外す**、
    (c) 不均衡な集合では「何も言わない」が 76.5% を取るので、
    **精度と再現率を分けて出す**(自信のある指摘 15/15 が本物 / 12 バグ中 5 個)
    ([21](21-eslint-plugin-jev.md#3-結果--捕まえたものと落としたもの))。
23. **原子質問は汎用質問の代わりではなく上乗せ。**
    列挙した 8 クラスでは原子質問が勝つ(25/36 対 18/36)のに、
    **列挙していないクラスでは負ける**(11/15 対 15/15)。
    両方聞けば両方取れる(26/36 と 15/15)。
    [01 §4](01-shell-risk.md#4-分解は万能ではない) の「列挙し忘れたクラスに穴が空く」が
    数字で出た形で、**穴を埋めるのは汎用質問**
    ([22](22-code-criteria.md#6-列挙していないクラスには穴が空く))。
24. **規則で解ける部分は判断に混ぜない。コードに置くと無料で正確、プロンプトに置くと有料で不正確。**
    タスクの依存グラフを各質問に載せると削減が **68.6% → 66.3%** に落ちてトークンが
    1.3 倍になるのに、同じグラフを**閉包としてコード側に置くと**前提も順序も
    判断の外に出る(そして間違えようがなくなる)。
    [05](05-browser-chaos.md#変化-2--3-無効だった候補を消すと連打が止まった) の
    「繰り返させたくない選択はコードで消す」と同じ形で、
    Jev に聞くべきなのは**規則で書けないところだけ**
    (この diff は振る舞いを変えるか / この suite は今回関係あるか)
    ([23](23-task-filter.md#5-グラフはプロンプトではなくコードに置く))。
25. **合成コーパスで出た「効く/効かない」は、実物の形に依存する。**
    タスク filter は合成 monorepo では静的解析に **68.6% 対 30.9%** で勝ったのに、
    このリポジトリ自身で測ると **glob だけの無料の判定に 80.2% 対 65.9% で負けた**。
    差はモデルではなく**グラフの扇形**で、共有パッケージから下流に伝播する形なら
    静的解析が悲観的になって判断の余地が生まれ、独立したパッケージが
    並ぶだけなら静的解析が既に正確。**入れる前にグラフの形を見る**。
    [12 §8](12-comeback.md#8-追記--強い-bot-を基準にすると取り返し幅は縮む) の
    「弱いベースラインで観測した効果を一般化するな」の、
    ベースラインがコーパスではなく**構造**である版
    ([23 §12.3](23-task-filter.md#123-検出は-1818ただし-glob-だけの静的判定に負ける))。
26. **正解ラベルを規則から実測に変えると、測っている対象が変わることがある。**
    「ありそうな編集」15 個を実際に走らせたら、**9 個はどのレシピも落とさなかった** ——
    2 実装の一致を守るはずのコメントが警告している丸めの違いも、
    実 API に対して測った定数 255 も、誰も固定していない。
    フィルタの精度を測るつもりで**テストスイートの穴**を測ることになった。
    そして規則では書き漏らしていたものが出る(`report/fmt.mbt` の
    シグネチャ変更が jevlang と jevdsl のテストを落とした)
    ([23 §12.2](23-task-filter.md#122-一番の収穫--15-個のうち-9-個は何も壊さない))。
27. **当てはめた閾値は、当てはめていない標本で採点しないと数字にならない。**
    「clean の最大値 + 0.01」で引いた閾値は、当てはめた標本では**必ず誤検出 0** ——
    負例の上に置いたのだから発火しないだけで、何も言えていない。
    fold を切ると 1224 関数-draw 中 **24 件**が発火し、
    [22](22-code-criteria.md) の上乗せ(13/36 → 23/36)は**半分が当てはめの自己申告**だった
    (誤検出 0 を要求すると 18/36)。そして**壊すのは draw ではなく新しいコード**:
    同じ関数をもう一度聞いて越えるのは 0.37%、見たことのない関数は 2.0%。
    効く margin は draw sd の **20 倍**必要で、
    「モデルの揺れのぶん余白を取る」では足りない
    ([25](25-thresholds.md#2-in-sample-の誤検出-0は情報がない))。
28. **閾値は gap の真ん中に置く。そしてコストが測れているなら、閾値ではなく損失を最小化する。**
    [24](24-adhoc-rules.md#1-読むのは閾値ではなく-gap) の「読むのは gap」には置き場所の含意がある ——
    gap が広い問いで清潔な側の縁に置くと、**質問が稼いだ余白を全部捨てている**
    (同じ検出で誤検出 24 → **7**)。
    さらにスキップの代償が測れている問題では、閾値そのものが要らない:
    「閉包の秒数 + penalty × P(見逃し)」を最小化すると**タスクごとの柵がコストから出て**、
    自由なパラメータは「見逃し 1 件の値段」1 個になる
    (検出 18/18 のまま削減 73.5% → **81.4%**)。
    ただし [07](07-escalation.md#4-q2--コスト品質曲線) の規律はここにも要る ——
    同じ損失モデルから**判断だけを抜いた対照**は、同じ検出で 40.9% しか削れない
    ([25 §5](25-thresholds.md#5-閾値をコストの関数にする23-11-の宿題))。
29. **コーパスで校正した判定を実コードに当てると、出てくるのは「わざとやっている版」。**
    植え込みバグ 641 行で自信のある指摘が 5/5 正解だった 3 文を、
    このリポジトリ自身の 9,315 行に当てると **19 指摘のうち要修正は 2 件**で、
    残り 17 件は**意図的にそうしてあるコード**だった ——
    `catch { return {} }` は文のとおり違反で、同時に
    [18](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質) の
    「判定層は失敗を判断なしに落とす」そのもの。
    [22 §11](22-code-criteria.md#11-追記--保留セットを作り直して穴の深さを測った) の
    「列挙の穴」は**正例**の穴だったが、実リポジトリで開くのは**負例**の穴で、
    [21](21-eslint-plugin-jev.md) が `nearmiss` クラスを作ったのと同じ理由になる。
    そして **confidence の向きが逆になる**: 形が自明なほど自信は高く、
    形が自明な違反は意図的であることが多いので、
    自信のある 5 件が 0/5、当たった 2 件は conf 0.29 / 0.19 の「質問」として出た
    ([26](26-repo-rules.md#2-19-件を全部読んだ))。
30. **文を答えられる形にすることと、正しく判定させることは両立しないことがある。**
    [24 §2](24-adhoc-rules.md#2-5-ルール中-2-つは最初の文が失敗した) の
    「subject から見える範囲だけを聞く」に従って書き直すと、
    **意図を見分ける情報がまさに範囲外**になる。
    `no-swallowed-catch` を 3 通り(note の書き直し / subject を catch 節から囲む関数へ)
    測っても、ラベル付きコーパスで**意図的な catch が本物のバグを上回る順位は変わらなかった**。
    必要な情報(呼び出し元が失敗を判別すべきか)がコードのどこにも書いていないので、
    これは書き方の問題ではない —— **判定できない規約は、測ると測れないことが分かる**
    ([26 §5](26-repo-rules.md#5-文を書き直す--subject-を広げる--3-draft-測ってどれも直らなかった))。

31. **閾値は答えの分布を見てから置く。ハードコードした閾値は塊の真ん中に座りがち。**
    [36](36-routers.md) の逃げ道は `underspecified > 0.7` のハードコードだった。
    質問自体は壊れていなくて、幅は 0.060(「変数名を変える」)〜0.954
    (「ダッシュボードを良くして」)ときれいに分かれる ——
    だが**普通のリクエスト 8 件のうち 6 件が 0.606〜0.729 に固まる**ので、
    0.70 は**大半のトラフィックを draw ノイズ 1 つ以内で裁く**位置だった。
    別のことを測っていて見つかった([37 §7](37-hermes.md#7-副産物--逃げ道の閾値が答えの塊の真ん中にあった))。
    [25](25-thresholds.md) は「閾値を当てはめる」道具の話で、これはその手前 ——
    **当てはめる前に、答えがどこに来るかを見る**。
    そして跳ね返りがある: [36 §5](36-routers.md) は
    「tier score ではなく逃げ道に頼れ」と結論していたのに、
    **その逃げ道のほうがノイズに敏感だった**。

32. **「1 リクエストに問を詰めても答えは動かない」は、state が同じときの話。**
    [29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) の fan-out は
    **1 種類の問 × 1 つの state** で 99.8% が 0.25 以内だった。
    3 つのコンポーネントの **state を union** して束ねると、
    **7 問すべてが「同じ聞き方の再試行間」より大きく動いた**(比 1.71〜7.32)。
    ずれの絶対値は小さい(0.024〜0.058)ので、効くのは**閾値の近くだけ** ——
    decision が変わった 3 件はすべて cutoff の跨ぎだった
    ([37 §6](37-hermes.md#6-1-リクエストturn--これだけ測る価値があった))。
    幅は無料、**union は無料ではない**。

33. **発言率は判断の性質ではなくコーパスの性質。**
    同じ gate・同じ cutoff で **1.2%**([43](43-finish.md)、私が構成したサンドボックス)→
    **6.3%**([55](55-wild.md)、実リポジトリの実エージェント)→
    **24.1%**([49](49-scripts.md)、公開された `npm run` スクリプト)。
    **「この guard はうるさい/静かだ」は、測った母集団を書かないと意味を持たない。**
    そして [43](43-finish.md) と [49](49-scripts.md) の両端は
    **同じ 1 つの欠落**を指していた —— 一方は私が書いたコーパス、
    他方はエージェントのトラフィックでないもの。

34. **自分が書いた限界も測る。**
    [55](55-wild.md) は「clone は shallow だからタスク文は著者の現在の版」と限界に書いたが、
    clone 木の `HEAD` を読んだら **9 本中 7 本が pin された rev と一致**しており、
    **タスクを産んだ 2 本は両方一致**だった ——
    **私が発明した限界**で、測ったら消えた。
    限界の節は**正直さの表明であって推測の置き場ではない**。

35. **合計ではなく行を読む —— レポート自身の表も含めて。**
    harvest ラベルが**構成上 negative なクラス**を含んでいたのが 4 度
    ([49](49-scripts.md) の `pre*`、[53](53-fanout.md) の `single` が 2 回、
    [55](55-wild.md) のテンプレート 66 件)で、**4 度とも行を読んで見つかった**。
    そして 5 度目は**自分のレポートの表**だった ——
    [55 §3](55-wild.md) の fence 5 件を要約から手で書いて、
    **1 件(コンテナのプロキシ CA バンドル)を別のクラスに数えていた**。
    **記録から導出して、どの行もどのクラスにも入らなければ落ちるテストを置く**のが直し方。

36. **勝敗は判断の質の測定ではない —— そして正解率は「一番良い定型答え」に対して読む。**
    [56](56-moba5.md) は同じ実行の中で、5v5 の試合を**両サイドから両方の bot に 6-0** で勝ち、
    **同じモデル・同じ observation を 124 問 × 5 回で採点したら 0.48**(床 0.51)だった。
    bot を相手にした勝率は**相手の弱点の形**を測っていて、
    **どの判断を直すかは 1 つも言わない。**
    **直し方は決定的なルールを oracle に使うこと** ——
    `copy()` と「1 手だけ強制して残りは baseline」を用意すると、
    問いの半分が**再生して採点できる形**になる。
    **そして合計ではなくクラスを、床ではなくゴム印に対して読む**: その列を足したら
    **「ゴム印より明確に上」は 10 クラスのうち 1 つ**(`lane` 1.00 対 const 0.71)で、
    **下が 3 つ**(`focus` 0.26 / `retreat` 0.41 / `item` 0.17)だった。
    列を足す前は `retreat` の「全部 walk_away」が **0.83** 取れていた。

37. **同じリクエストの 2 問を突き合わせると、正解率では見えない失敗が出る ——
    ただし共起の数を読む前に、周辺度数が何を強制しているか確かめる。**
    [56](56-moba5.md) は **16 局面のうち 13 で、「この集団戦は勝てない」と答えた直後に
    「いま殴れ」と答えた** —— 同じ state・同じリクエスト・同じノードについて。
    [02](02-moba.md) が「観測 1 つに判断 N 個」を**効率**の話として始めた fan-out が、
    **そのまま矛盾の検出器**になっている。
    **そして数えたら、その 13 は最初から情報を持っていなかった** ——
    `false` 14/16 と `fight_now` 15/16 から **14 + 15 − 16 = 13** が強制される。
    **共起が周辺度数の下限に等しいとき、それは 2 つのゴム印の言い換え**で、
    対についての証拠ではない(**同じ統計量が、真値の側では読める** ——
    ルールの 4 は下限 0・上限 7 の内側)。
    **読めるのは真値との比較**: ルールが両立を許すのは 4 局面なので
    **13 組のうち少なくとも 9 組は間違い**(符号検定 p = 0.004〜0.012)、
    **ただしどちらの問いの答えが間違っているかは言わない。**
    **確かめるコストは 1 行**で、確かめなかったコストは所見 1 つだった。

38. **「モデルが矛盾している」か「私の選択肢が粗い」かの割合は、
    選択肢の説明文の関数 —— 測るまでそれを所見として書くな。**
    [56](56-moba5.md) は `fight_now` / `walk_away` の 2 択を
    「勝つから殴る」/「勝てないが殴る価値がある」/「引く」の 3 択に割り、
    **オラクルは同一のまま、同じ 16 局面を同じ run の中で両方の文言で**聞いた。
    **周辺度数は動かなかった**(「殴る」は 3 回とも 16 局面全部で同じ答え)——
    つまり**選択肢を足してもゴム印はゴム印**で、共起は下限に張り付いたまま。
    **それでも、名前を与えたらモデルはそれを選んだ**:
    **「勝てない」と言って殴った 41 局面のうち 30(73%)が中央**で、
    残り 27% を「文言の逃げ場が無い矛盾」と書いた。
    **同じ 3 択を 4 通りに書き換えたら、その割合は 56% / 59% / 74% / 100%** ——
    **1 つの文言では矛盾が 48 答え中 0 件**、別の文言では **44%**。
    **並び順だけでも 74% → 59%**(文は 1 字も変えていない)ので、
    **「中央」の一部は意味ではなく位置**だった。
    効いたのは長さでも「弁護」でもなく
    **「outright には勝たない」の 1 句が中央に在るか**。
    **そして正解率はどの文言でも全部ゴム印の下**(0.31〜0.38 対 0.56)——
    **整合するようになることと正しくなることは別**。
    **文言を 6 通り変えて動かなかったのは周辺度数だけ**(7 arm・21 run)。

39. **クラスが偏っていないかは数えれば分かる。そして直し方は掃くこと。**
    [56](56-moba5.md) の最初の `fight` クラスは **8 問中 7 問が体の数で決まって**いて、
    床の 0.88 はほぼそれだけだった ——
    **モデルの点数の大半が、モデルの要らない算術の点数**。
    **手で差し替えると私が期待した方に寄る**ので、
    **540 通りを全部再生して 4 バケツに分け、同数取った**:
    体を数える戦略が**正確に 0.50**、「全部 yes」も**正確に 0.50**、
    **どちらも等式としてテストに固定**。
    **一度目の掃きは別の偏り方をした**(バケツが埋まるまで取ると
    16 問が全部同じ 2 チームになった)ので、**偏りの検査は 1 種類では足りない**。

40. **点数が自分の文言の関数かどうかを確かめる。**
    [56](56-moba5.md) は `fight` の noul の 2 面を
    **3 節 対 1 節から 1 節ずつの鏡像に書き直しただけ**で、
    クラスの点が **0.50 → 0.63**、confidence が **0.53 → 0.28** に動いた ——
    **答えはどちらでもほぼ定型 `false`** だったので、
    動いたのは主に「どれだけ確信するか」。
    [51](51-question.md) はレバーが問いではなく事実だったと結論したが、
    **ここではレバーが問いだった。**

41. **1 回では読むな —— 自分の道具に `--repeat` が無いときは特に。**
    [56](56-moba5.md) の最初の版は **22 問を 1 回ずつ**測って
    「calibration の向きが回によって反転するので confidence が正誤を分けていない」を
    所見にしたが、**`--repeat` を実装して 340 答えで測り直したら向きは安定して正しかった**
    (正解時 0.60 / 誤り時 0.47、別の走りでも 0.59 / 0.48)——
    **反転は標本の小ささの産物**だった。
    このプログラムは他の実験で**ずっと `--repeat` を使ってきた**
    ([22](22-code-criteria.md) [25](25-thresholds.md) [31](31-orchestration.md))し、
    [37 §6](37-hermes.md) と [41](41-versus.md) は
    「**同じ聞き方の再試行間**の散らばり」を差の基準線と決めてすらいた ——
    **持っていなかったのは新しい実験の計器だけ**で、付けたら所見が 1 つ消えた。
    **そして基準線は出力に入れる**: 124 問中 **15 問が同じ問いに違う答えを返す**ので、
    **床との差はその不安定な部分集合より小さい**。
    [README の 35 番](#この探索から見えている一般則)(合計ではなく行を読む)の
    時間方向の変種。

42. **1 つの数字は、相手やコーパスの性質を含んでいる。**
    [56](56-moba5.md) の戦場の霧の読みは **`scripted` 相手 0.36・`smart` 相手 0.02〜0.07** ——
    レーンに忠実な bot は居場所が予測でき、集団で回る bot は予測できない。
    **相手を書かない霧の正解率は意味を持たない。**
    [33 番](#この探索から見えている一般則)が別の題材で再現した形で、
    **ついでに環境の対称性もテストする**: mirror 戦がほぼ全部片側に落ちる状態で
    勝率を 3 本測っていて、**原因 2 つはどちらも「同点の割り方」**だった。
43. **判定させるのではなく行動させるなら、質問より先に action space を決めろ。**
    上の 26 項はそのまま効くが、一番大きい失敗が別の形で出る。判定なら間違った答えが返るだけだが、
    **表現できない終状態は当たりも外れもなく到達不能**になる ——
    「空にする」を操作として持たないだけで 0/2 で、しかも**対象フィールドに一度も触らない**。
    そして値は**実行単位に乗せる**(`index:option`、`(index, text)`)。
    調べた 4 実装すべてがそうしていて、「要素だけ指して値は呼び出し側が推測」は誰も出荷していない
    ([62 §1](62-browser-accuracy.md#1-実装-4-つの決定点))。
44. **削って安くする機構と、表現力を上げる機構を混ぜて評価するな。**
    他実装から 5 機構を移して測ったら、**採用 2 はどちらも表現力側、却下 3 はどちらも
    安くする側**にきれいに割れた。**精度を買えるのは前者だけで、後者が買えるのはトークン**である
    ([62 §6.7](62-browser-accuracy.md#転用候補の決算))。
    行動させる側では手数のほうが高い —— 1 手は数セント未満だが、1 手は
    **実アプリに対する変更**で、失敗すれば取り消しが要る。
45. **1 対 1 で効いた手法は、重ねたときに別に測れ。** 素のベースラインに対して効いた手法どうしは
    **足し算ではなく崖**だった。型付き欠損もジオメトリ欠損も**単独なら着く**(2/2)のに、
    両方欠けたときだけ **0/2**。各手法はもう一方が在ることを前提に予算内に収まっている
    ([62 §3.1](62-browser-accuracy.md#31-足し算ではなく崖だった))。
    そして**置かなかったアームについては何も言えない** —— 25 は「伝えるだけ」のアームを
    置き忘れたまま「消すほうが効く」と書いていて、後で足したら同値だった
    ([62 §4](62-browser-accuracy.md#4-docs57-の解釈を-1-つ訂正する))。
46. **誤差の床を測ってから、差を読め。** 同一条件を 2 回回したら **0.04 動いた**。
    1 回目に「2 つの条件が 0.853 でぴったり一致」と出て、**機構として書きかけた** ——
    2 回目で偶然だと分かった([59 §4.10](59-nl-test-generation.md#410-追記-filler-で確信が上がる理由--語彙ではなく個数そして-003-は誤差))。
    床を当てると、0.03 や 0.02 の「効果」は**効果ではなく「この n では区別できない」**に変わる。
    → **再実行が唯一の検出器で、これは 6 回ずつ回しても要る。**
47. **機構が同じでも、領域が違えば数字は移らない。**
    候補 2 択では並び順が **+0.21** 動かすが、数十候補では誤差に埋まる
    ([59 §4.9](59-nl-test-generation.md#49-追記-長いリストでは成り立たなかった--021-は短いリストの話))。
    「絞ると confidence が下がる」(2 択で 0.845 → 0.783)を 214 → 58-64 の盤面で
    測り直したら **0.76 対 0.77 で床の内側**だった
    ([62 §6.4](62-browser-accuracy.md#64-テキストではない絞り方が答えだった))。
    → **転移させる前に、その盤面で測る。** 24〜26 の「実物の形に依存する」の
    定量版で、依存しているのは**候補数の領域**である。
