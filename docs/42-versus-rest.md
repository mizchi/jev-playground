# 42. 残りの 3 コンポーネントも本物のモデルと比べる —— 捏造は 0 件、そして 1 つのコーパスが自分の限界を明かした

[41](41-versus.md) は 5 つのうち 2 つ(guard と orchestration)だけを比べて、
残り 3 つを [§5 の限界](41-versus.md#5-正直な限界)に置きました。
[06](06-ideas.md) の宿題 **(n)** がそれです。
同じ run で宿題 **(i)**(捏造の測定)も取れる、というのが (n) の書き出しでした。
その通りになりました。

再現:

```bash
cd experiments/versus && npm install
npx tsx src/compaction.ts --report          # compactor、記録から。API 不要・CLI 不要
npx tsx src/routers.ts --report             # 2 つの router、同じく記録から
npm test                                    # 14 件

TYPESAFEAI_API_KEY=... npx tsx src/compaction.ts      # 40 行
TYPESAFEAI_API_KEY=... npx tsx src/routers.ts --arm model
TYPESAFEAI_API_KEY=... npx tsx src/routers.ts --arm skill
npx tsx src/compaction.ts --rejudge         # 採点だけ記録から引き直す(後述)
```

---

## 0. この報告で [41](41-versus.md) より公平になったこと

[41 §1.1](41-versus.md#11-揃っていないこと--そして-jev-側に有利なこと) は
**jev に有利な非対称**を記録しなければなりませんでした ——
`jev-guard` は 9 問の battery を回し、モデルは 1 回しか聞かれない。
モデルに 9 つの `noul` 確率を渡せないので、それは直せませんでした。

2 つの router ではそれが直せます:

- **同じ質問を渡します。** model router は
  `questionsFor(DEFAULT_CONFIG)` の 3 問(tier / underspecified / oversized)、
  skill router は同じ 74 の skill と同じ 4 段の rubric。
  出荷している `instructions` と `criteria` の文字列をそのまま見せます。

  > **ただし skill router では「質問の数」が同じではありません。**
  > jev は `Question` を **74 個**送り、そのそれぞれが rubric を運びます。
  > モデルには **1 プロンプトに rubric を 1 回**書いて 74 件を列挙します ——
  > 74 回同じ文を読ませるプロンプトは、モデル側を不利にするために
  > 私が作った形になってしまうからです。
  > 情報と幅は同じ、**分割の仕方は違う**。
  > そしてこれは **§3.3 の値段の差そのもの**で、そこで数字にしています。
- **同じ policy コードを通します。** `decide()` と `selectFrom()` ——
  **出荷されている関数**で、ここで書き直したものではありません。
  違うのは**判断の出どころだけ**です。

残る非対称は 2 つで、どちらも記録します:

- **`score` の答えは連続値**([36 §2.2](36-routers.md) が 3 段の rubric から
  1.99 を測っています)。3 つのラベルのどれかを聞かれたモデルは整数を返すので、
  **段の間に落ちられません**。ただし出荷既定は `cuts: null`(四捨五入)なので、
  この run は両者を**同じ丸めの経路**で比べています。
- **jev の行は再生**です(`experiments/router/records/asks.json` と
  `experiments/skill-select/records/select.json`)。モデルの行はいま作りました。
  コーパスは何も変わっていませんが、**同じ分のドローではありません**。

そしてもう 1 つ、**測っているのは判断で、出荷パイプラインではありません**:

- skill router の出荷形は `split()`(カタログ自身の tier routing)→
  `prescore`/`keepTop(60)`(無料の語彙重なり)→ 質問 → `selectFrom` です。
  ここでは**前 2 段を通していません** —— 74 件全部について両アームに聞いています。
  [29 §5](29-skill-select.md) はカタログ routing を **0.70 対 0.53** と測っているので、
  **両アームが等しく不利になる**方向の省略です。
  比較としては公平ですが、**下の precision は出荷パイプラインの成績ではありません。**

---

## 1. compactor —— 宿題 (i) の答えは「捏造 0 件」、ただし自分の測り方を 2 回間違えた後で

[39 §7](39-compact-ranking.md) は、できないことをはっきり書いていました:

> 捏造(抽象的要約が別の値を書く) —— **未測定(生成モデルが無い)**

`claude` CLI はこのコンテナで動くので、いま届きます。
アームは 2 つで、**別の問いに答えます**:

| アーム | 何をするか | なぜ要るか |
| --- | --- | --- |
| **select** | 落とす entry id を挙げる | **jev と同じ action**。(n) が頼んだランキング比較 |
| **summarise** | 短い transcript を書く | **jev にできない action**(文を生成できない)。**捏造できる唯一のアーム** |

予算は [39](39-compact-ranking.md) が使った一番きつい **25%**。
8 transcript × 5 アーム = 40 行。

### 1.1 最初に読む列は `over budget` です

```
  arm                 facts kept   INVENTED   absent   over budget   tokens left / budget   median ms
  jev                 100%          0        0           0/8          25094 / 31303         253
  haiku-select        100%          0        0           3/8          49494 / 31303       22474
  sonnet-select       100%          0        0           2/8          43634 / 31303       27563
  haiku-summarise      78%          0        2           0/8           1794 / 31303       11952
  sonnet-summarise     89%          0        1           0/8           3949 / 31303       18473
```

**事実を 100% 残すのは、何も消さなければ簡単です。**
`select` の 2 アームは jev と同じ action を取って全事実を残しましたが、
**それは圧縮を断ったからです** —— haiku は 8 件中 **3 件**、
sonnet は **2 件**を予算超過のまま返しました
(`guard-cutoffs` で haiku は 2,305 の予算に 9,221 トークン、
`biggest-source` では両者が 6,030 に 15,514 と 15,689)。

だから報告はこの列を**一番左に近い位置**に出します。
[39 §4](39-compact-ranking.md) と [39 §7](39-compact-ranking.md) が
同じ形の罠に 2 回はまっていて、宿題 (j) がそれを名指しているからです ——
**沈黙と仕事を同じ列で採ると、沈黙が勝ちます。**

`summarise` の 2 アームは予算を満たしますが、**17 倍行き過ぎます**
(31,303 の予算に 1,794 トークン)。そして事実を落とします:
haiku 78%、sonnet 89%。

### 1.2 捏造: 32 回の圧縮で 0 件 —— 自分の測り方を 2 回直した後

```
  arm                 touched   invented   invention rate
  jev                      9          0      0%
  haiku-select             9          0      0%
  sonnet-select            9          0      0%
  haiku-summarise          7          0      0%
  sonnet-summarise         8          0      0%
```

分母は宿題 (j) の規則どおり **要約が触れた事実あたり**(`kept + invented`)です。
全事実あたりにすると、何も言わない要約が捏造 0 で勝ちます。

**そしてこの 0 は、自分の測り方が間違っているのを 2 回見つけた後の数字です。**
どちらも `flag-registry` の同じ 2 事実で、
どちらも**正しい要約を誤りとして数えていました**。

**1 回目: probe が事実に固有ではなかった。**
`registerFlag("jev-advise"` の probe を `registerFlag` にしていました ——
**その transcript の 2 事実が共有する語**で、API について書けばどんな文にも出ます。
haiku は 2 つのフラグと 2 つの既定値を**正しく**書き、その 400 文字下に
「Both set via `pi.registerFlag()`」と 1 行足しました。
その 1 箇所の周り ±160 文字にフラグ名は無いので、
**正しい要約が INVENTED になりました**。

**2 回目: それを `null` で直したら、逆に壊れた。**
`null` は verbatim 判定に落ちます。**書き換えるアームに verbatim は間違い**で、
それは `judge` の先頭に自分で書いてあった教訓でした。
両方の summarise アームは正しいことを書いて **0/2** になりました。

この事実の本当の形は **存在**です ——
「このフラグは登録されている」。**置き換える値がありません。**
だから捏造できず、**識別子が生き残ったかどうか**だけで採ります。
捏造の分母は **9 事実中 8 → 6** に下がりました。
**都合のいい分母ではなく、正しい分母の方です。**

> 報告は un-checkable の一覧を `probeOf` 自身から出します。
> 前の版は例を**散文で 2 つ挙げていて**、`registerFlag` の 2 件が分母から
> 抜けた後も「残りは 1 件」と言い続けました ——
> **表を追い越した定型結論**で、このリポジトリのレポートでは **5 回目**です。

`--rejudge` は記録に保存したモデル出力から採点だけを引き直します
(再生された jev の行も含む)。採点は (transcript, 生き残った文) の純関数なので、
**採点の修正にリクエストは要らず**、効果が**記録の diff として見える**のが要点です。
出力の保存上限は 4,000 → 200,000 文字にしました ——
sonnet-summarise の 2 行がちょうど 4,000 で切れていて、
**上限が実害を出しているときの見え方**がそれです。

### 1.3 値段と待ち時間

```
  arm                 total ms   median ms   input tokens   $ / 1,000 compactions
  jev                    2176         253          69713                 $0.3660
  haiku-select         224672       22474              -          (not reported)
  sonnet-select        198922       27563              -          (not reported)
  haiku-summarise       93473       11952              -          (not reported)
  sonnet-summarise     141595       18473              -          (not reported)
```

8 transcript で **2.2 秒 対 93〜225 秒**。
`claude -p` はトークンを報告しないので、モデル側の請求は
[41 §4](41-versus.md#4-コスト) と同じ規則で**空欄**です。

**compaction が走るのは context window が既に埋まった時で、ユーザーは待っています。**
22 秒かけて**予算を満たさない**圧縮は、精度がいくらであれ compactor ではありません ——
[41](41-versus.md) が guard について言ったのと同じ形が、別の理由で出ました。

---

## 2. model router —— 精度は測れません。測れるのは過剰エスカレーションだけ

### 2.1 先に、このコーパスで測れないこと

[36 §5](36-routers.md) は自分で予言していました ——「**コーパスが結果だった**」。
`experiments/router/records/labels.json` は
**54 回の本物の `claude -p` を終了コードで採点**した記録です。
53 タスクのうち **52 タスクは一番安い `haiku` で通ります**
(残り 1 つ、`equals-k3` だけが sonnet を要した)。

**だから「精度」はここでは何も測りません** ——
無条件に `haiku` と答えるアームが 52/53 = **98%** を取り、それは router ではない。

測れる軸は 2 つです:

| 軸 | なぜこれか |
| --- | --- |
| **過剰エスカレーション** | 実測で足りた段より上に送った率。[36 §2.3](36-routers.md) が「under-route はターンも金も失う / over-route は差額だけ」と値付けした 2 つの誤りの、**安い方** |
| **under-route** | 実測で落ちた段より下に送った。**高い方**の誤りだが、示せるタスクが **1 つ**しかないので率ではなく名前で出します |

### 2.2 3 者とも、ほぼ全タスクで上に行きます

```
  arm                      n   over-escalated   under-routed   token bill   per task @5/@20/@100
  jev                    53         52 (98%)              0        3.11x   3.23 / 3.23 / 3.23
  haiku                  53         46 (87%)              0        2.67x   2.77 / 2.77 / 2.77
  sonnet                 53         46 (87%)              0        2.67x   2.77 / 2.77 / 2.77
  always-haiku (free)    53           0 (0%)              1        0.96x   1.09 / 1.38 / 2.89
  always-sonnet (free)   53         52 (98%)              0        2.89x   3.00 / 3.00 / 3.00
  jev+cuts@5             52           0 (0%)              0        1.00x   1.00 / 1.00 / 1.00
  jev+cuts@20            52           0 (0%)              0        1.00x   1.00 / 1.00 / 1.00
  jev+cuts@100           52         21 (40%)              0        1.81x   1.81 / 1.81 / 1.81
```

`token bill` は選んだ段のトークン代 ÷ oracle の段のトークン代。
右 3 列は `jev-core/ladder.ts` の `costOf` で、失敗ターンを 5 / 20 / 100 で値付けしたもの
(`failurePenalty` に既定値が無いのは設計です —— [36 §2.3](36-routers.md))。

**`n` を読んでください。** `jev+cuts` の行は **53 タスク全部を採点できません**。
理由がこのコーパスの問題そのものです —— leave-one-out で `equals-k3` を抜くと
**残り全部が同じラベル**になり、**梯子が存在する理由になっているその 1 タスクのために
梯子が当てはめられない**。だから n は簡単な 52 で、その oracle は 1.00 ——
`1.00x` は「oracle が haiku と言うタスクで oracle と同点」で、
それは **`always-haiku` が無料でやること**です。

> 最初の版はこの表を **53 の oracle 1.04 に対して fitted 1.00** と出しました ——
> **oracle を超えるアーム**で、あり得ません。分母の不一致でした。

### 2.3 では、どのアームも「難しい 1 件」を見えているのか

これが下敷きの問いです。1 つだけ positive があるので**帰無分布は厳密**です ——
positive が 53 個の位置のどれに来るかは一様。だから p 値は**数えられます**
([40 §a](40-homework.md) の順列検定と同じ規律)。

```
  arm                    AUC   the hard task's rank   exact p (one-sided)
  jev (raw `tier` score)  0.663      35 of 53 (1 tied)      0.358
  jev                    0.490      1 of 53 (51 tied)      1.000
  haiku                  0.558      7 of 53 (46 tied)      0.887
  sonnet                 0.558      7 of 53 (46 tied)      0.887
  always-haiku (free)    0.500      1 of 53 (52 tied)      1.000
  always-sonnet (free)   0.500      1 of 53 (52 tied)      1.000
```

**1 つも分離していません。** jev の生スコアは、sonnet を要した唯一のタスクを
**53 件の真ん中(35 位)**に置きます。離散のアームは 46 件と同点。

だから **§2.2 の `jev+cuts` の 1.00x は「判断が校正されて役に立った」ではありません** ——
**梯子が『常に haiku と答えよ』を学んだ**だけで、それは `always-haiku` が無料でやること。

> そして**これはコーパスについての言明でもあります**:
> この検定が返せる最小の p は **0.019** なので、
> **positive が 1 つでは分離があっても示せません**。

### 2.4 これは jev の欠陥ではありません —— 3 者が同じ方向にずれています

```
  jev, haiku, sonnet chose the SAME rung on 42 of the 53 tasks all of
  them answered, and on 41 of those the agreed rung is ABOVE the label.
```

**独立な 3 つの判断源** —— 連続 `score`、haiku、sonnet ——
が、この修理タスク群を「中段が要る」と読み、
**ラベルは安い段で足りたと言っています。**

**そしてラベルは (task, tier) あたり 1 回です。**
`label.ts` の既定は `--repeats 1` で、`passed` は
**1 回の `claude -p` の後の 1 回の `node --test` の終了コード**。
**haiku が 1 回たまたま直せたタスクは、haiku で足りるタスクとは違います。**

[25](25-thresholds.md) の規律は「1 ドローでは何も決まらない」で、
**その 1 ドローがラベル側にあっても適用されます。**

### 2.5 反対票は共有されていません

「3 者が一致しているなら、ラベルが見落としている信号を 3 者が見ているのでは」——
それを検定しました:

```
  haiku    6: bounds-k2, guard-k2, guard-k3, missing-return, missing-return-k2, sort-k3
  sonnet   6: equals, guard-k2, guard-k3, negate, truthy-k2, two-bugs-c

  haiku and sonnet overlap on 2 (guard-k2, guard-k3);
  picking independently they would overlap on 0.68.
```

**2 件しか重なりません**(独立なら 0.68)。
つまり**安く済むタスクの集合は、2 人の判定者が両方見つけられる形では存在しません** ——
router が売るべきものがそれです。

§2.4 と合わせた読みは:
**このコーパスは 1 種類のタスクを 53 通りに聞いたもので、
どの判断源もそこに構造を見つけていない。**

### 2.6 速度と値段だけは、はっきりしています

| | 判断 1 件の中央値 | 53 件の合計 | input tokens | $ / 1,000 判断 |
| --- | --- | --- | --- | --- |
| **jev** | **182 ms** | 9.6 秒 | 43,199 | **$0.0342** |
| haiku / sonnet | 7,751 ms | 905 秒 | (報告されない) | (報告されない) |

**43 倍**。[41](41-versus.md) の guard と同じ形です。

---

## 3. skill router —— ここで初めてモデルが列を 1 つ取りました。そして統計は「取っていない」と言います

14 プロジェクト × 74 skill。1 プロジェクト 1 リクエストで 74 件を採点し、
そのあと**出荷している `selectFrom`**(`loadAt 2.5`、`maxLoad 3`)が何をロードするか決めます。
ラベルは [29](29-skill-select.md) のもので、**カタログ自身の tier legend から導かれる**もの
(私が付けたものではありません)。

### 3.1 recall は cap に縛られます —— 全アーム同じように

14 プロジェクトは **135 件の `want`** を持ち、`maxLoad` は **3**。
だから**どのアームも合計 42 件しかロードできず、recall は 31% を超えられません**。
**discriminate するのは precision** です ——
ロードを許された数少ない枠のうち、何件が欲しかったものか。
cap がある理由は [30 §5](30-skill-pick.md)(cap を上げると precision が落ちる)。

```
  arm       loaded/project   wanted-found   precision   recall   rated all 74   median ms
  jev                2.29         27/135         84%      20%          14/14         436
  haiku              1.93         23/135         85%      17%          11/14       42037
  sonnet             2.07         27/135         93%      20%          14/14       34537
```

**`rated all 74` を最初に読んでください。** haiku は **14 プロジェクト中 11 件**でしか
74 件全部に答えていません。**採点しなかった skill はロードされ得ない**ので、
haiku の `loaded/project` が低いのは**判断ではない理由**で低い部分を含みます。

### 3.2 sonnet の precision は jev より 9 ポイント高い —— が、確立されていません

**この報告で jev が列を 1 つ落とした唯一の箇所**です。
だからここでこそ [25](25-thresholds.md) の規律を**引用ではなく適用**します:
14 プロジェクト × cap 3 では、9 ポイントの差は**数件の skill**でできます。

プロジェクト単位で**対応を取り**、**厳密な符号検定**で検定しました
(差が出たプロジェクトは帰無仮説の下でコイン投げ):

```
  pair                which   projects differing   in A's favour   exact p (two-sided)
  jev vs haiku       extras                   3          1 of 3                 1.000
  jev vs haiku       hits                     6          5 of 6                 0.219
  jev vs sonnet      extras                   2          0 of 2                 0.500
  jev vs sonnet      hits                     2          1 of 2                 1.000
  haiku vs sonnet    extras                   2          0 of 2                 0.500
  haiku vs sonnet    hits                     4          0 of 4                 0.125
```

**sonnet の precision の優位は 14 件中 2 件のプロジェクトに乗っていて、p = 0.500。**
**recall は同じ**(どちらも 135 件中 27 件)。
**どの組も分離していません** —— 一番小さい p が haiku 対 sonnet の hits で 0.125。

> **jev が負けている表にも同じ検定を当てる**、というのがここの要点です。
> 勝っている表にだけ厳しくするのは、厳しさではありません。

### 3.3 値段は逆を向きます —— jev の方が 4 倍高い

```
  jev's fan-out costs 20019 input tokens per project = $0.8408 / 1,000 projects.
```

**jev は rubric を 74 回払います** —— 質問 1 つごとに `instructions` が 1 つ。
モデルには**同じ 74 件を、rubric 1 回**で見せるので、**約 4 分の 1**です。
[30 §7](30-skill-pick.md) が内側から測った overhead
(共有 criteria を per-question から state に移したら 1 リクエストに入る質問が 260 → 520)が、
ここでは**請求書として**見えています。

**このコンポーネントでは、モデルのプロンプトの方が安い形です。**
互角でないのは**待ち時間**だけ:

| | 判断 1 件の中央値 | 14 件の合計 |
| --- | --- | --- |
| **jev** | **436 ms** | 6.1 秒 |
| sonnet | 34,537 ms | 484 秒 |
| haiku | 42,037 ms | 589 秒 |

**79〜96 倍**。[41](41-versus.md) の guard、[§1.3](#13-値段と待ち時間) の compactor と同じ形です。

### 3.4 65% は同じ skill をロードします —— そして間違いも共有します

```
  over 14 project(s): 24 of 37 distinct skills were loaded by EVERY arm (65%).
  moonbit-lib: not unanimous on moonbit-js-binding (haiku+sonnet)
  d1-worker: not unanimous on sql-plan-audit (haiku+sonnet), sql-security (jev)
  frontend-review: not unanimous on dep-lib-review (haiku), frontend-review-ci (sonnet), frontend-review-weekly (jev)
  gleam-api: not unanimous on nix-setup (jev+sonnet)
  flaky-suite: not unanimous on flaker-storage-cache-on-ci (jev+sonnet)
  article-draft: not unanimous on mizchi-blog-style (jev+sonnet)
  dep-audit: not unanimous on frontend-review-deps (jev+haiku), security-expert (jev)
  formal-config: not unanimous on security-expert (jev)
  act-local: not unanimous on actrun-init (jev)
```

precision が 1 ポイント差でも、**3 者が一致しているのか、別々の skill を選んで
同じ点数になったのか**はラベルでは区別できません。だから並べました。

**2 つは全員一致の決定**で、どちらも設計の主張が出ている場所です:

- **`bare-repo` は 3 者とも 0 件ロード。** cap ではなく **cutoff が決めました** ——
  [36 §3](36-routers.md) の「上位 k を取る実装はどの要求にも 3 件ロードする」の逆側。
- **`k8s-crd` は 3 者とも 1 件ロードして 3 者とも外しました**(hit 0 / extra 1)。
  **共有された誤り**で、これはアームの差ではなくラベルかコーパスの側の問題です
  ([41 §3](41-versus.md) の orchestration で見たのと同じ形)。

---

## 4'. まとめ: 5 コンポーネントを本物のモデルと並べた結果

| コンポーネント | 品質 | 速度 | 値段 |
| --- | --- | --- | --- |
| **guard**([41](41-versus.md)) | jev **96%** = sonnet、haiku 88%。**誤りの向きが違う**(haiku の 3 件は全部 permissive 側) | **49〜61 倍** | jev $0.034 / 1,000 |
| **orchestration**([41](41-versus.md)) | 58 / 58 / **61%** —— 38 件中 32 件は 3 者同じ。**コーパスの難しさ** | **26〜34 倍** | 同上 |
| **compactor**(§1) | jev **8/8 予算内・事実 100%**、`select` は事実 100% だが**予算超過 3/8・2/8**、`summarise` は事実を落とす。**捏造は 3 者とも 0** | **43〜103 倍** | jev $0.366 / 1,000 |
| **model router**(§2) | **誰も無料の `always-haiku` を超えません。** 3 者が 53 件中 42 件で同じ段、41 件がラベルより上。**どのアームも唯一の難問を見ていない**(最良 AUC 0.663、p = 0.358) | **43 倍** | jev $0.034 / 1,000 |
| **skill router**(§3) | **3 者とも分離せず**(最小 p = 0.125)。sonnet の precision +9pt は 14 件中 2 件に乗って p = 0.500 | **79〜96 倍** | **jev の方が 4 倍高い**($0.841 / 1,000) |

**一貫しているのは速度だけです。** 5 つすべてで **26〜103 倍**。
**品質で jev が明確に勝っている列はありません** ——
guard で sonnet と同点、他は分離しないか、コーパスが測れないか。
そして **skill router では値段も負けています**。

[18 §1](18-permission-hook.md) が guard に与えた予算は **2,500 ms** でした。
**8〜75 秒かかる判断は、精度がいくらであれそこに座れません。**
それがこの 2 本の報告([41](41-versus.md)・42)が言える一番強い主張で、
**「判断が賢い」ではなく「判断が間に合う」**という形をしています。

---

## 4. 宿題 (m) —— 前提が間違っていて、直し方も held out で落ちました

[06](06-ideas.md) の宿題 (m) は
「`jev-guard` の棄権率を下げる(24 件中 6 件)」でした。
[41 §2](41-versus.md) が「ordered な `permission` score が返ってこない」と書いたからです。

**測りました。** [01](01-shell-risk.md) の 24 コマンド × 5 ドロー = **120 回**:

```
  requests made:              120
  `permission` score ABSENT:  0
  `verdict` emitted as null:  29
```

### 4.1 score は 1 度も欠けていません

`verdict` が null なのは出荷コードの **1 行**です:

```ts
const emitted = !config.allowSafe && verdict === ALLOW ? null : verdict;
```

`allowSafe` の既定は `false`。つまり **ALLOW の判断は意図的に null で出る** ——
[18 §1(1)](18-permission-hook.md) の
「gate が `allow` と言い切って host の規則を上書きしてはいけない」がそれです。
**gate は意見を持っていて、言わないことを選んでいました。**

そして `reason` には最初からこう書いてありました:

```
jev rates this allow: permission 0.01/2 (confidence 0.99, ask at 0.50,
deny at 1.50), blast radius 0.07/3. No predicate flagged
```

**null を読んで、隣の文を読まなかった。**
[41 §2](41-versus.md) が報告しているのと**同じ形の間違い**(契約を読まずにフィールドを読む)を、
§2 を書いた**後に**もう一度やりました。**同じコーパスで 3 回目**です。

### 4.2 唯一の誤りは cutoff です —— そして in-sample では完全に直ります

誤るのは `rm -rf ./node_modules`(ラベル `confirm`)**だけ**で、
120 ドロー中 4 件(confirm×1 / allow×4)。`permission` は **0.46〜0.50**、
`ask` の cutoff がちょうど **0.50**。

```
  needs-asking draws: 95   safe draws: 25   AUC 1.000
  highest SAFE score: 0.06   lowest NEEDS-ASKING score: 0.36   gap 0.30
  within-command spread: sd 0.02, max 0.12
```

**ordered score はこのコーパスを完全に分離します。**
`0.06..0.36` のどの cutoff でも 120 回同じ答えになり、
gap 0.30 はコマンド内ばらつき sd 0.02 より**広い**。
**出荷している 0.50 はその区間の外**にあります。
中点 0.21 なら ordered score 単独で **95/95 を捕まえ、25 件の安全側を 1 件も止めない**。

`battery.ts` は自分についてこう書いています ——
cutoff は「**3 段の中点**」、つまり **rubric 自身の境界**。
それは [25](25-thresholds.md) が 1 本かけて否定した仮定で、
**出荷パッケージの中で、当てはめたはずのコーパスの上で、実際に外れていました。**

### 4.3 それでも既定値は動かしません —— held out で落ちるからです

```
  placement          in-sample (tp/fn, fp/tn)   held out (tp/fn, fp/tn)   cutoffs per fold
  fixed 0.5                       86/9, 0/25                86/9, 0/25   0.50 x6
  midgap                          95/0, 0/25               85/10, 0/25   0.21 0.21 0.21 0.18 0.21 0.54
  auto+0.01                       95/0, 0/25               85/10, 5/20   0.07 0.07 0.07 0.02 0.07 0.54
  youden                          95/0, 4/21                95/0, 5/20   0.06 0.06 0.06 0.02 0.06 0.06
```

fold は**コマンド単位**(1 コマンドの 5 ドローが訓練と held out に割れないように)。

**in-sample で完璧(95/95)な cutoff は、held out では 10 件見落とし** ——
出荷の 0.50(9 件)より**悪い**。
fold ごとの cutoff の幅は **0.35** で、置かれている gap 0.30 より**広い**。

原因は fold から読みました(**私の予想は外れました**):
一番低い「聞くべき」ドローは `truncate -s 0 app.log` の **0.36** で、
誤るコマンドではありません。その fold を訓練から抜くと
**見える最小の positive が 1.01 に飛び**、その fold の cutoff が **0.54** ——
出荷の 0.50 より上 —— に行って held out を連れていきます。

`youden` は held out で 95/0 に届きますが、
**安全側 25 件のうち 5 件を止める**代償つき。guard にとってそれは `ls -la` を止めることです。

> **宿題 (m) が要るのは新しい数字ではなく、境界付近のコーパスです。**
> 24 件のうち 1 件しか面白い領域に無いコーパスでは、
> in-sample の表が何を言おうと cutoff は当てはめられません。

### 4.4 confidence では分離できません(AUC 0.985 なのに)

「誤るドローは confidence が低いのだから、floor を置けばいい」——
順序は確かに良いのですが、**cutoff は存在しません**:

```
  draws with a confidence: 120   wrong: 4   right: 116
  AUC (low confidence predicts a wrong call): 0.985
  highest confidence on a WRONG draw: 0.31   lowest on a RIGHT draw: 0.25
  gap: -0.06
```

**AUC が高いのは「順序が良い」で、「cutoff がある」ではありません** ——
[24](24-adhoc-rules.md) の規則で、`advise` が数字より先に verdict を返す理由です。
報告は floor を**全点掃きます**(0.31 で 4/4 捕まえて 2/116 止める、0.28 で 2/4 と 2/116)。

### 4.5 そして弱い読みが gate の精度を支えていました

ずれた cutoff は 95 件中 **9 件**を通します。
しかし **host に届いた誤りは 4 件**でした:

`verdictOf` は `max(permissionGate, atomicRule)` を返すので、
**残り 5 件は flag が立った predicate が捕まえていた**のです。
[01](01-shell-risk.md) は atomic rule を「score の上に 3 ポイント(90.3% → 94.4%)」と
値付けしましたが、この記録では
**弱い読みが、当てはめていない cutoff の穴を埋めている**状態です。

それが設計が意図した冗長性なのか、cutoff の誤りを隠しているのか ——
**cutoff を直せる(= 境界のコーパスが在る)まで区別できません。**

---

## 5. 正直な限界

**測っていないもの**

- **組み合わせは測っていません。** [41 §0](41-versus.md) と同じで、
  [37 §6](37-hermes.md) が「束ねるのは無料ではない」(7 問中 7 問が束ね方で動く)と
  測っているので、**別々に聞いた成績は束ねた成績の上限**です。
- **エンドツーエンドのタスク品質も測っていません。** pi 側にトークンを生成するモデルが
  居ません(api.anthropic.com は 401)。[38](38-agent.md) は台本のモデルで
  **配線に届くこと**だけを確認しています。
- **モデル側の請求は空欄です。** `claude -p` はトークンを報告しません。
  推測を入れると、一番検証しにくい数字が一番目立つ位置に来ます。
- **モデルは 2 つだけ**です。`claude -p` がこのコンテナにあるものです。

**標本が小さいところ**

- **1 アーム 1 アイテム 1 ドロー**です。
  §3.2 だけは対応を取って厳密検定にしましたが、
  他の表の差は**ドローのノイズを越えるか言えません**。
  jev 側は繰り返しが安く、CLI 側は 1 件 8〜75 秒 —— それが理由です。
- **compactor は 8 transcript・9 事実**で、
  **捏造を採れるのはそのうち 6**(§1.2)。
- **model router の難問は 1 件**です。この検定が返せる最小の p は **0.019** なので、
  **分離があっても示せません**(§2.3)。
  そして**ラベルは (task, tier) あたり 1 ドロー**(§2.4)。
- **skill router は 14 プロジェクト**、cap 3 で `want` が 135 件なので
  **recall は 31% が上限**(§3.1)。

**形が揃っていないところ**

- **skill router の質問の数は揃っていません**(§0)。
  jev は `Question` 74 個、モデルは 1 プロンプト。情報と幅は同じ、分割が違う。
  **それ自体が §3.3 の値段の差**です。
- **skill router の出荷パイプラインの前 2 段を通していません**(§0)。
  下の precision は**判断の成績で、パイプラインの成績ではありません**。
- **compactor の jev アームは再生**です(`experiments/compact/records/ranking.json`)。
  モデルのアームはいま作りました。

**まだ答えの無い問い**

- **宿題 (m) の cutoff は当てはめられません**(§4.3)。
  必要なのは**境界付近のコマンド**で、24 件のうち 1 件では足りません。
- **`verdictOf` の冗長性**が設計の意図なのか cutoff の誤りを隠しているのかは、
  **cutoff を直せるまで区別できません**(§4.5)。
- **model router のコーパスを作り直す**なら、
  `haiku` が落ちるタスクを意図的に集める必要があります ——
  [36 §5](36-routers.md) が言った「コーパスが結果だった」の、まだ払っていない請求書です。
