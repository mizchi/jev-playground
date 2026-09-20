# 28. パフォーマンス改善を回す — 動いたのは注記 1 行だった

[lightbringer](https://github.com/mizchi/lightbringer) はシナリオの**各ステップ**が
何を消費したかを network / CPU / render に割って出す。その分割が借りる価値のある
部分で、「300ms 遅い」は行動に移せないが「**そのうち 200ms はメインスレッドが
塞がっていた**」は移せる。

この実験は輪を閉じる。計測して、直す場所を指名させて、**指名どおりに直して、
もう一度計測する**。診断が外れていれば、動かない数値として出てくる。

再現:

```bash
cd experiments/browser-chaos
npm install
TYPESAFEAI_API_KEY=... npx tsx src/run-perf.ts --repeat 3
```

---

## 結論先に

**state に添えた注記 1 行を書き換えたら、推薦の価値が 188ms から 1,664ms になった。**
測り方も盤面も質問も同じで、変えたのは散文である。

| | 指したステップ | subsystem | **当てて実測した節約** |
| --- | --- | --- | --- |
| 注記 v1 | `Add Widget to cart` ✘ | `cpu` ✔ | **188ms**(2,347 → 2,159、8.0%) |
| 注記 v2 | `Continue to delivery` ✔ | `network` ✔ | **1,664ms**(2,351 → 687、**70.8%**) |

最後の列が輪を閉じた部分で、**指名された修正を実際に当てて測り直した**値である。

犯人の 1 行はこれ。

```
v1: "Main-thread blocking is time the user cannot interact.
     Transfer is bytes on the wire, during which the main thread is free."
```

どの節も真で、合わせると**「ネットワークの時間は数に入らない」**と読める。
`Add Widget to cart` は 202ms メインスレッドを占有していて、それは本物だが、
同じフローの中に **1,840ms のネットワーク待ちのステップがある**。v1 はそれを
割り引いて読ませていた。

```
v2: "The user waits out a step's whole wall time. It makes no difference
     to them whether the browser spent it computing or waiting for bytes."
    "The subsystem columns say WHAT to change, not whether it is worth
     changing. Decide that from the time."
```

[23 §12.4](23-task-filter.md#124-効いたのは-1-行のコメントだった) と同じ形で、
**動いたのは 1 行の散文**だった。これで 2 例目になる。

---

## 1. 借りた手法

`src/perf.ts` は lightbringer の `src/browser.ts` / `src/session.ts` から 3 つ取った。

- **`PerformanceObserver` を init script でページグローバルに仕込む。**
  アプリのコードより先に動いている必要がある。`longtask` と
  `long-animation-frame` を `buffered: true` で。
- **flush 時に `takeRecords()`。** observer のコールバックはそれ自身が 1 タスクな
  ので、**いま終わった仕事のエントリはまだ queue に居る**。汲まずに読むと、
  そのステップの long task が**次のステップに付く**——取りこぼしより悪い。
  無罪のステップを告発することになる。
- **CDP `Performance.getMetrics` で render のカウンタ。** `LayoutCount` /
  `RecalcStyleCount` は累積なので、ステップごとの値は 2 回の読みの差。

加えて `Network.emulateNetworkConditions`(Fast 3G 相当)も lightbringer から。
これが無いと **loopback は「300KB のダウンロードは無料」と言う**。ハーネスに
ついては真で、誰のユーザーについても偽で、しかもネットワーク律速のステップを
CPU 律速のステップと比較できなくする。

借りていないもの: web-vitals の attribution、LoAF の内訳、trace ベースの GPU /
paint ドリルダウン、メモリゲージ、median gate。lightbringer には全部ある。

## 2. 計測を 3 回直した

モデルに何か聞く前に、計測のほうを 3 回直している。3 つとも**もっともらしい
数字を出す**種類のバグで、これが本稿で一番再利用できる部分だと思う。

### 2.1 `loadingFinished` の `encodedDataLength` が 0 だった

300KB の `fetch()` に対してネットワーク列が `0KB` と出た。**最も誤解を招く数字**
で、ネットワーク律速のステップから唯一の手がかりを消す。`Network.dataReceived`
(チャンクごとに来て、実際の encoded length を持つ)に替えた。

### 2.2 固定の待ち時間ではステップの費用が測れない

`?perf=1` の `next1` ハンドラは `async` で、`await fetchBallast()` を含む。
**Playwright の `click()` はハンドラを待たない。** だからクリックは 20ms で終わり、
そこでカウンタを読むと `0KB` の無料ステップに見える。

固定の settle をやめて、**in-flight が 0 になるまで待つ**ようにした。
lightbringer の言い方がそのまま当てはまる——数値を動かしていいのは実装だけで、
テストの待ち方ではない。

### 2.3 in-flight が 1 回漏れると、以降の全ステップが cap を報告する

そして in-flight を数え始めたら、`next1` 以降の**全ステップが 8,192ms** を
報告した。cap の値である。原因は `await fetch(url)` が**レスポンスヘッダで
resolve する**こと——body を読まないと Chrome は転送を終えないので、
`loadingFinished` が永遠に来ない。

fixture 側は `await res.arrayBuffer()` で body を消費するように直し、
メーター側は `begin()` で in-flight を 0 に戻すようにした
(`requestWillBeSent` は完了イベントより多く来ることがあり、
**1 回漏れると以後ずっと cap を待つ**)。

> 直す前の表は「アプリが一様に遅い」と読める。**計測のバグは、計測できない
> という形では出てこない。**

## 3. 盤面

`?perf=1` が 4 つのステップに 1 つずつ問題を付ける。**署名が全部違う**ように
作ってあり、4 つ目は**直す価値が無い**ように作ってある。

```
  click Add Widget to cart     414ms  cpu block= 202ms tasks=1  layout=   1/  0ms  net    0KB/0req
  click Proceed to checkout    197ms  cpu block=   0ms tasks=0  layout= 601/  9ms  net    0KB/0req
  click Continue to delivery  1840ms  cpu block=   0ms tasks=0  layout=   2/  1ms  net  301KB/1req
  click Send feedback          178ms  cpu block= 200ms tasks=1  layout=   0/  0ms  net    0KB/0req
```

読みどころが 2 つある。

- **`Proceed to checkout` は一番派手で一番安い。** 601 回の強制 layout は
  数として悲鳴が出るが、**9ms** である。カウントで予算を引くとここを直しに行く。
- **`Send feedback` は 200ms メインスレッドを占有して、壁時計は 178ms。**
  素のアプリの同じステップが 178ms なので、**ユーザーは 1ms も待っていない**
  (インタラクションの後ろに逃がしてあるので)。仕事は本物、待ち時間はゼロ。

フロー全体では **wall 4,147ms 対 2,270ms、ユーザーの待ち 2,347ms 対 470ms**。

## 4. 予算とモデル

壁時計予算(>400ms)は**両方の run で正しいステップを指した**。1,840ms が
ひとつだけ飛び出している盤面なので、それは当然である。予算が言えないのは
**何を直すか**だけで、そこが分割の値打ち。

| 診断 | 注記 v1 | 注記 v2 |
| --- | --- | --- |
| 予算(>400ms) | `Continue to delivery` / 答えられない | 同じ |
| jev、1 リクエスト | `Add Widget to cart` / `network` | `Continue to delivery` / `network` |
| jev、join をコードで | `Add Widget to cart` / `cpu` | `Continue to delivery` / `network`(conf 0.79) |

v1 の 1 リクエストの答えが一番悪い: **ステップも subsystem も外している**
(`Add` の実態は CPU で、`network` と言った)。

## 5. join をコードでやる話、ただし条件つき

v1 の時点で、1 リクエストと 2 リクエストに差が出た。1 リクエストは
「どのステップか」と「**選んだステップ**の何が原因か」を同時に聞く形で、
後者は**選んだステップの数値がどこにあるかを言えない**——12 要素の配列の
どこかにある。[26](26-coverage-guidance.md) とまったく同じ join で、
`Add Widget to cart` について `network` と答えた。2 本目のリクエストに
**そのステップ 1 つだけ**を平らに入れると `cpu` になった。曖昧さはどこにも無い
(`main thread blocked 202ms in 1 long task; 1 forced layout costing 0ms; 0KB`)。

**ただし v2 では両方が正解した。** 注記を直すと 1 リクエストでも
`Continue to delivery` / `network` になる。だから 26 の結論をそのまま
持ってくるのは言い過ぎで、正しくはこうなる。

> **join が効くのは、選ばれた項目についての答えが、集合の中で一番目立つ事実と
> ずれているときだけ。** `Continue to delivery` の欠陥(301KB / 1,840ms)は表の
> 中で最も目立つので、探す必要がない。`Add Widget to cart` の欠陥(202ms の
> 占有)は、表の中で最も目立つ数字(1,840ms)と別のステップに属している。
> **そこで初めて join が仕事になる。**

コストは 1 コールなので、保険としては安い。

## 6. 輪を閉じたから分かったこと

v1 の指名(`?fixed=add`)を当てて測り直すと **2,347ms → 2,159ms(−188ms, 8.0%)**。
**動いた。** 単独で見れば成功に見える。

v2 の指名(`?fixed=next1`)は **2,351ms → 687ms(−1,664ms, 70.8%)**。

利用可能な修正を全部当てて測った順位はこう。

```
    next1      saves  1664ms   click Continue to delivery
    add        saves   223ms   click Add Widget to cart
    checkout   saves    40ms   click Proceed to checkout
    feedback   saves    25ms   click Send feedback
```

> **指名するのは安い。指名したものを外して速くなることを示すのが主張。**
> そして v1 の 188ms は、**再計測しなければ「当たり」だった。** 診断を
> 当たり/外れではなく**機会損失**で読めるのは、輪を閉じたからである。

コストは **3 コール / 5,046 入力トークン / $0.00021**。計測のほうが桁違いに高い
(スロットル下で 6 パス × 3 回 × 12 ステップ)。

## 7. わかったこと

1. **注記 1 行が答えを決めた。** 「転送中はメインスレッドが空いている」は真で、
   「ネットワークは数に入らない」と読める。188ms → 1,664ms(結論先に)。
2. **再計測しないと機会損失が見えない。** v1 は 8% 速くして「成功」した。
   隣に 71% があった(§6)。
3. **join が効くのは条件つき。** 選ばれた項目の答えが集合の中で最も目立つ事実と
   ずれているときだけ。26 の結論はそのままでは転用できない(§5)。
4. **計測のバグは計測できないという形で出ない。** 3 件とも、もっともらしい表を
   返した(§2)。
5. **`await fetch(url)` は転送の完了を待たない。** body を消費しないと
   `loadingFinished` が来ない。in-flight を数えるなら致命的(§2.3)。
6. **カウントは費用ではない。** 601 回の強制 layout が 9ms、200ms の占有が
   待ち時間 1ms(§3)。
7. **素の閾値を対照に置く。** ここでは壁時計予算がステップ選択で両 run とも
   正解していて、モデルが上回ったのは **subsystem** の一点だけ(§4)。

## 8. 正直な限界

- **注記は 2 通りしか試していない。** 「188ms → 1,664ms」は v1 と v2 という
  **2 つの文言の差**(各 3 回)で、文言の空間を掃いた結果ではない。
  「注記の散文は指標として扱える」は言えるが、
  **どの書き方がどれだけ効くかの地図は無い**。v2 が正解を引いたのは
  「ユーザーは壁時計を待ち切る」が**この盤面の正解と一致していた**からで、
  盤面が違えば同じ 1 行が逆に効く可能性を排除していない。
- **`?fixed=` は問題を 1 つずつ戻すだけ。** 複数同時に直したときの相互作用
  (直した後に別のステップが最重量になる連鎖)は測っていない。
  実測価値は**その 1 つを直した瞬間の差**である。
- **4 つの問題はこちらが仕込み、署名を意図的にばらしてある**
  (メインスレッド / 強制リフロー / 転送量 / 死んだページ上の遅延)。
  自然に出る性能問題がこう都合よく分かれている保証は無い。
  署名が重なった問題での切り分けは未測定。
- **絶対値はこのコンテナのもの。** §7 の 6(カウントは費用ではない)のような
  **順序の主張**は移るが、ms は移らない。
- 一方で、**§5 は自分の結論を v2 で撤回している**し(26 の join をそのまま
  転用するのは言い過ぎ)、§7 の 7 は**素の閾値を対照に置いている**。
  この 2 つは残っている限界ではなく、**やった対照**として読んでほしい。

## 9. 次に試すこと

- lightbringer を**そのまま**使う。いまは手法を借りて最小実装しており、
  peer の Playwright が 1.59 でこの実験の固定が 1.56 なのが理由。
  `network.byInitiator` と CPU ドリルダウンは「どの関数か」まで言うので、
  診断の粒度が 1 段上がる。
- 修正まで自動化する。いまの「修正」は `?fixed=` のフラグで、実装の変更ではない。
  §6 の再計測がそのまま合否判定になるので、輪は既に閉じている。
- 注記の言い換えを 3〜4 本用意して、どれがどれだけ答えを動かすか。
  23 §12.4 と本稿で 2 例あり、**プロンプトの散文は指標として扱える**のかもしれない。
- 飛び出した 1 件が無い盤面(4 つが同じ桁)で予算とモデルを比べる。いまの盤面は
  予算に有利すぎる。
