# 37. 常駐 hermes agent — 5 つの jev コンポーネントを 1 つの pi 拡張に

依頼は「pi agent 上で model selector / skill selector / guard rail /
memory compaction / multi agent orchestrator を jev で作る。
**難易度によって sonnet/opus と reasoning の深さを切り替える**。
これは**常駐型の安く動く hermes agent** を想定している」。

[36](36-routers.md) で model selector と skill selector は
[`packages/`](../packages/) にある。残り 3 つを足し、
5 つを 1 本の pi 拡張に組み上げて、**1 つだけ未測定だった前提を測った**。

再現:

```bash
cd packages && npm install && npm --prefix jev-hermes test   # API 不要
cd experiments/hermes && npm install
npm run demo                                # 記録から全部の表、API 不要
TYPESAFE_API_KEY=... npm run run -- --repeat 4   # 64 draws, $0.0039
npx tsx ../../packages/jev-hermes/src/cli.ts --budget         # 1 日の値段
```

---

## 結論(先に)

**1. 束ねるのは無料ではなかった。** 3 つのコンポーネントは同じ turn の同じ
request を読むので、質問を 1 リクエストに束ねた。
[29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ)(幅は無料)を根拠に
無料だと踏んでいたが、**7 つの答えすべてが「同じ聞き方の再試行間」より
「2 つの聞き方の間」で大きく動いた**(比 1.71〜7.32)。
トークンは 18% 減る。decision が一致したのは 8 turn 中 **5**。

**2. 不一致 3 件はすべて cutoff の跨ぎで、答えの移動量ではない。**
これは §4 で分けて測った。動いた量(0.024〜0.058)はどれも小さく、
効いたのは**閾値の近くに答えが座っていたこと**。

**3. 副産物のほうが重要だった。** `underspecified` は両端はきれいに分かれるのに
(0.060「変数名を変える」/ 0.954「ダッシュボードを良くして」)、
**8 turn のうち 6 つが 0.606〜0.729 に固まる**。
[36](36-routers.md) の model router の逃げ道の閾値は **0.70 のハードコード**で、
その塊の真ん中に座っていた。不一致 3 件のうち 2 件がこれの跨ぎ。

**4. 厳しい framing だと orchestration gate は、この 8 turn では発火しない。**
`needs_more_than_one` は 8 turn 全部で 0.055〜0.446 で、既定の 0.5 を超えない。

> **訂正。** 初版はここに「ほぼ発火しない」と書きました。
> [31 §8](31-orchestration.md#8-追記--閾値を-framing-ごとに当てはめる追加リクエスト-0)
> でラベル付きの 38 シナリオに当てると **0.78 まで届き、0.5 で 66 の正例のうち
> 18 を偽陽性ゼロで拾います** —— つまり 0.055〜0.446 は
> **私が作った 8 turn の範囲**で、gate の範囲ではなかった。
> そして出荷した 0.5 は**この wording の偽陽性ゼロ点**で、正しい値でした。
> [36 §5.2](36-routers.md) の訂正と同じ形です。

---

## 1. 何を足したか

| パッケージ | 元にした実測 | 何が新しいか |
| --- | --- | --- |
| [`jev-guard`](../packages/jev-guard/) | [18](18-permission-hook.md) の hook、**68/72(94.4%)**、median 329ms | 無人のとき `ask` をどうするか |
| [`jev-compact`](../packages/jev-compact/) | [17 §3](17-task-picker.md) の逃げ道、[30 §7](30-skill-pick.md) の state | 要約せず削除する。構造的制約はコード側 |
| [`jev-orchestrator`](../packages/jev-orchestrator/) | [31](31-orchestration.md) の gate、topology の **22/22** | framing を設定にした |
| [`jev-hermes`](../packages/jev-hermes/) | [36 §5](36-routers.md) の梯子 | 1 リクエスト/turn + 共有予算台帳 |

[36 §1](36-routers.md) の分割はそのまま守っています ——
**pi を import するファイルは各パッケージに 1 つだけ**(`src/pi.ts`)。

## 2. guard rail —— 無人のとき `ask` は誰に聞くのか

[18](18-permission-hook.md) の battery は移植だけで済みました。
9 問 1 リクエスト、順序スコアと原子述語の**保守側**を採る(90.3% / 61.1% →
94.4%)。`exfiltrates` の書き直しも、**その理由を隣に残したまま**移しました ——
[18 §3](18-permission-hook.md#3-コーパスでは見つからないバグが出た) で
「ごく普通の `git push` が deny された」原因なので、
後の整理で criteria を「簡潔に」戻すと穴が開き直ります。
`test.ts` が節と理由文の両方を検査します。

移植で決め直しになったのは 1 つだけで、そこが常駐の本質でした。

**pi の `tool_call` は `{ block?, reason? }` —— block か何もしないかの二択で、
`ask` を返す先が無い。** [18](18-permission-hook.md) の hook は
人が見ている前提だったので `ask` を host の確認プロンプトに渡せた。
常駐 = 無人だと渡す先が無く、「永遠に来ない答えを待つ」は選択肢ではない。

| | `ask` が何になるか |
| --- | --- |
| `ctx.hasUI` | `ctx.ui.confirm(...)`、断られたら block |
| 無人 | `unattendedAsk`、既定 **block** |

**既定を block にしたのは、このパッケージが [18](18-permission-hook.md) の
hook より厳しい唯一の点**です。可用性の代償も分かっています ——
[18](18-permission-hook.md) の 24 件中 5 件が `ask` なので、
**shell 作業の 5 分の 1 が止まって人を待つ**。だから設定です。

そして常駐 agent の請求の大半は前段で決まります:
**`read` は何も壊せないので聞かない**([33 §1](33-review.md) の規律)。
`band` で「聞いたか」「[18](18-permission-hook.md) が校正した面か」を
必ず返すので、94.4% が **shell の数字**であることは隠れません。

## 3. memory compaction —— 削除は検証できる、要約はできない

前提が制約です: **jev は文章を生成できない。**
質問に答えるだけなので、jev による compaction は必然的に**選択**になる。

そしてそれは**良い方の制約**でした。理由は jev の能力とは関係ありません:

- **削除は検証できる。** 何が消えたかを言えるし、
  「この事実は残ったか」をテストで検査できる。
- **要約はできない。** 黙って捏造する・限定を落とす・2 つの事実を偽の 1 つに
  混ぜる、のどれが起きても気づく手段は**元を持っていること**で、
  それはいま捨てたものです。

判断に決めさせないものを 3 つ、score より上のコードに置きました。
一番効くのは **tool_call の対応関係**で、これは品質ではなく妥当性の問題です ——
呼び出しだけ残して結果を落とす(逆も)と、多くの provider は会話を丸ごと拒否します。
`closePairs` は**不動点まで回します**: 1 件の撤回が相方の撤回を呼ぶので、
1 パスでは閉じません。

> テストで 1 件バグが出ました。**撤回された削除を「空いた」と数えると、
> 1 件早く止まって予算超過のまま「成功」と返る。**
> サイズは提案集合ではなく**閉じた集合**から測り直さないといけない。

リクエストは**各エントリのダイジェスト**を運びます。compaction が起きるのは
そもそも送れないほど大きいからで、エントリを丸ごと載せる質問は
**まさにこれが必要な入力で落ちます**。だから頭と尾:
tool の結果は頭が「何をしようとしたか」、尾が「どう終わったか」で、
「このコマンドは失敗したか」が出力が要るかどうかの大半を決めます。

無料の 3 つのランキング(`oldest` / `largest` / `stale`)を**同じモジュール**に
置いたのは [33 §1](33-review.md) の教訓です ——
あそこでは無料の指標だけで答えが出ていて、それが見えたのは先に測ったからでした。

~~**ランキングはまだ測っていません。**~~
**測りました → [39](39-compact-ranking.md)。**
そしてこの段落が**同じ教訓をもう一度踏んでいた**ところです ——
**無料のランキングを先に測っていなかった**。
判断 96〜100% 対この 3 つ 11〜78% という差は大きすぎて、
疑ったら**ベースラインが壊れていました**:
判断がしていたことの大半は
**「タスク自身の作業」と「周りの探索」の分離**(平均 AUC 0.751)で、
**ゴールとの語の重なり**という 4 つめの無料ランキング(`overlap`)が
**67〜100%** まで埋めます。残る差は**予算が厳しいときだけ**
(25% で 96% 対 78%、内容量を揃えた後)。
`onError: "baseline"` の退避先も `largest`(4 つ中**最悪**)から
`overlap` に変えました。

## 4. orchestrator —— framing を設定にした

[31](31-orchestration.md) の 3 つの結果がそのまま設計です。

**組み立てない**(30/38 対 30/38)。同点なので、
4 問版は「間違える経路が 4 つ増えるだけ」。

**条件 3 は規則に入れない**(入れると 4/4 対 0/4)。
直接聞けば入りようがないので、`test.ts` は
**payload が機械的チェックの話を一切していないこと**を検査します。

**framing は 21 ポイントのダイヤル。そして「良い/悪い」ではない**
([31 §2b](31-orchestration.md)):

| クラス | n | コストを述べる | 述べない |
| --- | --- | --- | --- |
| skill 自身の罠 | 7 | **6/7** | 4/7 |
| 明らかに複数 | 22 | 6/22 | **18/22** |
| 明らかに単一 | 6 | **6/6** | 5/6 |

→ 厳しい側と緩い側です。**常駐 agent の高い誤りは不要な分割**
(余計な worker 1 人が丸ごと 1 セッション)なので、既定は厳しい側。

topology の `choice` は**8 つ全部を質問に残します**。
選択肢を消すと質問が変わり、22/22 は 8 択で測ったものなので ——
host が動かせない pattern は**同じ答えの確率分布から後で差し替え**ます
(追加リクエスト 0)。

`stay_single` は聞いて記録しますが、**decision には繋いでいません**。
[31 §2b](31-orchestration.md) が罠で 3/7(gate の 6/7 に対して)と
**最も緩い読み**だと測ったので、拒否権を渡すと一番厳しい信号を
一番弱いので置き換えることになります。不一致は表に出すだけ。

**pi には agent を spawn する API が無い**ので、これは助言で、配車はしません。
[31](31-orchestration.md) が測ったのは**決定**で実行ではなく、
jev が仕事を worker 割り当てに分解できるという測定はどこにもありません。

## 5. 梯子 —— 段は escalation、深さがダイヤル

依頼は「難易度によって sonnet/opus と reasoning の深さを切り替える」。
[36 §5](36-routers.md) はそれを素朴にやると何が起きるかを測っています ——
53 タスク中 52 が最安段で足り、cost ladder を当てはめても定数しか戻らず、
penalty を上げると held-out では**どの arm も「何もしない」より悪い**
(fitted 1.81 / held out 3.54 / always-cheap 2.89 / 完璧な router 1.04)。

なので 2 つの軸を別扱いにしました。

- **段は escalation。** 2 段、cut は 0..1 の梯子で **0.85** 1 本。
  中くらいの tier score では sonnet に留まる。opus に行くのは
  決定的に上の score か、逃げ道が開いたとき。
- **深さが主ダイヤル。** 動かすのが無料で、**prompt cache を壊さない**。
  model を切り替えると常駐セッションは cache を作り直した上に
  高い単価を払う。[36 §5](36-routers.md) のコスト表は段の軸の話で、
  深さの軸は**外しても安い**方です。

## 6. 1 リクエスト/turn —— これだけ測る価値があった

3 つは `before_agent_start` で発火して同じ request を判断します。
別々なら 3 往復 × state 3 部、束ねれば 1 本。
無料だと踏んだ根拠は [29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) ——
74 問を束ねたのと 1 問ずつ聞いたので答えの 99.8% が 0.25 以内、
トークンは 296,845 対 718,128。

**しかしあの fan-out は「1 種類の問 × 1 つの state」で、
これは 3 つの state を union したもの**です。同じレポートは隣の操作 ——
問の**主題**を state に押し込む —— を 53% まで落ちると測っています。

だから測りました。8 turn × 4 repeats × 2 ways = 64 draws、$0.0039。
turn は**答えが分かれるように**選んであります
([36 §5.2](36-routers.md) の罠: あそこでは 21 個のプロンプトが同一文字列で、
across-task の散らばりが draw ノイズを**下回った**)。

### 6.1 何が安くなるか

```
  way        draws   requests/turn   input tokens/turn   ms
  combined      32             1.0                1292    210
  separate      32             2.0                1582    211
```

**トークンの 18%、リクエスト 1 本。** レイテンシは**買えていません** ——
別々の経路は並行に投げるので、買えるのはトークンと rate limit の余裕です。

### 6.2 答えは動くか

within は**同じ聞き方の再試行間**の散らばり(draw ノイズ)、
between は**聞き方を変えたとき**の平均の差。
[36 §5.2](36-routers.md) が訂正を出したのはまさにここで、
between だけでは何も言えません。

```
  answer                 within (draw sd)   between (|mean diff|)   ratio   turns over
  tier                              0.010                   0.024    2.42    5/8
  effort                            0.022                   0.038    1.71    6/8
  underspecified                    0.008                   0.058    7.32    7/8
  oversized                         0.008                   0.025    2.99    7/8
  needs_more_than_one               0.006                   0.040    6.95    7/8
  stay_single                       0.009                   0.057    6.47    6/8
  big_enough                        0.009                   0.053    5.64    8/8
```

**7 問すべて比 1 を超えました。** draw ノイズ自体が小さい(0.006〜0.022)ので、
これは**検出できる系統的なずれ**でノイズではありません。
ただし**ずれの絶対値は小さい**(0.024〜0.058)。

### 6.3 decision は一致するか —— 何かを決めるのはこれだけ

```
  turn                 combined                     separate                     agree
  trivial              sonnet/low single            sonnet/low single            yes
  stale-token          sonnet/high single           opus/high single             NO
  vague                opus/high single             opus/high single             yes
  sweeping             opus/high fanout x3          opus/high single             NO
  subtle               opus/high single             opus/high single             yes
  parallel-research    opus/medium single           opus/medium single           yes
  pipeline             sonnet/medium single         sonnet/medium single         yes
  question             sonnet/medium single         opus/medium single           NO
```

**5/8。** 不一致は `stale-token`(段)、`sweeping`(形)、`question`(段)。

### 6.4 なぜ動いたのか —— 閾値との距離

§6.2 のずれは小さいのに §6.3 で 3 件変わった。なので
**各答えが自分の cutoff からどれだけ離れているか**を出しました
(draw 2 偏差以内の行だけ):

```
  turn                 answer                     value   cutoff   gap    draw sd   within noise?
  stale-token          underspecified             0.680     0.70   0.020    0.038   YES
  sweeping             underspecified             0.678     0.70   0.022    0.029   YES
  sweeping             needs_more_than_one         0.446     0.50   0.054    0.082   YES
  parallel-research    big_enough                  0.497     0.50   0.003    0.066   YES
  question             underspecified             0.682     0.70   0.017    0.032   YES
```

`YES` は「cutoff との距離が draw ノイズ 1 つより近い」 ——
**どちら側に落ちるかは聞き方の性質ではない**、という意味です。

つまり**束ねたことが decision を変えたのではなく、
decision が閾値の上に載っていた**。[25](25-thresholds.md) の主題そのものです。

## 7. 副産物 —— 逃げ道の閾値が答えの塊の真ん中にあった

§6.4 を追って生の分布を見たのが、この実験で一番役に立ちました。

```
turn                 underspecified   oversized      tier   needs_more_   big_enough
trivial                       0.060       0.031     0.000         0.055        0.041
stale-token                   0.680       0.231     0.341         0.196        0.229
vague                         0.954       0.329     0.927         0.205        0.391
sweeping                      0.677       0.791     0.636         0.446        0.901
subtle                        0.606       0.354     0.909         0.239        0.376
parallel-research             0.729       0.306     0.374         0.274        0.497
pipeline                      0.632       0.336     0.055         0.246        0.399
question                      0.683       0.122     0.088         0.117        0.101
```

**`underspecified` の質問は壊れていません** —— 幅は 0.060〜0.954 で、
両端(「変数名を変える」と「ダッシュボードを良くして」)はきれいに分かれます。
問題は**真ん中で、8 つのうち 6 つが 0.606〜0.729 に固まる**こと。

[36](36-routers.md) の `policy.ts` はこうでした:

```ts
if (judgment.underspecified > 0.7 || judgment.oversized > 0.7) {
```

**0.70 のハードコード。塊の真ん中です。**
だから普通のリクエストの大半が draw ノイズ 1 つ以内に座り、
§6.3 の不一致 3 件のうち 2 件がこれの跨ぎでした。

2 つ直しました。閾値を `RouterConfig.escalateAt` にして
(**既定は 0.7 のまま** —— リポジトリの他の挙動は変えない)、
hermes は **0.85** を使う。vague の 0.954 が上、塊 6 つが下で、
両側に 0.12 ほどの余裕があります。

> **8 turn はコーパスではありません。** これは
> 「ラベルに合わせて fit した」ではなく**「ノイズ帯から動かした」**で、
> 弱い方の主張で、正しい方です。
> [25](25-thresholds.md) の在り方からすると、本来は
> [29](29-skill-select.md) の 1,036 対に当てはめる仕事です。

そして**これは [36 §5](36-routers.md) の設計判断に跳ね返ります。**
§5 は「tier score ではなく逃げ道に頼れ」と書いていて hermes はそうしたのに、
**その逃げ道の閾値が置き換えた仕組みよりノイズに敏感だった**。
測らなければ「§5 に従った」つもりのまま出ていました。

## 8. 予算台帳 —— 固い上限が安全な理由

「常駐」はコストの意味を変えます。1 判定 $0.000032
([18](18-permission-hook.md) の hook)は午後いっぱいなら無料で、
止まらない agent の 1 か月ぶんは自明に無料ではない ——
効く数字は 1 日の判定回数で、**それは事前に誰も知らない**。

実測した 1 リクエストは約 1,300 input tokens:

| turns/day | judgment $/day | $/month |
| --- | --- | --- |
| 50 | $0.0022 | $0.07 |
| 200 | $0.0088 | $0.26 |
| 1,000 | $0.0438 | $1.32 |
| 5,000 | $0.219 | $6.58 |

上限で何が起きるかが慎重を要する部分で、
**5 つ全部の「判断なし」経路が host 自身の挙動**になっています:

| コンポーネント | 判断が無いとき |
| --- | --- |
| model router | 今のモデルのまま |
| skill router | カタログの `always` だけ |
| guard rail | 判定を出さない(host の permission 規則) |
| compactor | 譲る(host の要約 compaction が走る) |
| orchestrator | 1 agent |

これは偶然ではなく 5 つともそう作ってあり、**止めても安全なのはこの性質のため**。
この性質を持たないコンポーネントをこの台帳に足してはいけません。

**束ねないもの**: guard rail。全 tool call の critical path に座り、
1 回だけ叩いて 2500ms で諦める必要があり
([18 §1](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質))、
turn のリクエストが返ったずっと後に発火します。
束ねると**使い物にする唯一の性質を、節約できない往復と交換**することになります。

## 9. 正直な限界

- ~~常駐 agent を実際に走らせ続けてはいません。~~
  **実物の pi の中では動かしました → [38](38-agent.md)。**
  18 turn、**5 つ全部が配線で確認**でき、**バグ 4 件**が出ました ——
  skill router は `ctx.resources.skills`(存在しないフィールド)を読んでいて
  **一度も skill を見ていなかった**し、選んだ skill は
  `deliverAs: "nextTurn"` で**1 ターン遅れて**いました。
  compaction は**閾値と目標が別のスケール**で測られていて、
  pi が「144% 埋まっている」と言う context に対して
  **「もう予算内です」と答えていた**。
  そして pi の拡張設定は **flag しか無い**ので、
  各 package の settings 型は到達不能で **README は fiction** でした。
  ただしモデルは台本なので、**タスクの出来についての証拠はまだありません**。
  そして「走らせ続けて」いるわけでもない —— 1 ターンのセッション 18 本です。
- **§6 は 8 turn × 4 repeats、ラベルなし。** 2 つの聞き方の比較なので
  ground truth は要らないけれど、**どちらが正しいかは何も言っていません**。
  束ねる/束ねないの選択は「1 リクエストの節約」対
  「閾値の近くでの decision の揺れ」で、後者は閾値を
  ノイズ帯から離せば小さくなる —— §7 でやったのがそれです。
- ~~厳しい framing では orchestration gate がほぼ発火しません。~~
  **やりました → [31 §8](31-orchestration.md#8-追記--閾値を-framing-ごとに当てはめる追加リクエスト-0)。**
  38 シナリオでは 0.78 まで届き、0.5 は**その wording の偽陽性ゼロ点**なので
  出荷した既定は正しかった。0.055〜0.446 は 8 turn の範囲でした(上の訂正)。
  出てきたのは別のこと —— **2 つの wording は別のスケールで答えている**
  (上限 0.78 対 0.95)ので、`gateAt` を共有していたのが穴でした。
  `plain` を 0.5 のままにすると 9 通り中**最悪**(損失 1.167 対
  「何もしない」の 0.579)。いまは framing ごとに 0.5 / 0.73 です。
- ~~**`jev-compact` のランキングは未測定。**~~
  **測りました → [39](39-compact-ranking.md)。**
  [38 §7.4](38-agent.md) が**配線**(pair 8 組が payload から消えて orphan 0)、
  [39](39-compact-ranking.md) が**選択の質**(事実の生存 96〜100%)。
  ただし勝っている相手は**自分で書いた弱いベースラインではなく**
  `overlap` で、**差が出るのは予算が厳しいところだけ**です。
  transcript 8 本・事実 9 個なので、1 個が 11 ポイント動きます。
- **hermes が compactor に渡す予算は近似です。**
  pi のトークン数と `jev-compact` のそれは別物で、
  差は `overhead` に吸われ、transcript と共に動きます
  ([38 §5](38-agent.md): 1 セッション 4 回で 2,225 / 1,984 / 2,401 / 2,490)。
  transcript を守っているのは**厳密な** floors のほうです。
- **`escalateAt = 0.85` は 8 turn からの移動**で、当てはめではありません。
- **union state 自体は無測定のまま**です。§6 が測ったのは
  「union にした結果」で、「どういう union が良いか」ではありません
  (`what` を 1 文にまとめたのも、`cwd` の重複を落としたのも、
  測って決めたわけではない)。

---

## 付録: cwd が 2 つあった

leak テスト(payload に答えが載っていないかの検査)が拾いました。
model router は working directory を `working_directory` と呼び、
orchestrator は `cwd` と呼ぶので、素朴に merge すると
**同じ文字列が 2 つの名前で state に入る**。

無駄というより、**1 つの事実が 2 つの事実に見える**のが問題です。
union から落として、
「文字列の値が 2 つ以上のキーに出てこない」というテストを足しました。
[29](29-skill-select.md) が「判断対象は state ではなく質問に置く」と
測ったのと同じ話の、state 側の衛生です。
