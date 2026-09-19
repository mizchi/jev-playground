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
npm test                                    # 12 件

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
  skill router は同じ 74 問の fan-out。
  出荷している `instructions` と `criteria` の文字列をそのまま見せます。
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

## 2. model router —— コーパスが測れないことを、コーパス自身が明かした

*(進行中: haiku/sonnet の 53 タスクを走らせ中。数字が揃ったら書きます)*

---

## 3. skill router

*(未実施)*

---

## 4. 正直な限界

*(2 と 3 が終わってから)*
