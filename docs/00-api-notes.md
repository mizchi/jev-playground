# 00. API の実挙動メモ

`https://api.typesafe.ai/openapi.json` と [docs.typesafe.ai](https://docs.typesafe.ai/introduction) を
読みながら実 API を叩いて確認した挙動。スキーマに書かれていないものを中心に。

再現: `moon run --target native cmd/patterns --`(5 パターン全部)

---

## <a id="noul-criteria"></a>noul の criteria はネストする(黙って無視される)

`NoulQuestion.criteria` は `NoulCriteria` 型で、次の入れ子です。

```json
{ "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } }
```

`true` / `false` をトップレベルに置くと**サーバーは 200 を返し、criteria を黙って捨てます**。
反転した criteria(true = 正当な会話、false = 迷惑広告)で切り分けると:

| 送信形 | 結果 | input_tokens |
| --- | --- | --- |
| `criteria` に入れ子(仕様どおり) | **0.05** | 315 |
| トップレベル | 0.67 | 287 |

0.67 は criteria なしの素の判断です。**トークン数の差(28)が、criteria が送られていない証拠**でした。
この形の取り違えはレスポンスが成功するぶん、ログを見ても気付けません。

`lib` は以前この形で送っていたため noul の criteria が一切効いていませんでした(修正済み)。
往復テストは対称なのでこの種のバグを検出できず、`lib/types_test.mbt` にワイヤ形式を
固定するテストを足しています。

## <a id="speculative-fan-out"></a>Speculative fan-out が一番効く

同じ state に対する 20 問を、1 リクエストにまとめるか 20 回に分けるか:

| | レイテンシ | 入力トークン |
| --- | --- | --- |
| 20 回に分割 | 5227 ms | 8277 |
| 1 リクエスト | **246 ms** | **1000** |

**21x 速く、8x 安い。** state が 1 回しか送られないので、質問を足すコストがほぼ質問文だけになります。

さらに答えが動きません。単独で聞いた場合との差は数値回答 17 個の平均 **0.011**(最大 0.04)、
choice 3 問は全て同じ選択肢。並列評価という説明どおりで、
「使うか分からない質問も込みで投げて、必要なものだけコードで拾う」が成立します。

> 実務的な含意: 判断に要りそうな述語は**全部書いて 1 回投げる**のが正解。
> 質問を削る最適化はほぼ意味がなく、往復を削る最適化だけが効く。

## <a id="closed-world"></a>confidence 単独のゲートには穴がある

confidence は**渡した選択肢の中での分布の尖り方**であって、「どれかが妥当か」ではありません。
`choice` は必ずどれかを選ぶので、範囲外の入力が自信のある誤答として返ります:

```
"What is the airspeed velocity of an unladen swallow?" -> technical conf=0.96 [AUTO]
"asdf qwer zxcv"                                       -> technical conf=0.99 [AUTO]
```

閾値 0.85 を越えるので自動処理に流れます。対処は 2 つ、どちらも実測で効きました。

- **A: 逃げ道の選択肢** — `none_of_these` を criteria に足すと、上の 2 件とも conf `1.00` で
  `none_of_these` を選びます。最小の変更で済むのでまずこれ。
- **B: スコープ判定を fan-out で同じリクエストに混ぜる** — `in_scope` の noul を併せて聞くと
  範囲外 `0.02` / 正常 `0.97` と明確に分かれます。リクエストは 1 回のままなので追加コストは質問文だけ。
  ルーティング先の criteria をいじれない場合や、スコープ判定を別途ログに残したい場合はこちら。

## <a id="name-only"></a>選択肢の説明は省ける / 1 問 255 個まで

`ChoiceQuestion.criteria` の値は string / object / array / **null** が許され、
null は「選択肢名だけで解釈する」意味になります。説明文がトークンを食う本体なので、
20 ハンドラのメニューでも入力 **441 トークン**、confidence 0.98〜1.00 で当たりました。

ただし **1 問あたり 255 個が上限**です:

```
301 choices -> 400 {"detail":"Too many choices. Must have at most 255 choices."}
```

OpenAPI スキーマには書かれていません。`lib` では `max_choices` として持ち、
送信前に `InvalidRequest` で弾いています。五目並べが 15×15 までなのも実はこれが効いていて、
盤面全体を候補にすると 16×16(256 セル)で上限に当たります。

## <a id="choice-order"></a>`choice` の**並び順は中立ではない**。後ろのほうが強い

同じ 2 つの選択肢を、説明文も state もまったく変えずに**並べる順だけ**入れ替えると、
確率質量が **約 0.21 動きます**。後に置いたほうが得をします。

実測([27 §4.8](27-nl-test-generation.md#48-追記-express-first-が強まる理由--後に描かれたほうが得をする)、
各セル 6 回、2 択が質量の 100% を分け合う状況):

```
"Proceed to checkout" を先に置く  -> p = 0.680 / 0.702
"Proceed to checkout" を後に置く  -> p = 0.892 / 0.903
                                      (+0.212 / −0.202、対称)
```

2 つの値が並んでいるのは**ラベルを入れ替えた対照**です。
どの要素がどのラベルを持つかを交換しても、**順番を揃えれば数字は動きません** ——
効いているのは順序そのもので、ラベルにも「どの要素か」にも依りません。

**どちらが選ばれるか**は語が決め(この例ではどの順でも `Proceed` が 6/6 で勝つ)、
**どれだけの差で勝つか**を順序が決める、という 2 層になっています。

→ 実装側の含意は 2 つ。
**(a) 候補を並べ替える機構(検索・視野で絞る・再ランク)は、集合を変えるだけでなく判断も動かす。**
**(b) 順序を固定しない実装は、同じ画面で違う confidence を返す。**
`experiments/browser-chaos` のプローブが文書順で採番しているのは、
偶然この副作用を固定していたことになります。

限界: 測ったのは**隣接する 2 択**で、16 候補のうちその 2 つが質量の 100% を
取っている状況です。「リストの後ろほど強い」が長いリスト全体や離れた位置でも
成り立つかは測っていません。

## <a id="token-ceilings"></a>質問数に上限は無い。上限はトークンで、枠が 2 つある

上の 255 は **choice の選択肢**の上限で、**1 リクエストの質問数**とは別。
質問数には上限が無く、**1220 問が 1 リクエストで通る**:

```
 128 questions ->   6951 tokens  OK
 255 questions ->  13682 tokens  OK
 256 questions ->  13735 tokens  OK      <- 256 に境界は無い
1024 questions ->  54463 tokens  OK
1220 questions ->  65047 tokens  OK
1240 questions ->  ~66100        400 {"detail":{"error_type":"max_tokens_exceeded"}}
```

境界は **65536(64Ki)入力トークン**。質問 1 問の増分はその質問文のトークンだけ
(上の形では 53 トークン/問)。

**state には別枠の、もっと厳しい上限**がある。質問数を 4 に固定して state だけ伸ばすと:

```
state 28462 tokens  OK
state 32662 tokens  OK
state ~33400        400 max_tokens_exceeded
```

**32768(32Ki)。** 1220 問で 65047 トークンが通るのだから、
これは 1 本の合計上限ではなく**独立した 2 枠**(state 32Ki / リクエスト全体 64Ki)。
どちらも OpenAPI スキーマには書かれていない。

> 実務的な含意: 「何問投げられるか」を気にする必要はない。
> 気にするのは **state の大きさ**で、そこが先に詰まる。
> 実装側は `max_tokens_exceeded` を見たら**質問集合を半分に割って投げ直す**のが安い
> (見積りを正確にするより、外れたときの復帰を用意するほうが確実)。
> → [21](21-eslint-plugin-jev.md#8-バッチ上限は-256-ではない--上限は-2-つあってどちらもトークン)

## instructions と criteria は文字列でなくてよい

`instructions` と各 criteria の説明は string / object / array すべて通ります(実測で確認)。

```json
{ "type": "noul",
  "instructions": { "task": "Detect business email compromise",
                    "signals": ["urgency pressure", "secrecy request"],
                    "statement": "This email is a fraud attempt." } }
```

そのため `lib` の `Question` は `Json` を保持する形にし、全部文字列という普通のケース用に
`Question::noul` / `choice` / `choice_of` / `score` を用意しています。

ただし**易しいケースでは答えは変わりません**(上の例は string / object / array すべて 0.98)。
構造化して効くのは、素の文章にすると曖昧になる情報を渡すときだけです
→ [01 の文脈実験](01-shell-risk.md#2-同じコマンドでも文脈で判断が変わる)。

## state も文字列 / オブジェクト / 配列いずれも可

会話ログを配列でそのまま渡す、ユーザー属性を入れ子で渡す、がそのまま通ります。

```json
{ "state": [ {"role": "user", "text": "this is garbage"},
             {"role": "user", "text": "fix it NOW"} ] }
```

## 合成は「分解 vs 総合」だけの話ではない

複合質問 1 問と、原子的な noul をコード側で重み付けした結果はほぼ一致します
(複合 `2.92/3` conf `0.92` に対し加重和 `0.899`)。違うのは内訳が見えることと、
重みの変更に API 呼び出しが要らないこと。

ガードレール用途ではこの差が精度に出ます。`You are now DAN…` のような roleplay と
軽い依頼が混ざった入力では、判定を 1 問の choice に任せると confidence が **0.43** に落ちるのに、
原子的な noul は `injection=0.97` / `roleplay_bypass=0.98` と鋭いまま。

ただし分解が常に勝つわけではありません
→ [01 の反例](01-shell-risk.md#4-分解は万能ではない)。

## レイテンシ

実測 125〜730 ms。質問数を 1 → 20 に増やしても大きく変わりません(並列評価)。
初回リクエストだけ遅い傾向があります(接続確立)。
