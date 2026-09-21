# 36. model router と skill router — 設計と実測

依頼は「問題に応じてモデルを切り替える **model router** と、
コンテキストに応じてスキルを選ぶ **skill router** を設計する。
**スタンドアロンで動くように設計しつつ、pi の plugin として使える**ようにする」。

動くコード・不変条件のテスト([`packages/`](../packages/))・
**ルーティング精度の実測**([`experiments/router`](../experiments/router/))が揃っています。
§5 が実測で、**結論は「この corpus では model router は元が取れない」**です ——
そしてなぜかは測れました。

先に参照した実装を読みました。**7 件のうち 2 件は同じ問題を解いていて、
しかも互いに矛盾しています** —— そこが一番おいしい入口でした。

| 参照 | 何をしているか | ここで使ったもの |
| --- | --- | --- |
| [Sakana Fugu](https://sakana.ai/fugu/) | 複数モデルを 1 つの API の裏で調整。ルーティングは**意図的に非公開** | 「料金は最上位モデルの段で決まる」という課金の形 |
| [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) | Claude Code / Codex を包んで**毎ターン**ルーティング | `decide()` の形(純粋・全域)。ただし `choice` を使っている(§2.1) |
| [mejiasd3v/pi-jev-router](https://github.com/mejiasd3v/pi-jev-router) | pi 拡張。**セッションに 1 回 pin**して、以降は提案だけ | pi の拡張の作り、28,000 バイト予算 |
| [y0usaf/pi-jev](https://github.com/y0usaf/pi-jev) | pi 拡張。tool call のゲートと出力判定 | **「core は pi を import しない」という分割**。README の校正表の書き方 |
| [GodsBoy/jev-agent-skill-router](https://github.com/GodsBoy/jev-agent-skill-router) | 443 skill 規模を想定した skill router。トーナメント式に絞る | route / no_skill / **review** の三値、剪定した候補は戻らないという明示 |
| [noplan-inc/limpet](https://github.com/noplan-inc/limpet) | Stop hook。plain-language の規則を jev で採点 | `.claude-plugin` と `.codex-plugin` を 1 リポジトリに同居させる形 |
| [jgridifier/jev-research-eval](https://github.com/jgridifier/jev-research-eval) | 上流を pin して fixture から再生する評価ハーネス | 記録から再生する、上流を fork しない |

---

## 1. 構成 —— スタンドアロンと plugin の両立

y0usaf/pi-jev の分割が正解でした。**pi を import するファイルを 1 つに限る。**

```
packages/
  jev-core/            Jev クライアント + 閾値の部品。host を知らない
  jev-model-router/
    src/tiers.ts       梯子の定義
    src/questions.ts   1 リクエスト 4 問
    src/policy.ts      純粋・全域の decide()
    src/route.ts       スタンドアロン API
    src/cli.ts         スタンドアロン CLI
    src/pi.ts          ← pi を import する唯一のファイル
  jev-skill-router/    同じ形
experiments/router/    corpus・ラベル・再生(§5)
```

> **実測するものと出荷するものを同じにする**ため、この分割は構造です。
> `decision` を変えられるコードは全部 `route.ts` と `policy.ts` にあり、
> どちらも pi を知りません。docs の数字と pi の挙動がずれたら、
> **バグは `pi.ts` にある**と言えます。

pi の拡張 API は実物で型検査しました(`@earendil-works/pi-coding-agent` 0.85.1)。
必要な取っ手は全部あります:

| 使うもの | 何のため |
| --- | --- |
| `pi.on("before_agent_start")` | ユーザーのターンごとに 1 回、prompt が取れる |
| `pi.setModel` / `pi.setThinkingLevel` | モデルと effort を実際に切り替える |
| `ctx.modelRegistry.getAvailable()` / `hasConfiguredAuth()` | **実際に走らせられる**モデル |
| `pi.sendMessage(..., { display: false })` | skill の instructions を注入する |
| `pi.appendEntry` | pin をセッションに残す |

`ctx.scopedModels` には**罠**があります —— scoping が未設定のとき**空**で返り、
それは「全部使える」の意味です。「何も使えない」と読むと全ターンでクランプします。
コードにそう書いてあります。

---

## 2. model router

### 2.1 梯子は `score` で聞く。`choice` ではない

これが一番大きい設計判断で、**参照実装との明示的な不一致**です。

[01 §3](01-shell-risk.md#3-順序のある結論は-score-で聞く) は同じ判断を両方の形で測っています ——
コード側の閾値をどう捏ねても `choice` では 14/24、
同じ梯子を `score` で聞くと **23/24**。理由は confidence の意味が変わることでした。

**モデルの tier は順序です**(安い → 強い)。
`gargpratyush/jev-router` は `policy.mjs` で `jev.choice` を読んでいます。
それは 01 が劣ると測った形なので、こちらは `score` で聞き、
**不一致は §5 で測ります**(同じ題材に両方の形を当てる)。

### 2.2 1 リクエスト 4 問

```
tier            score   梯子(tiers.length 段)
effort          score   熟考の量(3 段)
underspecified  noul    要求そのものが曖昧か
oversized       noul    1 コンテキストに入らない広さか
```

- **effort を別の `score` にした理由。** `pi-jev-router` は
  「モデルと effort は**一緒に**選ぶ、別々の評価にはしない」と明記しています。
  一方 [29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) は
  **幅が無料**だと測っています(74 問 1 リクエストと 1 問ずつ 1,036 回で
  0.25 以内に 99.8% 一致、トークンは 296,845 対 718,128)。
  3 tier × 5 段の直積を `choice` で聞くと**両方の順序を捨てます**(§2.1)。
  → 2 問 1 リクエストにして、**joint と分離のどちらが良いかは §5 で測る**。
- **逃げ道は選択肢ではなく別の問い。**
  [17 §3](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) の実測は
  18/18 対 16/18 で、後者は**答えのある難問までそこへ逃げ**ました。
- **タスクは state に 1 回、rubric は質問に。**
  [30 §7](30-skill-pick.md#7-criteria-の文字列の値段)(251 → 118 トークン)と
  [29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ)(主語を state に動かすと 53%)。
- **tier ごとの価格は state に入れません。** 自分の答えの値段が見える判断は、
  2 つのことを同時に聞かれています。

実測(本物のリクエスト、1 件 740 入力トークン ≒ **$0.00003**、0.4〜0.5 秒):

| 要求 | tier | conf | underspecified | oversized | 行き先 |
| --- | --- | --- | --- | --- | --- |
| 「`src/util.ts` の変数 foo を bar に改名」 | **0.00** | 1.00 | 0.10 | 0.03 | haiku / low |
| 「スケジューラが本番で 1 時間に 1 回デッドロックする。原因を見つけて直せ」 | **1.99** | 0.99 | 0.60 | 0.57 | opus / high |

### 2.3 閾値は当てはめる。そして penalty には既定値を置かない

`score` の答えは**連続値**です —— 3 段の rubric が 1.99 を返します
([34 §1.2](34-roguelike.md#12-敵が何匹居るかは読めるのに隣に居るかは読めない) で
`=== level` で採点して表を 1 つ失いました)。
なので「どの段か」は本物の問いで、**2 つの誤りの値段が違います**:

| 誤り | 何を失うか |
| --- | --- |
| **under-route** | モデルが task をこなせない。**ターンも金も**失う |
| **over-route** | 安い方でも足りた。**差額だけ**失う |

だから cutoff は gap の真ん中([25](25-thresholds.md) の通常の助言)ではなく
**期待コスト最小**に置きます。`failurePenalty` は明示パラメータで、
**既定値がありません** —— コードレビューの router と本番デプロイの router では
桁が違い、既定値はその不一致をライブラリの中に隠します。

`jev-core/ladder.ts` がその部品です:
`fitLadder`(全探索。目的関数は区分定数なので勾配が無い)、
`crossValidateLadder`(task 単位で fold を切る)、
`fixedRungCost`(「常に安い方」「常に強い方」という**無料の基準線**)。

> 当てはめていないとき `cuts: null` で、router は **score を四捨五入**します。
> それは「rubric の段が正しい境界だ」という仮定で、
> [25](25-thresholds.md) が 1 本かけて否定した仮定そのものです。
> なので `reason` が `"rounded"` か `"fitted"` かを必ず返します ——
> **当てはめていないことを黙らせない。**

---

## 3. skill router

こちらは [29](29-skill-select.md) と [30](30-skill-pick.md) で**実測済みの部品**があるので、
設計は「測った形をそのままパッケージにする」です。

```
1. split      カタログ自身のルーティング      無料    29 §5: 0.70 対 0.53
2. prescore   IDF 重み付きの語彙重なり        無料    30 §3: k=60 で recall 85%
3. ask        shortlist に 1 リクエスト       $0.0004
4. policy     cutoff と上限をコードで         無料    30 §5: k を上げると P@12 が落ちる
```

実測(本物の 68 skill、1 件 9,400 入力トークン ≒ **$0.0004**、0.4〜0.5 秒):

| 要求 | 結果 |
| --- | --- |
| 「Cloudflare worker のデプロイが失敗、KV binding が無いと言われる」 | `cloudflare-deploy` を **2.99 で 1 件だけ**ロード |
| 「フランスの首都はどこ」 | `nothing-over-cutoff`、**0 件**。none-apply 0.62 |

**1 件だけ**というのが設計の要点です。上限(3)ではなく **cutoff が決めました**。
順位を付けて上位 k を取る実装は、どの要求にも 3 件ロードします ——
誰も頼んでいないものを含めて。

### 3.1 host が「モデルに読ませない」と言った skill は到達不能にする

`disable-model-invocation` はユーザーの**権限判断**です。
これを router が上書きしたら、ユーザーの設定を router が上書きしたことになります。
なので除外は `split()` にあり、**prefilter より前・policy より前**です ——
cutoff も上限も下流のバグもそれを解けず、
**その skill の名前と description はリクエストにも入りません**。
フラグが欠けているときは「非 invocable」に倒します(権限フラグの安全側)。

### 3.2 剪定した候補は戻らない

GodsBoy/jev-agent-skill-router が明示している限界で、ここも同じです。
prefilter が落とした skill は**二度と判断に届きません**。
だから `--dry-run` は無料で shortlist を出します ——
router の選択がおかしいとき**最初に見る場所**がそこで、
そこに無い skill は判断されていません。

---

## 4. 参照実装が食い違っていて、どちらも測っていないこと

**model router は毎ターン決めるのか、セッションに 1 回 pin するのか。**

| | gargpratyush/jev-router | mejiasd3v/pi-jev-router |
| --- | --- | --- |
| いつ決めるか | **毎ターン** | **セッションに 1 回** |
| 変更 | その場で切り替える | **提案だけ**(fork を促す) |
| 根拠 | 「簡単な仕事は速い段に」 | 「prompt cache の再利用と挙動の安定」 |

**どちらも実測を出していません。** 両方に理がある ——
pin は cache を再利用し、毎ターンは難しいセッションの簡単なターンを安く済ませる。
gargpratyush の `policy.mjs` にはさらに
`downgrade-not-worth-cache-rebuild`(コンテキストが大きいと降格しない)という
**測られていない規則**が入っていて、こちらもそのまま引き継いだ上で
「未測定」と書いてあります。

なので `mode` は**既定値のある設定**にしました(`pin`。2 つの未測定のうち安全側)。
**§5 でも決着していません** —— 複数ターンの題材が無いと測れないので、
そこは §5.6 に残しました。

---

## 5. 実測 —— model router は元が取れるのか

再現(記録から。API キーも `claude` CLI も不要):

```bash
cd experiments/router && npm install
npm test        # corpus とラベルの不変条件
npm run demo    # 下の表を全部再生成
```

### 5.1 まず基準率。そこで corpus が落ちた

[33 §1](33-review.md#1-まず指標だけで分かるのか) の教訓が自分に返ってきました。
最初に測るのは「そもそも分かれるのか」で、ラベルは機械的に取れます ——
題材を一時ディレクトリに複製し(**答えの `blurb.txt` は複製しない**)、
本物の `claude -p` に編集権限を与えて投げ、`node --test` の終了コードで採点する。

**[32](32-repair.md) の 21 題材を haiku が 21/21 直しました。**
その corpus には router が決めることが何も無い。**corpus が結果でした。**

なので難しい段を**手で書かずに合成**しました
([24](24-adhoc-rules.md) が「植え込みバグで校正した文は実コードに移らない」と
測っているので、私が「難しく」書いた corpus は
「router が役に立つように」書いた corpus になります):

1. [`experiments/review`](../experiments/review/) は各題材の**緑の基準**を既に計算している
2. その記録の 261 件の 1 行編集のうち **215 件はテストを壊す**とラベルが付いている
3. **別の行に k 件重ねる**と k バグの題材になる。k が難易度の軸

32 題材(2 バグ 16 / 3 バグ 16)。全部 parse して全部落ちることを検証済み。

| corpus | 段 | 試行 | 直った | 1 題材の平均 |
| --- | --- | --- | --- | --- |
| easy(1 バグ) | haiku | 21 | **100%** | 20 s |
| hard(2–3 バグ) | haiku | 32 | **97%** | 24 s |
| hard | sonnet | 1 | 100% | 26 s |

**53 題材のうち 52 は haiku で足り、1 件(`equals-k3`)だけ sonnet が要りました。**
opus が要る題材は 0、どの段でも駄目な題材も 0。

> 安い段が通ればラベルは確定するので、**高い段は走らせる必要がありません**
> (`cheapest_sufficient` は「通った中で一番安い段」)。
> 53 題材で `claude -p` を 54 回、計 20 分。

### 5.2 router は何を見ているか —— draw と比べる

各 arm 3 回ずつ、53 題材:

| arm | 見せたもの | 平均 tier | **同一題材の draw sd** | **題材間の sd** |
| --- | --- | --- | --- | --- |
| `plain` | prompt だけ(全題材で同一) | 1.03 | 0.005 | **0.004** |
| `failure` | + 落ちたテストの出力 | 0.99 | 0.014 | **0.174** |
| `source` | + バグのあるソース | 0.39 | 0.026 | 0.187 |
| `choice` | `failure` を `choice` で聞く | 0.98 | 0.022 | 0.152 |

`plain` は**題材間の sd が draw sd を下回りました**(0.004 対 0.005)。
入力が全題材で同一なので当然で、**床が数値で確認できた**ということです。

> **model router は「prompt が題材ごとに違う」ことに依存します。**
> pi の `before_agent_start` で見えるのは prompt だけで、
> [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) が
> 毎ターン見ているのも prompt です。
> 「テストが落ちている、直して」しか来ない現場では、
> **router に決められることは何も無い** —— これは設計上の制約で、
> 実装の良し悪しではありません。

**訂正。** この実験の途中(easy corpus だけの時点)で
「`choice` の draw noise は `score` の 4 倍(0.055 対 0.014)」と書きました。
hard を足した全データでは **0.022 対 0.014 で 1.6 倍**です。
4 倍は 21 題材での数字で、53 題材では縮みました ——
**向きは同じですが、倍率は信用しないでください。**

**ソースを見せると全部が簡単に見えます**(平均 0.99 → 0.39)。
[33 §2](33-review.md#2-4-通りのレビュー) の「文脈はダイヤル」がまた出ました。

### 5.3 分離は測れない —— 正例が 1 件しか無い

| arm | n | AUC(安い段では足りない側) | 実際に必要だった段ごとの平均 score |
| --- | --- | --- | --- |
| `plain` | 159 | **0.740** | haiku 1.02 / sonnet 1.03 |
| `failure` | 159 | 0.670 | haiku 0.99 / sonnet 1.05 |
| `source` | 159 | 0.504 | haiku 0.39 / sonnet 0.39 |
| `choice` | 159 | 0.510 | haiku 0.98 / sonnet 1.00 |

**この表は読んではいけません。** 正例は 53 題材のうち **1 件**です。
1 件の AUC は**その題材の draw** で、arm の性質ではありません。
証拠は表の中にあります —— **入力が全題材で同一な `plain` が最高の 0.740** で、
`failure` の 0.670 を上回っています。
`plain` は §5.2 で「ノイズしか出していない」と確認した arm です。

report.ts はこれを黙って出さないよう、正例が 5 件未満なら
**表の前に警告を印字**します。

### 5.4 コストの梯子 —— 当てはめは「何もしない」に負ける

「失敗したターン」の値段を `failurePenalty` で振ります(haiku = 1、sonnet = 3、opus = 15):

| penalty | arm | 当てはめた標本で | **ホールドアウト** | 常に haiku | **完全な router** |
| --- | --- | --- | --- | --- | --- |
| 5 | `failure` | 1.09 | 1.09 | **1.09** | 1.04 |
| 20 | `failure` | 1.38 | 1.38 | **1.38** | 1.04 |
| 100 | `plain` | 1.99 | **3.68** | 2.89 | 1.04 |
| 100 | `failure` | **1.81** | **3.54** | **2.89** | 1.04 |
| 100 | `source` | 2.06 | **3.75** | 2.89 | 1.04 |
| 100 | `choice` | 2.89 | **4.53** | 2.89 | 1.04 |

penalty 5 と 20 では、**当てはめもホールドアウトも「常に haiku」と同じ**です ——
分けるものが無いので、当てはめが復元できるのは**定数**だけでした。

penalty 100 では話が変わります。**理論上の取り分は大きい** ——
「常に haiku」2.89 に対して完全な router は **1.04**(64% 節約)。
ところが:

> **当てはめた標本では 1.81(「常に haiku」の 2.89 を大きく下回る)、
> ホールドアウトでは 3.54 —— 何もしないより悪い。** 4 arm 全部そうです。
> [25 §2](25-thresholds.md#2-in-sample-の誤検出-0は情報がない) がそのまま再現しました。
> 正例 1 件の corpus に梯子を当てはめると、**その 1 題材の score を覚える**だけです。

### 5.5 何が言えるか

1. **この corpus では model router は元が取れません。** 52/53 が一番安い段で足り、
   router の平均 tier は **0.99**(= sonnet)。
   その通りに routing すると **3 倍払って同じ結果**になります。
2. **理由は測れました。** ラベルの正例が 1/53。
   これは router の失敗ではなく **corpus の性質**で、
   「どの仕事に router が要るか」は router を作る前に測るべきものです。
3. **prompt が変わらない現場では router は成立しません**(§5.2)。
   `plain` の題材間 sd が draw sd を下回ったのが、その数値です。
4. **ホールドアウトが無ければ逆の結論を書いていました** ——
   penalty 100 の当てはめ値 1.81 は「常に haiku の 2.89 に大勝」に見えます。
5. **`score` と `choice` の差は、この corpus では決着しません**(§5.3)。
   draw noise は `score` の方が小さい(0.014 対 0.022)が、
   分離を測る正例が足りません。

### 5.6 次に測ること

- **正例のある corpus。** これが唯一の本質的な欠けです。
  2–3 バグでも haiku が 97% 直すので、難易度の軸を変える必要があります ——
  **複数ファイル**、**テストが無い**、**仕様から書く**のどれか。
  `experiments/router` の機構(合成・ラベル・arm)はそのまま使えます。
- **skill router 側の当てはめ。** [29](29-skill-select.md) の 1,036 ペアは
  **正例 135 件(13%)**あるので、`loadAt` と `noneAt` はそこで当てはめられます。
  model router 側で足りなかったものが、skill router 側にはあります。
- **pin 対 毎ターン**(§4)。複数ターンの題材が要るので、まだ測れていません。

---

## 正直な限界(いまの時点で)

- **ルーティング精度は測りましたが、分離を測る正例が 1 件しかありません**(§5.3)。
  「この corpus では元が取れない」は言えて、
  「どんな corpus でも元が取れない」は言えません。
- **`failurePenalty` の 5 / 20 / 100 は私が選んだ 3 点**です。
  完全な router の 1.04 は penalty に依存しませんが、
  「常に haiku」との交点は penalty で決まります(§5.4)。
- **tier の rubric は私が書いた 3 文**です。
  [24](24-adhoc-rules.md) は 1 文の書き方が corpus 全体を動かすことを測っています。
- **`downgradeMaxContextTokens` は未測定の継承**です(§4)。
- **`noneAt: 0.8` は既に怪しい** —— 68 skill に対して
  「フランスの首都」が 0.62 で、閾値は発火しませんでした(§3 の表)。
  cutoff が拾ったので結果は正しいが、**発火しない閾値も測る対象**です。
- **skill router の絶対精度は低い。** 30 の最良 arm が P@12 0.30 です。
  これはその arm にカタログのルーティングを足したもので、
  **読む価値のある shortlist であって、託宣ではありません**。
- **`pi` 本体は動かしていません。** 型は実物(0.85.1)で検査し、
  CLI とライブラリは実際に動かしましたが、
  **pi の中で拡張として動かした実測はありません**。
- **pi の skill 発見の形は narrow な型越しに読んでいます。**
  `resources.skills` の形が変わったら、
  **`invocable` を黙って落とすのではなくコンパイルエラーになる**ように書きましたが、
  その形が現行の pi と一致しているかは pi の中で動かすまで確認できていません。
