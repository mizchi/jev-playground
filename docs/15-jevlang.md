# 15. jevlang — 条件が Jev の判断である小さな言語(JS 版 / MoonBit 版)

`if` の条件や `match` の対象が**自然文の確率判断**である DSL を作った。
実装は 2 つ: **JS 版** (`jevlang-js/`) と **MoonBit 版** (`jevlang/` + `cmd/jevlang`)。
同じ `.jev` を両方が走らせ、**結果が一致することをテストしている**。

```jev
state {
  fridge: ["卵", "ビール", "マヨネーズ"],
  wallet_yen: 100,
  wife_mood: "ふつう",
}

threshold noul = 0.5
threshold gate = 0.5

if noul("家に牛乳がない") {
  buy("牛乳")
}

let result = match choice("100円余ったときに買うもの", ["プリン", "ビール", "うまい棒"]) {
  "プリン" => buy("プリン")
  "ビール" => buy("ビール")
  "うまい棒" => buy("うまい棒")
  else => buy("牛乳")
}

let praised = score("${result} を買ったことで妻に褒められる確率", [
  "褒められない", "何も言われない", "褒められる",
])

if praised >= 1.5 {
  say("よくやった")
} else {
  say("${result} は失敗だったかもしれない")
}
```

実際に走らせた出力(`examples/milk.jev`):

```
  [batch ] noul   家に牛乳がない                             0.90
  [batch ] choice 100円余ったときに買うもの                      ビール @0.46
  [batch ] gate   次の選択肢のうち少なくとも 1 つが実際に当てはまる: …     0.97
  [lazy  ] score  ビール を買ったことで妻に褒められる確率                0.95 @0.75

  -> buy("牛乳")
  -> buy("ビール")
  -> say("ビール は失敗だったかもしれない")

  batched: 2 request(s) for 4 judgment(s) (3 in the batch, 1 lazy)
```

余った 100 円でビールを買うと妻には褒められない(0.95/2)と判断されました。

再現:

```bash
# JS 版
node jevlang-js/bin/jevlang.mjs examples/milk.jev
node jevlang-js/bin/jevlang.mjs examples/milk.jev --lazy          # バッチ無効化(比較用)
node jevlang-js/bin/jevlang.mjs examples/milk.jev --record t.json

# MoonBit 版
moon run --target native cmd/jevlang -- examples/milk.jev
moon run --target native cmd/jevlang -- examples/milk.jev --replay examples/transcripts/milk.json

# テスト(どれも API キー不要)
node jevlang-js/test.mjs                    # 24 件
moon test --target native -p jevlang        # 31 件
scripts/jevlang-conformance.sh              # 2 実装の一致(3 プログラム)
```

---

## 結論(先に)

**動く。そして言語にすると、設計判断が構文になる。**

この探索でこれまで実測してきたことが、ライブラリの使い方の話ではなく
**言語の意味論**として書けたのが収穫でした:

| 実測 | jevlang での現れ方 |
| --- | --- |
| 質問のバンドルは 21x 速く 8x 安い([00](00-api-notes.md#speculative-fan-out)) | **質問文が実行前に確定している judgment を 1 リクエストに巻き上げる**。実測 4 リクエスト → **2**、1501 → **867 トークン** |
| `choice` は必ず選ぶ([00](00-api-notes.md#closed-world)) | `match` の `else` 腕が **gate noul を別の質問として増やす** |
| 逃げ道は選択肢に混ぜるより別の noul([13](13-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする)) | gate は `criteria` に「該当なし」を足さない。**構文上、混ぜられない** |
| 閾値はコード側で決める([01](01-shell-risk.md#3-順序のある結論は-score-で聞く)) | `threshold noul = 0.5` が宣言。**質問文に閾値を書く場所が無い** |
| 順序のある結論は `score`([01](01-shell-risk.md)) | `score(...)` は数値を返し、**条件に使うには比較が必須** |
| 名前だけの choice が最安([00](00-api-notes.md#name-only)) | `choice` の選択肢に説明を書く構文が無い |
| 数値はすべて judgment の値 | 表示は**常に小数 2 桁**。整数の特別扱いを持たない(§6) |

そして**確率的な言語には record/replay が必須**だとわかりました。
同じプログラムが毎回違う分岐を通るので、それ無しでは
「実装の違い」と「モデルが今日は違う答えを返した」を区別できない。

## 1. 言語の形

文法は全部で 20 行くらいです(`jevlang-js/src/parse.mjs` の冒頭に BNF があります)。

- `state { ... }` — **すべての judgment が見る文脈**。JSON になって 1 リクエストに 1 回乗る。
  変数も judgment も書けない、ただのデータ。
- `threshold noul = 0.5` / `threshold gate = 0.5` / `threshold flag = 0.5`
- `let x = <expr>`、`if <cond> { } else { }`、`match <expr> { "a" => <expr>, else => <expr> }`
- judgment 3 種: `noul("...")` → 確率、`choice("...", [...])` → 選ばれた文字列、
  `score("...", [...])` → 数値
- `conf(x)` — `x` を作った judgment の confidence
- `threshold_of(noul)` / `threshold_of(gate)` / `threshold_of(flag)` —
  **`threshold` 宣言を数値として読み戻す**。言語が使う切れ目とメッセージが
  言う切れ目が drift しないため。名前は**パース時に検査**するので、綴り間違いは構文エラー
- `flagged(a, b, c)` — **`threshold flag` 以上のものだけを「名前 値」で並べる**
  (`"destructive 0.98, privileged 0.55"`)。**束縛名をそのまま受ける**のが要点で、
  式を受けると名前が消えてしまう。理由文に「どの述語が撃ったか」を出すための
  最小の道具で、文字列結合が無いこの言語では他に書く手段がありません(§9)
- `noul("q", { true: "...", false: "..." })` — 真偽の境界を説明文で締める。
  [14 §3](14-permission-hook.md#3-コーパスでは見つからないバグが出た) の
  「`false` 側の文言が判定を決めた」がこの構文の存在理由です。
  2 つの説明文は内部では `options` に入るので、transcript の同一性判定が
  そのまま効きます(同じ質問文で criteria が違えば別の質問)
- `--state <file>` — **ホストが state を注入できる**。プログラムの
  `state { }` ブロックは既定値とドキュメントになり、実行時の値は
  走らせる側が渡す。`.jev` を hook のポリシーにするにはこれが必要でした(§9)
- それ以外の `name(...)` は**ホストの副作用**。`buy("牛乳")` は記録されて表示される。
  副作用は**第 1 引数に評価される**ので、`"プリン" => buy("プリン")` が
  `result` に `"プリン"` を束縛できる。
- 文字列補間は `"${name}"` だけ(識別子のみ)。理由は §2。

### 型の規則が 1 つだけある

**条件になれるのは `noul` の確率と真偽値だけ。**

```jev
if noul("牛乳がない") { ... }      # OK: threshold noul で真偽に落ちる
if praised { ... }                 # エラー: a number is not a condition -- compare it
if praised >= 1.5 { ... }          # OK
```

`score` の値を勝手に真偽に落とさないのは、
[01](01-shell-risk.md#3-順序のある結論は-score-で聞く) の
「閾値はコード側の決定」をそのまま型にしたからです。
言語が代わりに切れ目を発明してしまうと、そこが一番の事故源になる。

## 2. 巻き上げ(speculative batching)— 実測 4 → 2 リクエスト

[00](00-api-notes.md#speculative-fan-out) の fan-out は、**言語にすると最適化になります**。

実行前に全 judgment を走査して、**質問文がすでに確定しているもの**を
1 リクエストにまとめて聞く。**通らない分岐の中にある judgment も聞く** ——
state は 1 回しか送られないので、使わない質問のコストは質問文のトークンだけで、
2 往復するより安い。

一方 `"${result} を買ったことで…"` は**まだ文が存在しない**ので巻き上げられない。
これが言語のコストモデルのすべてです:

```
requests = 1 + (実行時の値に依存する judgment の数)
```

`examples/milk.jev`(judgment 4 個、うち 1 個が補間)の実測、3 回:

| | リクエスト | 入力トークン | 実時間 |
| --- | --- | --- | --- |
| 既定(巻き上げ) | **2** | **867** | 0.40 / 0.51 / 0.59 s |
| `--lazy` | 4 | 1501 | 0.71 / 0.90 / 1.65 s |

**トークンは決定的に 1.73 倍の差**(state を 4 回送るか 2 回送るかの差)。
実時間はばらつくが常に速い。

補間を識別子 1 つに限っているのはこのためです。
`"${a + b}"` を許すと「質問文が実行前に確定しているか」の判定が
式の評価順の解析になってしまう。**構文を制限して解析を自明にしてあります。**

`Program::request_plan()`(MoonBit)/ `requestPlan(program)`(JS)で、
走らせる前に「何問バッチに乗るか」を聞けます。

## 3. `choice` に対する `else` 腕は gate noul を生やす

`choice` は必ず選択肢の 1 つを返します([00](00-api-notes.md#closed-world))。
なので `match` の subject が `choice` で `else` 腕があると、
**「どれも当てはまらない」を聞く noul が別の質問として増える**。
閾値を下回ったら、`choice` が何を返していても `else` に行きます。

**subject が `choice` でないときは gate を生やしません。** gate が要るのは
「`choice` が必ず何かを返してしまう」からで、**普通の文字列に閉じた世界の
問題はありません**。当初は subject を見ずに gate を付けていて、
`match s { "x" => ... else => ... }` が**何についてでもない質問**を
1 件投げていました(§9 で気づいて直した)。
直した副作用として、**`match` が文字列の switch として使えます** ——
この言語で条件式に一番近いものです。

ここが [13](13-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) の実測を
そのまま構文にしたところで、**選択肢に「該当なし」を混ぜる書き方は
この言語には存在しません**(混ぜると難しいだけの問題までそこへ逃げて、
`lying` が 18/24 → 15/24 に落ちたのが実測)。

`examples/closed-world.jev` は、やりたいことがタスクランナーの外にある例:

```
  [batch ] choice この作業に使うタスク                      lint @0.44
  [batch ] gate   次の選択肢のうち少なくとも 1 つが実際に当てはまる: …  0.40

  -> skip("gh pr create")
  -> say("結果: gh pr create")
```

`choice` は `lint` を 0.44 で選んでいる —— **閉じた世界の自信ありげな誤答**です。
gate が 0.40 で閾値 0.5 を下回ったので `else` が勝ち、間違ったタスクを実行しなかった。

## 4. record / replay — 確率的な言語に必須の道具

`--record` で全 judgment の答えを書き出し、`--replay` で**API を 1 回も叩かずに**
同じ実行を再現します。これは便利機能ではなく**必要機能**でした:

- **テストが書ける。** 確率的な分岐を持つプログラムは、
  replay 無しでは期待値を書けない。
- **2 実装を比較できる。** これが本題(§5)。
- `examples/transcripts/*.json` をコミットしてあるので、
  `scripts/jevlang-conformance.sh` は **API キー無しで走ります**。

transcript は「合成キーで引くオブジェクト」ではなく
`{kind, question, options, answer}` の**リスト**にしてあります。
最初はキー方式で書いて、区切りに制御文字を使ったせいで
**JS 側のソースが「バイナリファイル」になり、2 つの JSON 書き出しが
制御文字のエスケープで一致する保証も無い**ことに気づいて捨てました。
リストなら人間も読めます。

## 5. 2 実装であることが実際に効いた

「同じ言語を 2 回実装する」のは、普通なら無駄です。
ここでは**片方だけでは絶対に気づかないバグが 2 つ**出ました。

### (1) `0.6` が `0.6000000000000001` になる

MoonBit 側は数値パーサを手書きしています(依存を増やしたくなかった)。
最初の実装は小数部を `digit * scale`(`scale *= 0.1`)で足し込んでいて、
`threshold noul = 0.6` が **0.6000000000000001** になりました。
JS は `parseFloat` なのでちょうど 0.6。

**これは閾値です。** judgment の確率がちょうど 0.6 のとき、
2 つの実装が**違う分岐を通る**。
小数部を整数として溜めて最後に 1 回割る形に直しました。

見つけたのは `assert_eq(program.noul_threshold, 0.6)` という 1 行のテストです。

### (2) 負の 0.5 の丸めが逆

数値の表示は `trunc(v * 100 ± 0.5)` に揃えました。
JS の `Math.round` は同値を **+∞ 方向**に、MoonBit の `.to_int()` は
**0 方向**に丸めるので、負の半端値で食い違います。
確率とスコアは非負なので実害は出ていませんが、
**表示関数の仕事は一致することそのもの**なので直しました。

両実装に同じ期待値表を置いてあります(`format_number` / `formatNumber`)。

### 一致の確認

```
building the MoonBit implementation...
  ok   closed-world  (2 judgments, identical in both)
  ok   milk  (4 judgments, identical in both)
  ok   policy  (9 judgments, identical in both)

  3 identical, 0 differing
```

`policy` は §9 の permission hook のポリシーで、**noul の criteria と `conf()` を
使う唯一のプログラム**なので、2 実装がずれるなら一番先にここでずれます。

比較対象は `--json` 出力で、**両実装が一致しなければならないものだけ**を含みます
(副作用、出力、束縛の順序、実際に消費された judgment)。
両方を同じ JSON 正規化器に通してから diff するので、
**キー順や数値書式の違いではなく意味の違いだけ**が失敗になります。

## 6. 正直な限界

- **言語として小さい。** 関数定義もループも代入も無い。`let` は再束縛できない。
  上から下に流れる決定木しか書けません。
  judgment を試すにはこれで足りますが、汎用言語ではない。
- **文字列結合が無い。** `${}` 補間と `flagged()` で足りてはいますが、
  「撃った述語を並べる」以外の集約(合計、最大、上位 3 件)は書けません。
- **副作用の設計が緩い。** 未知の識別子呼び出しは全部「ホストの副作用」になるので、
  **タイプミスが静かに副作用として記録されます**(`buyMilik()` は
  エラーにならず `buyMilik` という副作用になる)。
  宣言を要求する形にすべきでした。
- **`conf()` は noul に対して 0 を返す。** API が noul に confidence を返さないからですが、
  「confidence が無い」と「confidence が 0」を区別できていません。
- **巻き上げは常に得とは限らない。** 通らない分岐の質問文にもトークンを払うので、
  **判断が 1 つだけで分岐が巨大なプログラム**では損になりえます。
  そこは測っていません(実測した `milk.jev` は 4 問中 3 問が巻き上げ可能な形)。
- **replay はプログラムの編集に弱い。** 質問文を 1 文字変えれば transcript は当たらなくなり、
  そこで「答えが無い」エラーになります(黙って API を叩くより良い挙動だと思いますが、
  再録が要ります)。transcript の `state` は記録しているだけで、**照合していません** ——
  state を変えたのに古い transcript で replay すると、気づかず通ります。
- **2 実装の一致はサンプル 3 本でしか確認していない。** §9 の policy が
  `&&` / `||` / `conf()` / noul criteria / ネストした `else if` を通るので
  §5 の時点よりは広くなりましたが、`!` と `match` の非 choice subject は
  片方のユニットテストにあるだけで、**両実装を突き合わせてはいません**。
- **エラーメッセージが両実装で違う。** 構文エラーの文面は揃えていないので、
  conformance の比較対象からも外してあります。

## 7. この実験で確定したこと

1. **「条件が確率判断である言語」は書ける。** 文法 20 行、judgment 3 種、
   副作用はホスト持ち。冷蔵庫の牛乳の例がそのまま動く。
2. **fan-out は言語にすると最適化になる。** 質問文が確定している judgment を
   巻き上げて **4 → 2 リクエスト、1501 → 867 トークン**。
   巻き上げ可能かどうかは**補間の有無**で決まるので、
   補間を識別子 1 つに制限して解析を自明にした(§2)。
3. **逃げ道を「別の問い」にする設計は構文で強制できる。**
   `else` 腕が gate noul を生やし、選択肢に「該当なし」を混ぜる書き方は
   言語に存在しない([13](13-task-picker.md) の実測をそのまま意味論にした)(§3)。
4. **閾値をコード側に置く([01](01-shell-risk.md))は型で強制できる。**
   `score` の値は比較しないと条件にならない(§1)。
5. **確率的な言語には record/replay が要る。** 無いとテストが書けず、
   実装差とモデルのばらつきも区別できない(§4)。
6. **2 実装にしたことで、片方だけでは出ないバグが 2 件出た。**
   手書き数値パーサの `0.6` → 0.6000000000000001(**閾値なので分岐が変わる**)と、
   負の半端値の丸め方向の不一致(§5)。

## 9. 実際に使ってみた — permission hook のポリシー

「この言語は何のためにあるのか」への答えを出しました。
[14](14-permission-hook.md) の permission hook の判定を `.jev` で書き直しました
(`hooks/policy.jev`、[14 §6b](14-permission-hook.md#6b-判定ロジックを-jev-で書く))。

```bash
node hooks/jev-permission-gate.mjs --policy hooks/policy.jev
node hooks/test-gate.mjs --policy-logic      # 規則の 14 分岐を replay で検証(API 不要)
node hooks/test-gate.mjs --compare-policy    # 実モデルで組み込みと比較
```

書けました。9 judgment が全部巻き上がって **1 リクエスト**、
組み込みと同じです。そして **2 つの穴が見つかりました**:

1. **`noul` に criteria を書く構文が無かった。** [14 §3](14-permission-hook.md#3-コーパスでは見つからないバグが出た) の
   話の全体が「`false` 側の文言が判定を決めた」なので、
   criteria を書けない言語ではポリシーを**正しく書けません**。追加しました。
2. **state をホストから注入できなかった。** コマンドや git ブランチを
   知っているのは hook で、ポリシーの著者ではない。`--state` を追加しました。

つまり**実際の用途に当てると、言語に足りないものが出てきた** ——
docs/14 §3 で「実運用の形に載せることが最後のテスト」と書いたことが、
言語自身にも当てはまりました。

### 追記: 理由文に述語の発火を出す

最初のポリシーは**理由文に「どの述語が撃ったか」を出せませんでした**
(組み込み経路は `Flagged: destructive 0.98, ...` を出す)。
言語に文字列結合も代入も無いので、素直には書けません。

そこで **`flagged(a, b, c)`** を足しました。`threshold flag` 以上のものだけを
「名前 値」で並べます。**束縛名を受ける**のが肝で、式を受けると名前が消えます:

```jev
let fired = flagged(destructive, irreversible, outside_project,
                    exfiltrates, obfuscated, privileged, affects_others)

let flags = match fired {
  "" => "No predicate flagged"
  else => "Flagged: ${fired}"
}

let why = "permission ${permission}/2 (confidence ${pconf}), blast radius ${blast}/3. ${flags}"
```

結果は組み込み経路と同じ形になりました:

```
組み込み: ... blast radius 2.01/3. Flagged: destructive 0.98, irreversible 0.88, outside_project 0.98, affects_others 0.71
ポリシー: ... blast radius 2.02/3. Flagged: destructive 0.98, irreversible 0.89, outside_project 0.98, affects_others 0.75
```

数値の桁も揃えました。`format_number` が整数を裸で出していたので
`blast radius 2/3` になっていたのを、**常に小数 2 桁**に変えています
(組み込みの `toFixed(2)` と同じ)。この言語の数値はすべて judgment の値か
閾値リテラルなので 2 桁固定が素直で、整数の特別扱いは
**2 実装がずれる分岐が 1 つ増える**だけでした。

そして**ここで §3 の設計バグが出ました。** 1 つも撃たなかったときの言い換えに
`match fired { "" => ... else => ... }` を使いたかったのですが、
当初の実装は **subject を見ずに `else` 腕へ gate を付けていた**ので、
文字列に対する match が「どれも当てはまらないか」という
**何についてでもない質問**を投げていました。
gate は subject が `choice` のときだけ生やすよう直し、
結果として `match` が文字列の switch として使えるようになりました
(この言語で条件式に一番近いもの)。**追加のリクエストは 0 件**で、
ポリシーは今も 9 judgment・1 リクエストです。

規則の検証は 16 分岐に増えていて、**理由文の中身も見ています**:

```
node hooks/test-gate.mjs --policy-logic
  ok   the reason names the predicates that fired -> deny     want deny
       permission 1.60/2 (confidence 0.90), blast radius 0/3. Flagged: destructive 0.90, irreversible 0.80, privileged 0.55
  ok   the reason says so when nothing fired      -> deny     want deny
       permission 1.60/2 (confidence 0.90), blast radius 0/3. No predicate flagged
  -> 16/16 branches of the rule behave as specified
```

### 追記 2: 理由文に閾値を出す —— 必要だったのは別の機能だった

組み込み経路は `(confidence 0.99, ask at 0.50, deny at 1.50)` と閾値まで出します。
ポリシー側で同じことをやろうとして、最初は
**「`threshold` 宣言を値として読む手段が無い」**のが原因だと書きました。
**これは誤診でした。**

ポリシーの `deny_at = 1.5` / `ask_at = 0.5` は
**`permission` スコアに対するポリシー自身の定数**で、言語の
`threshold noul` / `gate` / `flag`(noul を条件にする閾値・gate の閾値・
flagged の下限)とは別物です。必要だったのは宣言の読み出しではなく
**定数に名前を付けること**で、それは `let` で最初からできました:

```jev
let ask_at = 0.5
let deny_at = 1.5

let deny_by_score = permission >= deny_at      # 判定で使う
# ...そして同じ名前を理由文で使う
let why = "permission ${permission}/2 (confidence ${pconf}, ask at ${ask_at}, deny at ${deny_at}), ..."
```

**数字を 1 回だけ書いて、判定と理由文の両方から使う。** 2 箇所に書けば必ず drift します。
judgment は 1 つも増えません(`let` は数値の束縛なのでリクエスト 0 件)。

そのうえで **`threshold_of(name)`** も足しました。こちらは
「言語の宣言を読む」もので、ポリシーでは述語の下限に使っています:

```jev
threshold flag = 0.5
let fired_at = threshold_of(flag)

let deny_by_atoms = exfiltrates > fired_at || obfuscated > 0.7 || blast >= 2.5
```

**合成規則が「撃った」とみなす下限**と、**`flagged()` が理由文に載せる下限**が
これで必ず同じ数になります。宣言側を動かせば両方が動く。
名前はパース時に検査するので、`threshold_of(nope)` は構文エラーです。

結果、2 つの理由文は**形も桁も一致**しました(値の差は 2 回の独立したリクエスト分):

```
組み込み: permission 1.99/2 (confidence 0.99, ask at 0.50, deny at 1.50), blast radius 2.01/3. Flagged: destructive 0.98, irreversible 0.85, outside_project 0.98, affects_others 0.66
ポリシー: permission 1.99/2 (confidence 0.99, ask at 0.50, deny at 1.50), blast radius 2.02/3. Flagged: destructive 0.98, irreversible 0.89, outside_project 0.98, affects_others 0.72
```

(組み込み側も閾値を `toFixed(2)` に揃えました。スコアは元から 2 桁だったので、
閾値だけ `0.5` と出ていたのが不揃いでした。)

**ここでも言語の制限を自分で踏みました。** テストに
`say("noul ${threshold_of(noul)}")` と書いて構文エラーになりました ——
`${}` に書けるのは**識別子だけ**で、これは §2 の巻き上げ解析を
自明に保つための制限です。一度 `let` で束縛すれば通ります。
**制限が正しく働いた**わけですが、書く側としては引っかかる場所だと分かりました。

そして hook 側の規律は守られています:インタプリタには
**hook 自身のクライアント**(1 回だけ・ハードタイムアウト・リトライ無し)を
渡しているので、ポリシーが勝手に寛容なクライアントを使うことはできません。
レイテンシも変わりません(組み込み 230〜450 ms / ポリシー 235〜435 ms)。

**replay がここで一番効きました。** 実モデルでの比較は 21/24 一致で 3 件食い違いますが、
それは 2 回の独立したリクエストを比べているからで、
**同じ答えに対して規則を比べる** `--policy-logic`(14/14)が
「ロジックは一致している」を確定させています。
確率的な判定を含むものを 2 つ比べるとき、
**replay 無しでは実装差とモデルのばらつきが区別できない**という §4 の主張の、
一番具体的な例になりました。

## 8. 次に試すこと

- **副作用を宣言させる。** `effect buy(item)` を required にして、
  §6 の「タイプミスが副作用になる」を塞ぐ。一番小さくて一番効く修正。
- **transcript の state を照合する。** 記録した state と今の state が違ったら
  警告する(今は黙って通る)。
- **conformance を文法の隅まで広げる。** `&&` の短絡・`conf()`・ネストした
  `else if` を含む例を足し、両実装の突き合わせを増やす。
  §6 の一番大きな穴。
- **判断が 1 つで分岐が巨大なプログラムで巻き上げの損益分岐点を測る。**
  「速くて安い」が常に成り立つかは未検証(§6)。
- ~~**[14](14-permission-hook.md) の hook を `.jev` で書く。**~~
  **やった → §9。** 書けたが、`noul` の criteria と state 注入という
  2 つの穴が出た(どちらも追加済み)。
- ~~**文字列結合か「発火した述語を並べる」組み込み。**~~
  **やった → §9。** `flagged()` を足して、理由文が
  `Flagged: destructive 0.98, irreversible 0.89, ...` を出せるようになりました。
  `+` は足していません(補間で足りた)。
- ~~**理由文に閾値を書けない。**~~ **書ける。** ただし
  **必要だったのは「宣言を読む」ことではありませんでした**(§9 の追記 2)。
- ~~**数値の桁が組み込み経路と違う。**~~ **揃えた。** `format_number` は
  常に小数 2 桁を出します(`2` → `2.00`)。この言語の数値はすべて
  judgment の値(0..1 の確率か 0..n のスコア)か閾値リテラルなので、
  2 桁固定が素直な既定で、整数の特別扱いは**2 実装がずれる分岐が 1 つ増える**だけでした。
- **`${}` に書けるのは識別子だけ** なので、`${threshold_of(flag)}` は書けず
  一度 `let` で束縛する必要があります。§2 の巻き上げ解析を自明に保つための
  制限で、意図どおりではありますが、**この制限を自分のテストで踏みました**(§9)。
