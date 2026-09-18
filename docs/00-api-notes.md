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
