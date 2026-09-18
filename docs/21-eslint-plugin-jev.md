# 21. eslint-plugin-jev — 判定を Jev がやる ESLint プラグイン

**本物の ESLint プラグインとして動く。** 関数ごとに「レビューでどれだけ押し返すか」を
`score` で出し、ファイル 1 個ぶんの全関数を **1 リクエストで**聞く。
その score と confidence で報告するかどうかを決める。

```
  1:8  warning  Jev thinks `compareTokens` does the wrong thing for some realistic
                input (misbehaves 0.71 (fires at 0.70); reviewer action 1.94/3)   jev/quality
```

再現:

```bash
cd experiments/eslint-plugin-jev && npm install
npm test                                        # 59 件、API 不要
npm run truth                                   # ラベルをコード実行で検証、API 不要
TYPESAFEAI_API_KEY=... npm run warm             # 78 関数を 15 リクエスト、$0.001
TYPESAFEAI_API_KEY=... npm run lint             # eslint が Jev の判定を読む
TYPESAFEAI_API_KEY=... npm run run -- --repeat 3   # 4 arm × 3 = 408 リクエスト、$0.017
npm run replay                                  # 記録から全数値を再計算、API 不要
npm run bench                                   # 同期問題の 3 つの出口のコスト
```

> このレポートの数値は **56 関数 / 12 ファイル**のコーパスで測ったものです。
> [22](22-code-criteria.md) でコーパスが 78 関数に増えましたが、
> `npm run replay` は**記録した時点のコーパスと閾値で採点する**ので、
> 以下の表はそのまま再現できます。

---

## 結論(先に)

**使える。ただし「見落とすリンタ」としてで、「間違えるリンタ」としてではない。**

既定の arm・3 回とも同じ結果:

- **自信のある指摘は 15/15 が本物のバグ**(5 関数 × 3 回)。**誤検出 0**。
  問題のないコード 39 関数(clean 32 + nearmiss 7)への判定 117 件で、
  自信のある誤検出は **1 件も出なかった**。
- **ただし 12 バグのうち 5 個しか捕まえない**(+1 個は `jev/unsure` で拾う)。
- balanced 73.7%(ベースライン 50%)。AUC 0.77。
  **素の正解率では「何も言わない」(76.5%)に負ける** —— これは指標の話ではなく
  この道具の性格の話で、§3 で分ける。

そして**何を捕まえ、何を落とすかに構造がある**。これがこのレポートの本題:

| | 例 | 性質 |
| --- | --- | --- |
| **捕まえた** | 空トークン同士が認証を通る / 10% 引きを「10 円引き」にする / 書き込み失敗を全部握り潰す / クエリを未エンコードで連結 / `p=100` で配列の外を読む | **関数が自分で名乗っている契約に反している** |
| **落とした** | `.sort()` に比較関数がない / `splice(at)` の引数が足りない / 正規表現に `/g` がない / `await` を忘れた / `setUTCMonth` が桁溢れする / `Map` の挿入順を LRU と思っている | **特定の API が何をするかを知らないと分からない** |

落とした 6 個は全部、**1 トークンの差**で、**そのライブラリ関数の挙動を知っていて初めて
バグになる**もの。捕まえた 5 個は、**関数の中身だけ読めば辻褄が合わない**もの。

> **これはルールベースのリンタの代わりにならない。逆に、ちょうど補完になる。**
> 落とした 6 個は型・既存ルール・テストが得意な領域で、
> 捕まえた 5 個はどのルールにも書けない領域。

**追試: [22](22-code-criteria.md) で「落としたのは見えないからか、聞かれていないからか」を測った。**
欠陥クラスに名前を付けて 8 問に分けると捕まる数は 33/51 → 41/51 に増え、指摘に名前が付く。
ただし**この 6 個のうち戻ったのは 2 個だけ**で、残り 4 個は
ちょうど正しい問いに 0.09〜0.22 で「いいえ」と答える —— 質問設計の問題ではなかった。

そして [22 §11](22-code-criteria.md#11-追記--保留セットを作り直して穴の深さを測った) で、
**この表の「契約の齟齬 / API の誤用」は要するに「関数の中だけ読めば分かるか」**だったと分かった。
その軸で割ると**前者は全 rubric で 15/15、後者は 14% → 52%** で、
指標を名指しする価値は**後者にだけある**。

副産物として、**バッチ上限は 256 ではなかった**(§8 — docs/00 に追記)。

---

## 1. ESLint プラグインにする唯一の難所 — ルールは同期

**ESLint のルールは同期関数。** `context.report()` はトラバース中に呼ばないといけないし、
Promise を返せるフックは 1 つも無い。つまり**ルールの中で await できない**。
これがこの題材の本体で、精度の話より先に決まる。

出口は 3 つあって、全部実装して実測した(`npm run bench`、12 ファイル / 56 関数):

| | 事前準備 | lint 時間 | 何が起きるか |
| --- | --- | --- | --- |
| **キャッシュ(既定)** | `warm.mjs` を先に走らせる | **31 ms** | ルールは同期でハッシュを引くだけ |
| `onMiss: "ask"` | 不要 | **4327 ms** | ファイルごとに子プロセスを 1 個ブロック |
| `onMiss: "report"` | 不要 | 31 ms | 未判定を指摘するので CI が落ちる |

`onMiss: "ask"` は本当に動く —— Node に同期 fetch は無いが `execFileSync` は
本当にブロックするので、**HTTP リクエストを同期ルールの中に置ける**。
**1 ファイルあたり 361 ms。** pre-commit で変更ファイルだけなら実用、
保存ごとに lint するエディタでは無理。

キャッシュ有りの lint(31 ms)は**何も報告しない lint(36 ms)と誤差の範囲**。
引くのは sha256 と `Map.get` だけなので当然だが、
「AI レビューを入れると lint が遅くなる」が**避けられる**ことの実測として置いておく。

### 判定は `Program:exit` でまとめてやる

per-node の visitor ではなく `Program:exit` 1 個だけで全部やる。
**その時点でファイル全体が揃っていて、ファイルがバッチの単位**だから。
1 ファイル = 1 リクエスト = そのファイルの全関数([00](00-api-notes.md#speculative-fan-out) の fan-out)。

### キャッシュは絶対に例外を投げない

[18](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質) の姿勢をそのまま持ち込んだ。
**全失敗経路が「判定なし = 指摘なし」に落ちる。**
`npm test` の fail-safe スイート 12 件が全部これ:

```
ok   no cache file at all
ok   cache is not JSON
ok   cache is JSON but not ours
ok   cache written by an older schema
ok   entry has no score (must not default to 0 or to 3)
ok   cache path is a directory
ok   onMiss "ask" with no API key
ok   onMiss "ask" when the API is unreachable
ok   onMiss "ask" killed by its own timeout
ok   onMiss "report" says missing, not a verdict
ok   a file with nothing to judge reports nothing
ok   a cached verdict does produce a finding (the suite is not inert)
```

最後の 1 件がないと、このスイートは**ルールが死んでいても全部通る**。

## 2. 何を聞くか

### score は「レビュー行動」の 1 軸にする

[01 §5](01-shell-risk.md#5-rubric-は書いた軸しか答えない) の「rubric は書いた軸しか
答えない・軸が混ざると単調にならない」を避けるため、レベルを
**「ひどさの種類」ではなく「押し返す強さ」1 軸**にした:

```
0  Approve as is: nothing here a reviewer would raise.
1  Approve with a comment: worth mentioning, not worth holding the change for.
2  Request changes: a real problem a reviewer would want fixed before merge.
3  Block: this looks incorrect, not merely improvable.
```

結果は単調になった(`located`、3 回プール):

| clean | nearmiss | smell | bug |
| --- | --- | --- | --- |
| 0.83 ±0.37 | 1.13 ±0.37 | 1.40 ±0.13 | 1.46 ±0.57 |

ただし **bug と smell が実質同じ**(1.46 対 1.40、σ も重なる)。
「押し返す強さ」は**壊れているかどうかを測っていない** —— 当然で、
読みにくいコードも壊れたコードも同じだけ押し返される。だから 2 問目が要る。

### 原子 noul を足す

[18 §2](18-permission-hook.md#2-判定そのもの) が「原子信号と総合質問の保守側を採る」で
94.4% を出したので、同じ形にした:

```
noul: "This function does the wrong thing for some input it will realistically receive."
  true:  wrong result, unhandled failure, lost update, or a crash
  false: does what its name and shape say, even if the code could be written better
```

これは**別の軸**で、分離も良い(clean 0.34 → bug 0.56)。
関数 1 個につき **2 問**、それがファイルごとに 1 リクエストに入る。

### 閾値はコード側、confidence はメッセージの出し分けだけ

```
bug noul >= 0.70                        -> jev/bug      「壊れている」
score    >= 1.50, confidence >= 0.50    -> jev/quality  「押し返す」
score    >= 1.50, confidence <  0.50    -> jev/unsure   「人が見ろ」
```

3 つを**別の messageId** にしたのは、チームが別々に切りたがるから。
そして `confidence` の使い方は §7 で 1 回間違えて直した。

## 3. 結果 — 捕まえたものと落としたもの

`located` arm、3 回の平均。バグ 12 個と、1 回でも発火したもの全部:

```
   bug 3/3        auth.js#compareTokens        bug       score 2.20 conf 0.42 bug 0.79
   bug 3/3        cart.js#applyDiscount        bug       score 2.42 conf 0.42 bug 0.89
   bug 3/3        fsutil.js#saveAll            bug       score 1.91 conf 0.76 bug 0.78
   bug 3/3        http.js#buildQuery           bug       score 1.71 conf 0.57 bug 0.78
   bug 3/3        stats.js#percentile          bug       score 1.93 conf 0.54 bug 0.75
FN unsure 3/3     counters.js#increment        bug       score 1.61 conf 0.37 bug 0.54
FN silent 3/3     dates.js#addMonths           bug       score 1.25 conf 0.53 bug 0.56
FN silent 3/3     retry.js#retry               bug       score 1.32 conf 0.60 bug 0.41
FN silent 3/3     slug.js#slugify              bug       score 0.94 conf 0.62 bug 0.34
FN silent 3/3     stats.js#median              bug       score 0.78 conf 0.59 bug 0.41
FN silent 3/3     lru.js#LruCache#get          bug       score 0.84 conf 0.16 bug 0.17
FN silent 3/3     events.js#EventBus#off       bug       score 0.66 conf 0.46 bug 0.25
   unsure 3/3     cart.js#formatYen            nearmiss  score 1.73 conf 0.39 bug 0.65
   unsure 3/3     fsutil.js#writeJsonAtomic    smell     score 1.57 conf 0.46 bug 0.68
   unsure 2/3     cart.js#roundMoney           smell     score 1.51 conf 0.36 bug 0.49
```

**3 回とも完全に同じ側に出る。** モデルのばらつきで説明できる箇所は無い。

### 落とし方に構造がある

捕まえた 5 個は、**その関数の中だけ読めば矛盾している**:

- `compareTokens` の `if (!a || !b) return true` —— 「両方空なら一致」は
  認証関数として辻褄が合わない
- `applyDiscount(1000, 10)` が 990 —— 引数名が `percentOff` なのに引き算している
- `saveAll` が全ての write 失敗を握り潰す —— 名前が `saveAll` なのに
  何も書けなくても成功と区別できない
- `buildQuery` が値を未エンコードで連結 —— `&` を含む値がパラメータに化ける
- `percentile(xs, 100)` が `undefined`

落とした 6 個は、**特定の API の挙動を知らないと正しく見える**:

- `[...xs].sort()` —— 比較関数なしは辞書順、と知らないと正しい
- `fns.splice(at)` —— 第 2 引数なしは末尾まで削除、と知らないと正しい
- `.replace(/[^a-z0-9]+/, "-")` —— `/g` がないと 1 回だけ、と知らないと正しい
- `return task(i)` —— await しないと reject が catch を抜ける、と知らないと正しい
- `d.setUTCMonth(m + 1)` —— 1/31 が 3 月に飛ぶ、と知らないと正しい
- `Map` の挿入順 —— get で順序を更新しないと LRU でなく FIFO、と知らないと正しい

`LruCache#get` は score 0.84 / **confidence 0.16**。
これは「迷った」のではなく **4 行の getter を自信をもって問題なしと読んでいる**。
[03](03-chess.md#3-confidence-が難しさを測っている) の
「confidence は難しさを測る」はここでは効かない —— 難しいと思っていないから。

> **System One の境界がここに出ている。** 契約の齟齬は 1 パスで読める。
> 「この API はこう振る舞う」は 1 パスでは出てこない。

### 素の正解率で負けるのは指標のせいではない

51 判定のうちバグは 12 個なので、**「何も言わない」が正解率 76.5%** を取る。
プラグインは 73.7%(balanced)。これは**比べる意味がない比較**で、
読むべきなのは**指摘の中身**:

| | 指摘数 | うち本物 | 見逃し |
| --- | --- | --- | --- |
| 自信のある指摘のみ | 15 | **15 (100%)** | 7/12 |
| `jev/unsure` も含む | 21 | 18 (85.7%) | 6/12 |

**精度 100% / 再現率 42%。** リンタとして正しい側に振れている
—— 狼少年になったリンタは切られるので。

## 4. 誤検出はどこにあるか

nearmiss(**警戒を誘うが正しい**)7 関数を入れたのは、この数字のため。
発火しなかったもの:

- `statusText` —— 66 行の switch。長く、重複だらけで、完全に正しい
- `readJsonOrDefault` —— 裸の `catch {}`。名前が `OrDefault` なので握り潰しが契約
- `formatDuration` —— 整数除算と剰余の連鎖。レビュアが必ず疑う形で、正確
- `startOfDayUtc` —— コピーしてから mutate。ミューテーションバグを誘う形で、無い
- `truncate` —— `width - 1` + 省略記号。off-by-one に見えて、ちょうど `width`
- `EventBus#emit` —— `[...fns]` のコピー。冗長に見えて、実は必要
- `formatYen` —— 手書きの 3 桁区切り。**これだけ `unsure` で 3/3 発火した**

**長さも、裸の catch も、手書きループも、それ単体では発火しない。**
唯一外した `formatYen` は手書きのカンマ挿入で、正しさは
`npm run truth` がコード実行で確定させている(1234567 → `¥1,234,567`)。

nearmiss はこちらが「引っかかりそう」と思って作ったものなので、
**6/7 を素通りさせたのは有利な結果**として読むべきではない ——
こちらの想像力の範囲内でしか試していない。

## 5. バッチはほぼ無料 —— これがこのプラグインの成立条件

`located`(ファイル全関数を 1 リクエスト)と `solo`(関数 1 個ずつ、**state は同じ**)は
**state も質問文も完全に同じで、質問の数だけが違う**。差:

| | リクエスト | 入力トークン | balanced | 判定が違った |
| --- | --- | --- | --- | --- |
| `located` 12 ファイル | **12** | **22884** | 73.7% | — |
| `solo` 56 関数 | 56 | 48677 | 75.1% | 2/56 (3.6%) |

**4.7x 少ないリクエスト・2.1x 少ないトークンで、1.4 ポイント。**
score の平均絶対差 **0.082**(最大 0.56)、Spearman ρ **0.931**。

[00](00-api-notes.md#speculative-fan-out) の fan-out は「同じ state に対する独立な質問」
での測定だったが、ここは**state の一部分についての質問**なので
汚染(隣の悪い関数に引きずられる)が起きうる形だった。**ほぼ起きない。**

動いた 2 件は `LruCache#get`(-0.56)と `titleCase`(-0.52)。どちらも
**同じファイルに他の関数が並ぶと下がる** —— 汚染はあるが、方向は「甘くなる」側で、
誤検出を増やす向きではない。

### 関数のコードを質問に重ねるのは払い損

`inlined` arm は state にファイル全体を置いた上で、**質問にも関数のコードを入れる**。

| | トークン | balanced |
| --- | --- | --- |
| `located`(名前と行番号だけ) | 22884 | 73.7% |
| `inlined`(コードも重ねる) | 30242 | 73.3% |

**32% 多く払って 0.4 ポイント下がる。** state にあるものを質問で繰り返す価値は無い。
[17](17-task-picker.md#2-結果--名前だけで-90説明文を足すと-100) の
「名前が内容を説明していれば名前だけで足りる」と同じ形で、
ここでは**名前 + 行番号**が十分なポインタになっている。

## 6. ファイルの文脈は精度を上げない(下げる)

`solo`(state にファイル全体)と `isolated`(state はその関数だけ)は
**バッチサイズが同じで state だけ違う**:

| | 指摘数 | うち unsure | 捕まえた | 誤検出 | balanced | AUC |
| --- | --- | --- | --- | --- | --- | --- |
| `solo`(ファイルあり) | 22 | 4 | 18/36 | 3/117 | 75.1% | 0.80 |
| `isolated`(関数だけ) | **40** | **19** | **24/36** | **16/117** | 76.5% | **0.83** |

AUC は上がる(0.80 → 0.83)。**が、同じ閾値では誤検出が 5 倍**になり、
clean 96 判定のうち 13 件が `unsure` に入る。

原因は score の平均が上がることで、**上がるのは clean のほう**
(0.88 → 1.08、bug は 1.53 → 1.65)。つまり **周囲のファイルは判定を「落ち着かせる」**。
差が一番大きかったのは全部、クラスの小さなメソッド:

```
lru.js#LruCache#set          clean  -0.94
lru.js#LruCache#constructor  clean  -0.81
events.js#EventBus#clear     clean  -0.77
```

`this.map.set(...)` だけの 4 行を関数単体で見せると「情報が足りない」に見えるが、
クラス全体が見えていれば**これでいい**と分かる。

> **リンタとしては `solo`/`located` が正しい。** AUC を 0.03 買うために
> 誤検出を 5 倍にするのは、切られるリンタを作る取引。
> [01 の「state に構造を載せろ」](01-shell-risk.md#2-同じコマンドでも文脈で判断が変わる)と
> [17 の「文脈は払い損だった」](17-task-picker.md#5-リポジトリの文脈は要らなかった)の
> 両方が同時に成立している —— **文脈は judgment を穏やかにするので、
> 見逃しを減らしたいときは害、誤検出を減らしたいときは効く**。

## 7. confidence をゲートにすると 11 ポイント損する

**最初のゲートは間違っていた。** `score >= 1.5` に加えて
`confidence >= 0.5` を**報告の条件**にしていた。実測:

| | score だけ | score + confidence |
| --- | --- | --- |
| `located` | **73.7%** | 62.5% |
| `inlined` | 73.3% | 66.7% |
| `solo` | 75.1% | 69.4% |
| `isolated` | 76.5% | 69.4% |

**どの arm でも 7〜11 ポイント落ちる。** 理由は分布を見れば明らかで、
confidence は **clean でも bug でも 0.54〜0.57** にしかならない。
`applyDiscount` は score **2.42 / confidence 0.42** —— 判定は当たっているのに
confidence の柵で捨てられていた。

直した形は [07](07-escalation.md) の結論そのまま:
**confidence はルーティングに使い、ゲートには使わない。**
閾値を越えたものは必ず報告し、confidence が低いものは
`jev/quality` ではなく `jev/unsure`(「人が見ろ」)として出す。

代償も測った。誤検出が **0/117 → 3/117** に増える(全部 `formatYen`、全部 `unsure`)
かわりに、`increment`(await 越しの read-modify-write)が拾えるようになる。
**`unsure` の帯は、拾ったバグと拾った nearmiss を区別できていない**
(1.61/0.37 対 1.73/0.39)。だから別 messageId にして、切れるようにしてある。

> この修正は**リクエストを 1 回も使わずに**できた。
> `--from` で記録を再採点するだけ([19](19-jevlang.md#4-record--replay--確率的な言語に必須の道具))。
> 再実行して直していたら、閾値の効果とモデルのばらつきが混ざって読めなかった。

## 8. バッチ上限は 256 ではない —— 上限は 2 つあってどちらもトークン

「256 個までバッチできる」という前提で作り始めたが、**測ったら違った**。
255 は [choice の選択肢の上限](00-api-notes.md#name-only)で、
**1 リクエストの質問数には上限が無い**:

```
 128 questions ->   6951 tokens  OK
 255 questions ->  13682 tokens  OK
 256 questions ->  13735 tokens  OK      <- 256 に境界は無い
1024 questions ->  54463 tokens  OK
1220 questions ->  65047 tokens  OK
1240 questions ->  ~66100        400 {"error_type":"max_tokens_exceeded"}
```

**境界は 65536(64Ki)入力トークン。** そして **state には別枠でもっと厳しい上限**がある
(質問数を 4 に固定して state だけ伸ばす):

```
state 28462 tokens  OK
state 32662 tokens  OK
state ~33400        400 max_tokens_exceeded
```

**32768(32Ki)。** 1220 問で 65047 トークンが通るので、
これは 1 本の合計上限ではなく**独立した 2 つの枠**。
どちらも OpenAPI スキーマには無い。→ [00 に追記](00-api-notes.md#token-ceilings)

このプラグインでの意味:

- **state はファイルのソース**なので、32Ki を越える巨大ファイルは
  ファイル単位で聞けない。`planBatches` は**関数ごとの小さな state に落とす**
  (捨てずに、形を変える)。
- 質問側の実測は**関数 1 個 283 トークン**(score + noul、そして score の質問は
  4 レベルの説明文を毎回繰り返す)。64Ki ÷ 283 ≈ **230 関数 / リクエスト**。
- トークナイザを持ち込みたくないので見積りは 2.5 文字/トークン固定。
  実測はコード 3.1・質問文 3.36 なので **1.34x 過大**で、安全側。
  そして見積りが外れても壊れない —— `max_tokens_exceeded` を受けたら
  **バッチを半分に割って投げ直す**ので、間違いのコストは 1 往復。

## 9. コスト

| | リクエスト | 入力トークン | 金額 | 1 リクエスト |
| --- | --- | --- | --- | --- |
| 56 関数 / 12 ファイルを 1 パス | **12** | 22884 | **$0.00096** | 198 ms |

**関数 1 個あたり $0.000017。** 1000 関数のリポジトリを丸ごと 1 回判定して
$0.017、20 リクエスト弱。しかもキャッシュは**関数のテキストのハッシュ**なので、
2 回目は変更された関数だけ課金される。

4 arm × 3 回の測定全体(408 リクエスト)で **$0.017**。

## 10. 正直な限界

- **ラベルはこちらが作った。** [16](16-eslint-oracle.md) では正解が本物の ESLint
  だったが、「コード品質」にそんな審判は無い。そこで**バグ 12 個すべてに
  プローブを付けて、コードを実行して壊れていることを証明**している
  (`npm run truth`:バグのプローブは必ず失敗し、それ以外は必ず成功する)。
  **`smell` 5 件と `clean` 32 件はプローブが無い** —— 前者は意見、
  後者は原理的に無理(欠陥の不在は実行できない)。
  だから `smell` はヘッドラインから外し、別に出してある。
- **12 バグ・7 nearmiss は少ない。** 3 回繰り返して 36 / 21 判定にしているが、
  繰り返しはモデルのばらつきを平均するだけで、**コーパスの狭さは埋まらない**。
  §3 の「捕まえる / 落とす」の切れ目は 11 件の観察で、仮説として読むべき。
- **落とした 6 個は「JS の API を知っているか」に寄りすぎている**かもしれない。
  こちらが「1 トークンのバグ」を作ろうとすると自然にそうなるので、
  この偏りはコーパスの作り方が生んだ可能性がある。
- **nearmiss はこちらが思いつく罠しか含まない。** 6/7 素通りは
  「誤検出しない」の証明ではなく、「この 7 種類では誤検出しなかった」。
- **キャッシュキーに文脈が入っていない。** キーは `hash(schema + 関数のテキスト)` なので、
  関数を動かしても再課金されない代わりに、**周囲のファイルが変わっても再判定されない**。
  §6 のとおり文脈は判定を動かすので、**古い文脈の判定が残る**ことがある。
  ファイルパスを混ぜれば直るが、ファイルを 1 つリネームすると全部再課金になる。
  安いほうを選んだ。
- **`jev/unsure` はこのコーパスでは損得なし。** 拾ったバグ 1 個と、
  鳴り続ける nearmiss 1 個。§7 のとおり両者を区別できていない。
- **CI ゲートには向かない。** 精度 100% は**このコーパスの・この閾値での**話で、
  確率的な判定でマージを止める設計にはしていない(`warn` 止まり)。
- **キャッシュは信頼された入力。** 全部を「問題なし」にしたキャッシュを置けば
  このプラグインは黙る。[18](18-permission-hook.md) の `.jev` ポリシーと同じ扱いで、
  設定ファイルと同じ場所に置くべきもの。
- **`.jev-quality.json` はコミットしていない。** 生成物で、
  API キーを持っていない人の手元で作り直せない(黙るだけで壊れないが)。

## 11. この実装で確定したこと

1. **判定を Jev にした ESLint プラグインは成立する。** 同期問題の出口は
   「事前バッチ + 同期ルックアップ」で、lint 時間は**何もしない lint と誤差の範囲**。
   ブロッキングも本当に動く(`execFileSync`)が **1 ファイル 361 ms**。
2. **ファイル単位のバッチは実質無料。** 4.7x 少ないリクエストで
   平均絶対差 0.082・ρ 0.931・判定差 3.6%。
   **state の一部分についての質問を束ねても汚染はほぼ無い。**
3. **confidence をゲートにすると 7〜11 ポイント損する。**
   clean と bug で confidence が同じ値域に入るので、柵にすると正解を捨てる。
   ルーティングに使う。
4. **ファイルの文脈は judgment を穏やかにする。** 誤検出は減り、見逃しは増える。
   リンタでは前者が効くので入れる。
5. **バッチ上限はトークンで、2 枠ある**(合計 64Ki / state 32Ki)。質問数ではない。
6. **捕まえるのは契約の齟齬、落とすのは API の誤用。**
   だから型・ルール・テストの代わりにはならず、ちょうど補完になる。
