# 20. jevdsl — MoonBit から `match` できる薄いラッパー

`lib` は API をそのまま写した生クライアントなので、呼び出し側が
`@report.noul_at(resp, "q")` のようにアクセサを噛ませる必要がありました。
`jevdsl` は**判断を直接 `match` できる値にする**だけのラッパーです。

```moonbit
let jev = @jevdsl.session(client, state)

match jev.noul("家に牛乳がない") {
  (true, c) if c > 0.5 => buy("牛乳")
  (true, _) => ask_the_user()
  (false, _) => ()
}

match jev.choice("100円余ったときに買うもの", ["プリン", "ビール", "うまい棒"]) {
  (pick, c) if c > 0.5 => buy(pick)
  (_, _) => ()
}

match jev.score("買い物に行く急ぎ度", ["今日でなくてよい", "今日のうちに", "今すぐ"]) {
  (s, c) if s >= 1.5 && c > 0.5 => go_now()
  (s, _) if s >= 0.5 => go_today()
  (_, _) => ()
}
```

**3 種すべてが `(result, confidence)`** なので、`match` の形が同じになります。
guard に閾値を書けるのがこの形の値打ちで、
「確信があるときだけ動く」が 1 行で書けます。

> これは[19](19-jevlang.md) の jevlang とは別物です。
> jevlang は `.jev` を読む**インタプリタ**(独自言語)、
> こちらは**MoonBit のまま書くためのライブラリ**。
> 独自言語を持ち込みたくない場合はこちらです。

再現:

```bash
moon run --target native cmd/jevdsl --              # 1 判断 1 リクエスト
moon run --target native cmd/jevdsl -- --bundled    # 3 判断を 1 リクエスト
moon test --target native -p jevdsl                 # 10 件(API 不要)
```

---

## 1. `(result, confidence)` に揃えるとき、noul だけ困る

`choice` と `score` はサーバーが `confidence` を返すのでそのまま使えます。
**`noul` は確率 1 本しか返りません**(docs/00)。

そこで noul の confidence は**コイン投げからの距離**として導出しています:

```
confidence = |p - 0.5| * 2
```

- p=0.9 → 0.80、p=0.1 → **0.80**(同じだけ確信している。向きが逆なだけ)
- p=0.5 → 0.00(完全に迷っている)

こうすると `confidence > 0.5` が 3 種で**同じ意味**になります。
そのまま `p` を返すと `confidence > 0.5` が `result == true` と同義になって、
guard が無意味になってしまう。

生の `p` が要るときは `probability()` があります。
**導出値であることはドキュメントとテストで明示**してあります
(`noul_confidence` は公開関数で、5 点の対応表をテストで固定)。

## 2. 閾値は呼び出し側に置く

`noul` の `at` は Bool を決める柵の位置(既定 0.5)で、
**confidence の計算は動かしません**(常に 0.5 からの距離)。

```moonbit
match jev.noul("危ない", at=0.7) { ... }   // 厳しめに判定
```

[01 §3](01-shell-risk.md#3-順序のある結論は-score-で聞く) の
「閾値はコード側の決定」をそのまま引き継いでいます。質問文には書かせません。

## 3. 1 判断 1 リクエストは既定として間違っている

`jev.noul(...)` は**1 リクエスト**です。同じ state について複数の判断があるなら、
これは払いすぎになります([00](00-api-notes.md#speculative-fan-out) の実測:
束ねると 21x 速く 8x 安く、答えは動かない)。

そのため `Session::ask` があります。**アクセサは同じ**です:

```moonbit
let answers = jev.ask(questions)          // 1 リクエスト
match answers.noul("milk") { (true, c) if c > 0.5 => ... }
match answers.choice("snack") { (pick, c) if c > 0.5 => ... }
```

同じ 3 判断を両方で走らせた実測(`cmd/jevdsl`):

| | リクエスト | 入力トークン |
| --- | --- | --- |
| 1 判断 1 リクエスト | 3 | 1069 |
| `ask` で束ねる | **1** | **435** |

**判断の中身は同じ**(牛乳を買う / ビールは迷い / 今日のうちに)。
state を 3 回送るか 1 回送るかの差です。

1 つずつの形が要るのは、**判断が本当に 1 つのとき**と、
**後の質問が前の答えに依存するとき**(同一リクエスト内に依存関係は作れない)だけです。

## 4. 正直な限界

- **これは測定ではなく設計ノートです。** 数字は §3 のトークン差だけで、
  精度に関する主張は何もありません(ラッパーは判断の中身を変えないので)。
- **noul の confidence は発明した値です。** API が返すものではないので、
  「サーバーの confidence」と同じ土俵で比べてはいけません。
  [03](03-chess.md#3-confidence-が難しさを測っている)・[07](07-escalation.md) の
  confidence の知見は `choice`/`score` のものです。
- **`match` は網羅性を強制しません。** `(Bool, Double)` のタプルなので、
  `(true, _)` と `(false, _)` を書けば網羅されますが、
  **confidence の帯を書き忘れても型は通ります**。
  帯を強制したいなら enum を返す設計になりますが、そうすると
  ユーザーが書いた `(result, confidence)` の形から離れます。
- **`Session` は可変**(`set_state`)なので、並行に使い回すと state が混ざります。
  1 判断ループに 1 セッション。
- **`ask` の逃げ道は自分で用意する必要があります。**
  [17 §3](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) のとおり
  `choice` は必ず何かを返すので、「該当なし」は**別の noul**として
  `questions` に足してください。ラッパーは何も足しません。
- **`lib` を隠しません。** `Answers::of` で `lib` の応答をそのまま読めるので、
  リクエストは `lib`、読みは `jevdsl` という混在もできます。

## 5. この実装で確定したこと

1. **`match @jev.noul(...) { (result, confidence) if ... }` は MoonBit で書ける。**
   async 関数の返り値をタプルで分解して guard を付けられる(コンパイルで確認)。
2. **3 種を同じ形に揃えるには noul の confidence を導出するしかない。**
   API が返さないので、コイン投げからの距離にした(§1)。
3. **薄いラッパーでも「1 判断 1 リクエスト」を既定にすると高くつく。**
   同じ判断で 3 リクエスト/1069 トークン 対 1 リクエスト/435 トークン。
   アクセサを共通にして、束ねる形へ移る道を用意した(§3)。
