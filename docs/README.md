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
> | **[practice.md](practice.md)** | **Jev を使うときに順番に決めること。** 手順書・チェックリスト・やってはいけないこと一覧 |
> | **[findings.md](findings.md)** | **実験ごとに何がわかったか。** 1 本 = 1 ブロック(試したこと / 結果 / わかったこと / 効かなかったこと) |
> | **[summary.md](summary.md)** | **やったこと / わかったこと**の端的な要約(ブログ用) |
>
> 下の表は各レポートの全文への索引です。

## 走らせ方

```bash
export TYPESAFEAI_API_KEY=your_key_here
moon run --target native cmd/patterns --                       # 00: 公式パターン集の実測
moon run --target native cmd/shellrisk --                      # 01: シェルコマンド判定
moon run --target native cmd/moba -- --a jev --b scripted      # 02: 3v3 MOBA
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
cd experiments/browser-chaos  && npx tsx src/run-perf.ts --repeat 3 # 28: 計測 -> 診断 -> 検証
cd experiments/browser-chaos  && npx tsx src/check-fanout.ts     # 29: action space と validateChoice(API 不要)
cd experiments/browser-chaos  && npx tsx src/run-fanout.ts --select many --seeds 2 --steps 18 # 29: 投機的 fan-out
cd experiments/browser-chaos  && npx tsx src/run-adversarial.ts --fixture hostile --runs 2 # 29 §8: 投機を壊しにいく
cd experiments/browser-chaos  && npx tsx src/run-adversarial.ts --fixture slots-hard --runs 2 # 29 §8.1: ゴールに無い判断材料
python3 -m http.server -d web 8000                             # 11: リプレイを Web 再生 → :8000/replay.html
cd experiments/eslint-oracle  && npm i && npx tsx src/run.ts   # 16: ESLint の合否予測
cd experiments/task-picker    && npm i && npx tsx src/run.ts --scale # 17: タスク選択
node hooks/test-gate.mjs --failsafe-only                       # 18: hook のフェイルセーフ(API 不要)
node hooks/test-gate.mjs                                       # 18: hook を実物で採点
node jevlang-js/bin/jevlang.mjs examples/milk.jev               # 19: jevlang(JS 版)
moon run --target native cmd/jevlang -- examples/milk.jev       # 19: jevlang(MoonBit 版)
scripts/jevlang-conformance.sh                                 # 19: 2 実装の一致(API 不要)
node scripts/check-doc-anchors.mjs                             # docs 内の #anchor 切れ(API 不要)
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
| **決定的に判定できることは選択肢から消す** | ジオメトリで押せない候補を外す。無駄手 **12/12 を 100% 検出**、モデル呼び出し 0、トークン −13% | 本リポジトリ | [25](25-confidence-fallback.md#5-効いたのはモデルに聞かないほうだった) |
| **同じ事実でも、置き場所で効果が変わる** | 未実行の関数名を state の配列からゴール文に移すだけで分岐 **3/12 → 11/12**。名前の集合は同一 | 本リポジトリ | [26](26-coverage-guidance.md#結論先に) |
| **実行可能性は候補に、望ましさはゴールに** | 「効かない」は選択肢を消せる。「やる価値がある」はゴールと競合するので、ゴールを書き換えないと勝てない | 本リポジトリ | [26](26-coverage-guidance.md#5-なぜ場所で決まるのか) |
| **assertion の候補はコードで抽出し、どれが「結果」かだけ聞く** | 前後の差分だけを候補にする。初期状態 4 件は **0.00 で落ちた**。捕まえたバグ 1 → 2 | 本リポジトリ | [27](27-nl-test-generation.md#1-何を分担させたか) |
| **注記の散文は指標として扱える** | 「転送中はメインスレッドが空いている」を「ユーザーは壁時計を待ち切る」に直すだけで、推薦の実測価値が **188ms → 1,664ms** | 本リポジトリ | [28](28-perf-automation.md#結論先に) |
| **再計測しないと機会損失が見えない** | 8% 速くして「当たり」に見えた診断の隣に 71% があった | 本リポジトリ | [28](28-perf-automation.md#6-輪を閉じたから分かったこと) |
| **実行する単位を target にする(要素ではなく)** | 要素だけ指す形は値を呼び出し側の推測に残す。6 択で **+5 手**、選択肢数に比例して増える | [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | [29](29-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving) |
| **投機は無料だった** | 操作が決まる前に選んだ target は、決まった後に選んだものと**同一**(実行された head は 12/12 で TV = 0.000)。リクエストは半分、モデル壁時計は −53%。トークンは得も損もしない | [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | [29](29-speculative-fanout.md#4-the-speculation-is-free) |
| **曖昧さは「操作」側にあり、target 側には無い** | 全操作が必要な画面で operation は 0.55、その target は 1.00。投機が無料なのは target 質問が**簡単な半分**だから | 本リポジトリ | [29 §8](29-speculative-fanout.md#why-it-holds-and-when-it-could-not) |
| **target head を不確実にしようとすると、不確実さは operation 側に移る** | 4 盤面で試して used head は 20/20 が ≥0.90。型付き分割が質問を狭めている以上、「何をするか」の迷いは「どの要素か」の迷いに分解されない | 本リポジトリ | [29 §8.2](29-speculative-fanout.md#82-the-uncertain-used-head-is-not-constructible-here) |
| **空 value の `<option>` を target にしてはいけない** | プレースホルダは値ではない。満たした要件を捨てる target になり、両アームが 0.4-0.7 で食いついた | 本リポジトリ | [29 §8](29-speculative-fanout.md#what-the-run-actually-caught-a-bug-in-the-port) |
| **confidence は質問の形の性質で、アーム間で比較できない** | 正しい側が 0.46-0.71、失敗する側が 0.93-0.99。閾値は形ごとに引き直す | 本リポジトリ | [29](29-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving) |

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
| confidence を無駄手の検出器に使う | 無駄手 13 件のうち 12 件が **0.99 以上**。低い手は「正しいが手応えのない手」だった([25](25-confidence-fallback.md#4-校正-confidence-は何を測っていたのか)) |
| `takePreciseCoverage` を 1 発で全体像として読む | 未カバーは時間とともに消え、カウンタは毎 take リセットされる([26](26-coverage-guidance.md#2-計測側で-3-回転んだどれももっともらしい出力を出す)) |
| 解決しないセレクタで「効果なし」を数える | 押せないボタンが「効かないボタン」に化ける。実験は失敗せず**きれいな結果**を返す([26 §2.3](26-coverage-guidance.md#23-セレクタが-1-つも当たっていなかったこれが一番痛い)) |
| 生成したテストを「生成できた」で評価する | クリック列 + 最終 URL は、注文を記録しないアプリに対して緑のまま通る([27](27-nl-test-generation.md#結論先に)) |
| 固定の待ち時間でステップの費用を測る | `async` なハンドラは待たれないので、300KB の fetch が 20ms の無料ステップに見える([28](28-perf-automation.md#2-計測を-3-回直した)) |
| 無駄手(画面が変わらない手)だけでループを検出する | 10 手連続で `standard ↔ economy` を往復しても画面は毎回変わるので、**無駄手 0 のまま予算を使い切る**([29](29-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving)) |
| 成功する罠を「ゴール到達」で採点する | 同じゲートを通って同じ確認画面に着く近似ボタンは、到達率には一切出ない。state で採点するしかない([29 §8](29-speculative-fanout.md#8-trying-to-break-the-speculation)) |
| 「今の値と違う最初の選択肢」でドロップダウンを送る | 列挙ではなく 2 周期の**振動**になり、3 番目以降に永久に到達しない。記憶を持たせると 1 選択肢 1 手で終わる([29](29-speculative-fanout.md#3-six-options-the-flat-shape-stops-arriving)) |
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
| [25](25-confidence-fallback.md) | confidence が低いときのフォールバック — と、confidence では拾えない失敗 | ✅ |
| [26](26-coverage-guidance.md) | カバレッジ誘導 — 同じ事実を state に置くかゴールに置くか | ✅ |
| [27](27-nl-test-generation.md) | 1 文から Playwright spec を生成し、ミューテーションで採点する | ✅ |
| [28](28-perf-automation.md) | 計測 → 診断 → 適用 → 再計測([lightbringer](https://github.com/mizchi/lightbringer) の手法を借用) | ✅ |
| [29](29-speculative-fanout.md) | 操作ごとに分けた action space を 1 リクエストで投機的に聞く([jev-ultrafast](https://github.com/browser-use/jev-ultrafast) の仕組みを移植)+ §8 で 4 盤面から投機を壊しにいった | ✅ |

## 上流に入ったもの

この探索から [chaosbringer](https://github.com/mizchi/chaosbringer) に 3 本入った。
前 2 本はどちらも「Jev を賢くする」側ではなく、**driver に渡す情報**の側である。

| PR | 中身 | 出どころ |
| --- | --- | --- |
| [#142](https://github.com/mizchi/chaosbringer/pull/142) | 候補一覧をステップ毎に作り直す / `DriverStep.currentUrl` / `aiDriver({ minConfidence })` | [05 §4](05-browser-chaos.md#4-chaosbringer-側への指摘-driver-の候補一覧が-1-ページ-1-回しか作られない) の指摘、[25](25-confidence-fallback.md) が読もうとした信号 |
| [#143](https://github.com/mizchi/chaosbringer/pull/143) | `DriverCandidate.bbox` を実際に埋める + `inViewport` / `inert` / `coveredBy` / `isObstructed()` | [25 §5](25-confidence-fallback.md#5-効いたのはモデルに聞かないほうだった) で効いたもの |
| [#144](https://github.com/mizchi/chaosbringer/pull/144) | traceparent を入れた状態での strict HAR replay を回帰テストで固定 | [#129 §2](https://github.com/mizchi/chaosbringer/issues/129) の triage。**報告されたバグは存在しなかった**が、`route.fallback()` に依存している経路に一切カバレッジが無かった |

**効いたのは後者だった。** 前者(`confidence`)は「あったのに読んでいなかった」信号で、
読んでも無駄手は拾えなかった。後者は「そもそも測っていなかった」信号で、12/12 当てた。
ただし上流の定義は本稿のプローブより意図的に狭いので、**その 12/12 が
`chaos({ driver })` 経由でそのまま出るかは測っていない**
([25 §6](25-confidence-fallback.md#6-chaosbringer-側に入った142--143どちらも-merge-済み))。

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
    [05](05-browser-chaos.md#変化-2--3-選択肢から消すほうが言葉で言うより効く) の
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
