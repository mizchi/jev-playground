# 32. パッチはコードが作り、判断は並べるだけの修復ループ

TODO の 6 番は「Claude を操作する側として、決定的なワークフローを生成して
コーディングエージェントとして実装する([rlm](https://github.com/mizchi/rlm) のような)」でした。
やってみると**制約のほうが先に効きます** ——
Jev が返すのは確率・クラス・順序つきの段階だけで、**文字列を返しません**。
つまり **Jev はパッチを書けない**。

なので決定的なワークフローはこの形になります:

```
変異させる (コード) → 並べる (Jev) → 当てる (コード) → テストする (コード)
```

判断が 1 か所しかなく、残りは全部決定的で再現できます。
[19](19-jevlang.md) の jevlang と [05](05-browser-chaos.md) のブラウザ探索が
それぞれ辿り着いた「幅は機械的・深さは判断」と同じ形です。

測るものは **`node --test` を何回走らせれば緑になるか**。
ラベルは**テストランナーの終了コード**で、
このリポジトリで一番信用できる種類のものです ——
[23 §12](23-task-filter.md#12-追記--このリポジトリ自身で正解ラベルを実測した) は
規則で書いたラベルを終了コードに替えて数字が動きましたが、
ここには替えるべき手書きのラベルが最初から存在しません。

再現:

```bash
cd experiments/repair && npm install
npm test                       # 14 件(node --test を数回走らせる)
npm run demo                   # 記録から全部の表、API 不要・node --test 不要
npm run truth                  # 305 候補 × node --test を再測定(約 55 秒)
npx tsx src/run.ts --arm score,choice,noul --repeat 2   # 126 リクエスト、$0.013
npx tsx src/run.ts --replay --verify                    # 順序を本物のプロセスで確認
```

---

## 結論(先に)

**1. 判断は 16/16 を一発で当てます。** `score` と `choice` はどちらも
**平均 1.00 テスト実行**。生成順のまま(判断なし)は 3.00、
無作為は 7.69、失敗出力との語彙の重なりは 3.88。
`--verify` で本物のプロセスに当て直しても **16/16 が 1 回で緑**。

**2. 一番安い形が一番良い。** `choice` は**質問 1 つ**で済みます ——
答えの `probabilities` が全候補の順序になるからです。
1 タスク 1,554 トークンで、候補ごとに聞く `score` の 3,254 の半分以下。
それで結果は同じ 1.00。

**3. 「そもそも直る候補が入っているか」も答えられます。** 21 タスクのうち
**5 つは 1 手では直りません**(2 つは 2 か所直す必要があり、3 つは
カタログが作れない編集が必要)。上位値で見ると
`score` は 2.70 ±0.31 対 0.99 ±0.61 で **AUC 1.000**。

**4. ただしその gap は draw より薄い。** `score` の gap は **0.03** で、
同じ質問を 2 回引いたときの上位値の動きは**平均 0.043・最大 0.210**。
**AUC 1.000 でも閾値にはなりません** ——
[25](25-thresholds.md) の「draw より薄いマージンはマージンではない」の実例です。
`noul` は gap 0.08 対 draw 平均 0.018 で、**こちらは使えるかもしれない**。

**5. 生成順は思っていたより強い基準線でした。** 3.00 対 無作為 7.69。
カタログの規則を「よくあるバグを直すもの」から書いた結果、
**生成順そのものが事前分布になっていた**。
コメントに「賢い順序ではない」と書いてあったのを、測って訂正しました。

---

## 1. 題材

```
task             lines  cands  fixes  random  the planted bug
accumulate       19     11     0      12.0    counts reads an absent key and produces NaN
andor            17     19     1      10.0    usable uses || where && was meant
append           16     11     1      6.0     push mutates and returns a length
await            16     5      1      3.0     total uses a promise without awaiting it
bounds           16     16     1      8.5     slice subtracts one from an exclusive bound
clamp            28     32     1      16.5    clamp returns v instead of hi
dedup            25     18     1      9.5     dedupeBy keeps the duplicates
equals           18     18     1      9.5     loose equality makes 0 and "0" the same
guard            18     15     1      8.0     nameOf has no guard for a missing property
lastindex        17     17     1      9.0     last indexes one past the end
missing-return   16     8      1      4.5     double computes the value and drops it
negate           16     14     1      7.5     isEmpty is inverted
normalise        16     17     3      4.5     maxOf's loop bound drops the last element
sort             18     21     1      11.0    ascending uses the descending comparator
sum              27     19     2      6.7     the loop bound drops the last element
swap             16     18     2      6.3     between passes arguments in the wrong order
truthy           16     15     1      8.0     orDefault uses || so 0 falls through
two-bugs-b       12     9      0      10.0    TWO bugs
two-bugs-c       13     11     0      12.0    TWO bugs
two-bugs-d       12     5      0      6.0     TWO bugs
two-bugs-e       12     6      0      7.0     THREE bugs

21 tasks, 305 candidates, 20 of them turn the suite green (7%)
```

12〜28 行の実在する形の JavaScript モジュールに、バグを 1 か所(または複数)植えました。
横に本物の `node:test` があり、**全部が赤から始まります**。
`random` の列は無作為な順序が必要とするテスト実行回数の期待値 `(n+1)/(fixes+1)` です。

候補は `src/mutate.ts` の 25 個の構文規則を全行に当てて作ります ——
`== → ===`、`<  → <=`、`.length → .length - 1`、`push → concat`、
`if (c) → if (!(c))`、`return x;` の識別子差し替え、引数の入れ替え、など。
どの候補が本当に緑にするかは **305 回 `node --test` を走らせて**記録してあり
(`records/truth.json`、55 秒)、
`test.ts` がソースとカタログのハッシュを照合するので**古い truth で採点することはありません**。

`normalise` の blurb は truth が訂正させたものです ——
2 か所バグを植てたつもりでしたが、`==` のほうは
このテストでは無害で、片方直せば緑になりました(fix が 3 つあるのはそのため)。

---

## 2. テスト実行回数

```
ordering     runs: mean  median  worst  first try  solved  reqs  tokens  $
generation   3.00        3.0     9      5/16       16/16   0     0       $0.0000
random       7.69        3.0     31     2/16       16/16   0     0       $0.0000
overlap      3.88        3.0     9      3/16       16/16   0     0       $0.0000
score        1.00        1.0     1      16/16      16/16   21    68328   $0.0029
choice       1.00        1.0     1      16/16      16/16   21    32625   $0.0014
noul         1.06        1.0     2      15/16      16/16   21    56433   $0.0024
```

| 順序 | 何か |
| --- | --- |
| `generation` | 生成順のまま。判断なし・リクエスト 0 |
| `random` | 種つきシャッフル |
| `overlap` | 失敗出力と語彙を共有する候補を前に。無料 |
| `score` | 候補ごとに `score` 1 問、1 リクエストに全部 |
| `choice` | 全候補を 1 つの `choice` に。その `probabilities` が順序 |
| `noul` | 候補ごとに `noul` 1 問 |

**`score` と `choice` は 16/16 を一発**、平均 1.00 回。
`noul` は `sort` だけ 2 回かかって 1.06。

タスクごとに見ると、`generation` が苦しむのは候補が多いところです:

```
task             cands  generation  random  overlap  score  choice  noul
clamp            32     9           31      9        1      1       1
normalise        17     8           2       8        1      1       1
sort             21     4           3       5        1      1       2
andor            19     3           14      3        1      1       1
equals           18     1           16      8        1      1       1
```

`overlap`(無料の基準線)は **`generation` より悪い** ——
失敗出力の語彙は、どの**関数**が壊れているかは教えますが
どの**編集**が正しいかは教えません。`equals` で 1 → 8 に悪化しているのがその形です。

---

## 3. 何が正しい候補だったか

`score` の値で並べて、本物の fix と、その次に高い非 fix を並べます。

```
task             rule                   its value  rank   best non-fix
andor            or-to-and              2.68       1      or-to-nullish 0.98
append           push-to-concat         1.67       1      negate-return 0.81
await            add-await              2.51       1      negate-return 0.15
bounds           drop-offset            2.77       1      flip-offset 1.01
clamp            swap-returned-name     2.87       1      negate-if 1.32
dedup            negate-if              2.85       1      push-to-concat 0.64
equals           loose-to-strict        2.79       1      negate-return 0.79
guard            guard-with-default     2.59       1      negate-return 0.32
lastindex        add-minus-one          2.88       1      negate-return 0.70
missing-return   add-return             2.96       1      loosen-bound 0.14
negate           negate-return          2.82       1      swap-operands 1.46
sort             flip-comparator        2.71       1      flip-comparator 2.42
sum              drop-minus-one         2.90       1      flip-offset 0.60
swap             swap-args              2.88       1      swap-args 0.57
truthy           or-to-nullish          2.80       1      negate-return 0.49
```

**差は大きい**: fix は 1.67〜2.96、2 位は 0.14〜2.42。
唯一きわどいのが `sort` で、**同じ規則が作った 2 つの候補**
(`flip-comparator` を `ascending` に当てたものと `descending` に当てたもの)が
2.71 対 2.42 —— テストを読まないと区別できない対です。
`noul` がここだけ 2 回かかったのも同じ場所でした。

`append` の 1.67 が fix の中で一番低い値で、これが §4 の gap を決めます。

---

## 4. 直る候補が入っているか

21 タスクのうち **5 つは 1 手では直りません**。
2 つは 2 か所直す必要があり、3 つはカタログが作れない編集が必要です。
ループの立場からはどちらも同じ ——
**fix がこの集合に入っていない**。そして総当たりで確かめるには
候補 1 つにつきテスト 1 回かかります。

なので聞きます: **そのタスクの候補の上位値**は、
入っている場合と入っていない場合を分けるか。

```
arm      top value: solvable  unsolvable        gap     AUC
score    2.70 ±0.31 (n=16)    0.99 ±0.61 (n=5)  0.03    1.000
choice   0.99 ±0.02 (n=16)    0.69 ±0.26 (n=5)  -0.04   0.900
noul     0.84 ±0.18 (n=16)    0.15 ±0.07 (n=5)  0.08    1.000

the 5 with no fix in the set, by their top score:
   accumulate       0.34
   two-bugs-b       1.61
   two-bugs-c       1.52
   two-bugs-d       0.37
   two-bugs-e       1.11
```

**gap が正**です。このリポジトリでこの数字が正になったのは初めてで
([24](24-adhoc-rules.md) [25](25-thresholds.md) [29](29-skill-select.md)
[31](31-orchestration.md) は全部負でした)、
理由は明らかです —— **ラベルが終了コード**で、
質問が答えられる形をしている。

### ただし draw より薄い

```
2 draws of every candidate. The gap above has to beat this to be a cutoff:
arm      within-candidate sd  max spread  top-value spread per task
score    0.026                0.250       mean 0.043, max 0.210
choice   0.005                0.070       mean 0.009, max 0.060
noul     0.012                0.200       mean 0.018, max 0.090
```

`score` の gap は **0.03** で、同じ質問を 2 回引いたときの上位値の動きは
**平均 0.043・最大 0.210**。
→ **AUC 1.000 でも閾値にはなりません。** 次の draw が跨ぎます。
[25 §2](25-thresholds.md#2-in-sample-の誤検出-0は情報がない) と
[22 §11.4](22-code-criteria.md#11-追記--保留セットを作り直して穴の深さを測った) が
言っていることの、一番きれいな実例です ——
**きれいに分かれた in-sample は、分かれていることの証拠ではない。**

`noul` は gap 0.08 対 draw 平均 0.018(最大 0.090)で、
**gap が draw の 4 倍**あります。
順序としては `score` に 1 回負けた arm が、**検出器としては勝つ** ——
[17 §3](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) の
「別の問いにする」と同じ向きで、
**「これが fix か」と「fix がここにあるか」は別の質問**だということです。

---

## 5. 1 つの choice で全部の順序が出る

```
the choice's own pick is a fix in 16/16 tasks (100%)
its probability on the picked option: 0.99 ±0.02

tokens per task: choice 1554, score 3254
```

`choice` の答えは `probabilities` に**全選択肢の確率**を持っています。
だから**質問 1 つで完全な順序が出る** ——
候補が 32 個あっても質問は 1 つです。

結果は `score` と同じ 1.00 回で、**トークンは半分以下**。
候補ごとに聞く形([29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) の
ファン・アウト)はこのリポジトリの定番でしたが、
**選択肢が相互排他なら `choice` 1 つのほうが安い**。

ただし §4 の通り、`choice` の確率は**検出器としては使えません**
(gap −0.04、AUC 0.900)—— 確率は全候補で和が 1 になるので、
「どれも駄目」のときも誰かが高くなります。
**順序は choice、"入っているか" は noul。**

---

## 6. 本物のプロセスで確認

§2 の数字は記録した truth から出しています。
`--verify` は同じ順序を**実際に当ててテストを走らせます**:

```
andor            green after 1 real test run(s)
append           green after 1 real test run(s)
...
16/16 reached green by actually applying the edits and running the suite.
```

一致します。

---

## 何が言えるか

1. **文字列を返せないモデルでも修復ループは書ける。**
   パッチを生成するのはコード、選ぶのが判断。
   決定的な部分は全部再現でき、判断は 1 か所に閉じている(§冒頭)。
2. **相互排他な候補なら `choice` 1 つ。** 全選択肢の確率が返るので
   質問 1 つで順序が出て、候補ごとに聞くより**トークンが半分以下**、
   結果は同じ(§5)。
3. **終了コードのラベルは gap を正にする。** このリポジトリで
   gap が正になったのは初めてで、
   質問が答えられる形をしていることの目印です(§4)。
4. **それでも gap は draw と比べる。** AUC 1.000・gap 0.03 に対して
   draw の動きが平均 0.043 —— **閾値にはならない**(§4)。
   `noul` の gap 0.08 対 draw 0.018 のほうが使える。
5. **「これが正解か」と「正解がここにあるか」は別の質問。**
   順序では `score` が、検出では `noul` が勝つ(§4 / §5)。
6. **無料の基準線は書いてから測る。** 生成順が 3.00(無作為 7.69)だったのは
   カタログの規則を書いた順のせいで、
   コードのコメントには「賢い順序ではない」と書いてありました。
   **測って訂正しました**(§2、`src/mutate.ts`)。

---

## 正直な限界

- **カタログは fix を含むように作りました。** これは修復システムではなく
  **並べ替えの測定**です。§2 の "solved 16/16" は
  探索空間の話を何も言っていません ——
  16 タスクとも 1 手で直せるように候補規則を足したからで、実際
  5 個足して 1 個広げました(`drop-offset` / `or-to-nullish` /
  `nullish-to-or` / `negate-if` / `flip-comparator` を追加、
  `swap-returned-name` を行頭アンカーなしに)。
  測ったのは「fix が入っている集合をどう並べるか」だけです。
- **タスクは 21 件で、バグは私が植えました。** 全部が
  **1 行の構文レベルの誤り**で、実際のバグの分布ではありません。
  `node --test` の終了コードというラベルは手書きではありませんが、
  **何を間違いとするかは私が決めています**。
- **候補は 5〜32 個**です。`choice` の上限 255 にも、
  トークン上限にも当たっていません。
  候補が 300 個ある本物のファイルで同じ形が使えるかは
  [30 §1](30-skill-pick.md#1-入るのか) の話になります(たぶん `terse` が要る)。
- **§4 の n は 16 と 5** です。gap 0.03 も AUC 1.000 も、
  **5 件の負例で出した数字**。
  draw との比較(0.043)のほうが信用できる指標で、
  そちらは「使えない」と言っています。
- **繰り返しは 2 回**です。§4 の draw の幅は 2 draw ぶんなので、
  真のばらつきの**下限**です。
- **修復が正しいとは言っていません。** 緑になった編集が
  *意図した* 修正である保証はありません ——
  テストが緑になったことの保証だけです。
  `normalise` は 3 通りで緑になり、そのうち 1 つ(`flip-offset`:
  `xs.length - 1` → `xs.length + 1`)は**配列の末尾を越えて読む**のに
  `undefined > best` が偽なので通ります —— これは overfitting です。
  [3](#3-何が正しい候補だったか) の表で `score` がそれを
  **0.66 で 3 位に置いた**のは良い兆候ですが、
  overfitting を測る実験はここではしていません。
- **費用**: 1,830 判断 / 126 リクエスト / 314,772 入力トークン / **$0.0132**。
  `node --test` は truth の 305 回 + verify の 16 回。

---

## 次に試すこと

- **候補を Jev に絞らせて、その中で当てる。** いまは全候補を並べていますが、
  §5 の `choice` は 1 問なので、**2 段にする**意味があります ——
  1 問目でどの**規則**が効きそうかを選び、その規則の候補だけ当てる。
  候補が 300 個の実ファイルで効く形はそれです。
- **「fix が入っていない」を受けて何をするか。** §4 の `noul` が
  使える検出器なら、その次は**カタログを広げる**判断です ——
  どの規則を足すべきかも `choice` で聞ける。
- **overfitting to the tests を測る。** 緑になった編集が意図した修正かを、
  **別のテストスイート**(ホールドアウト)で採点する。
  `normalise` の 3 つの fix のうち 2 つが意図と違ったので、
  この corpus でもすぐ測れます。
- **TODO の 7 番へ。** 高速なコードレビューツールとして機械的な指標を与える
  ([similarity](https://github.com/mizchi/similarity))——
  ここで作った「コードが指標を出し、判断が並べる」がそのまま同じ形です。
