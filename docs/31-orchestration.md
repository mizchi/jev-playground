# 31. 文書化されたゲートは、聞く方が良いのか組み立てる方が良いのか

[multi-agent-orchestration](https://github.com/mizchi/skills/tree/main/multi-agent-orchestration)
はこのリポジトリが相手にしてきた skill の中で珍しく、
**「判断しろ」ではなく決定手続きを書いています**:

> Default to a **single agent**. Go multi only if **(1) or (2)** holds **and** (4) is positive.
> 1. Independent parts that can run in parallel
> 2. Agents would have different information, models, tools, or permissions
> 3. Intermediate artifacts checkable mechanically
> 4. Expected gain of another agent beats its token / latency cost
>
> **3 is not a reason to spawn.**

つまり答えは **4 つの名前つき条件上のブール式** `(1 or 2) and (4)` です。
だから同じ判断に 2 通りの経路があります:

| | どうやるか |
| --- | --- |
| **聞く** | noul 1 つ。「これは 2 人以上でやる方が良いか」 |
| **組み立てる** | noul 4 つ(条件ごと)を**コード側でブール結合** |

そしてもう 1 つ無料で測れるものがあります ——
**`3 is not a reason to spawn.` という太字が何点ぶんなのか**。
同じ 4 つの答えを `(1 or 2 or 3) and 4` で結合し直せばいいので、
リクエストは 1 本も増えません。

ラベルは skill 自身の文です。シナリオごとに 4 つの事実を固定し、
skill の文が答えを決め、**シナリオ本文はその事実を名前を出さずに述べる**。
トポロジーのラベルは skill の表のうち、そのシナリオを書き起こした行です。

再現:

```bash
cd experiments/orchestration && npm install
npm test                                  # 15 件、API 不要(ラベル一致とラベル漏れの検査)
npm run demo                              # 記録から全部の表、API 不要
npx tsx src/run.ts --arm all --repeat 3   # 114 リクエスト、$0.005
npx tsx src/run.ts --arm nohatch          # 38 リクエスト: 逃げ道の値段
```

---

## 結論(先に)

**1. 組み立てても良くならない。同点。** `(1 or 2) and 4` が 30/38、
そのまま聞いたのが 30/38。**この実験の最初の仮説は外れました。**

**2. 効いたのは質問の枠組み(framing)で、21 ポイント。**
同じ決定を、**先に第 2 ワーカーのコストを述べてから**聞くと 22/38(58%)で、
**誤りは 16 件すべてが「分けない」方向**。
コストの文を消しただけで 30/38(79%)・誤りは +4 / −4 に均衡します。

**3. 太字の 1 文は 4/4 対 0/4。** 条件 3 を規則に入れると、
入れてはいけないと書いてある 4 件を**全部落とします**。
それ以外では両者は同じ答えなので、**あの 1 文だけが差**です。

**4. トポロジーの `choice` は 22/22。** 8 通りの表をそのまま criteria にすると
**パターン同士の取り違えは 0 件**。混ざるのは
「そもそも分けない」側だけです。

**5. 逃げ道は別の質問でなければならない。** 逃げ道を外すと、
分けるべきでない 16 件が **sequential 9 / fanout 5 / debate 2** に押し込まれます。
そして confidence では見分けられません —— 本物の選択 0.87 対 強制された選択 0.82、
**AUC 0.601**。

**6. ばらつきは決定に届いていません。** 3 回引いて、
シナリオ内 sd 0.011〜0.014、最大幅 0.05〜0.09、
**0.5 をまたぐのは 38 件中 0〜1 件**。トポロジーは 0/38 で 1 度も変わらない。
[29](29-skill-select.md) と [30](30-skill-pick.md) が
「測っていない」と書いた項目です。

---

## 1. コーパス

```
38 scenarios: 22 the gate sends to more than one worker, 16 it keeps single
topologies: blackboard=2 debate=2 dynamic_dag=2 evolution=2 fanout=7
            handoff=2 sequential=2 single=16 supervisor=3
7 are rows of the skill's own "Common mistakes" table
4 are built so that admitting condition 3 into the rule changes the answer

condition    true  false
independent  15    23     (1) 並行に走らせられる部分がある
different    10    28     (2) ワーカーが持つ情報・道具・権限が違う
three        30    8      (3) 中間成果物が機械的に検査できる —— 規則には入らない
bigEnough    26    12     (4) もう 1 人のコストが小さいと言える程度に大きい
```

`7 traps` は skill の "Common mistakes" 表の 7 行を全部シナリオにしたものです ——
「programmer と reviewer と名前を付ける」「debate で直る」「まず 5 人チーム」
「全員に全スレッドを渡す」「関数呼び出しがあるから並行にできない」
「worktree があるから write-set は無視できる」「エージェントが多いほど品質が上がる」。
どれも**言葉としては複数ワーカーの語彙を使っていて、答えは single** です
(1 つだけ逆で、`function-call-edge` は「できない」と言いながら答えは multi)。

### 条件 4 について、1 つだけ解釈しました

条件 4 を字義通り読むと(「**もう 1 人**の期待利得がコストを超えるか」)、
**条件 1・2 から独立ではありません** —— 並行にできる部分が無ければ
もう 1 人の利得は 0 なので、1 も 2 も無いときに 4 が真になることはなく、
ゲートは `(1 or 2)` に潰れます。
コーパスは 4 を**規模の事実**として読みました ——
「もう 1 人ぶんのトークンとレイテンシが小さいと言える程度に大きいか」。
連言が意味を持つにはそう読むしかなく、これが本文で唯一の解釈です。

### 無料の基準線

```
gate: 17/38 (45%)
topology: 17/38 (45%)
on the 7 "Common mistakes" rows it gets 2/7 right
  wrong on: programmer-reviewer, debate-will-fix, team-of-five,
            worktrees-ignore, full-thread
```

キーワードです。skill 自身の trigger 行が語彙の列挙
("multi-agent, orchestration, fan-out, worktree, blackboard, verifier")
なので、書くに値する基準線ではあります。
そして**罠の 5/7 で落ちます** —— 「3 つのエージェント、3 つの worktree」を
3 つのエージェントと読む。罠がそういう形で書かれているからです。

---

## 2. 聞くか、組み立てるか

```
reading                  right           over / under
direct (cost named)      22/38    58%    +0 / -16
direct (plain)           30/38    79%    +4 / -4
composed (1|2)&4         30/38    79%    +2 / -6
composed (1|2|3)&4       26/38    68%    +6 / -6
stay_single inverted     30/38    79%    +4 / -4
```

`+` は skill が single と言うものを複数に送った数、`−` はその逆です。

**組み立てても良くなりません** —— 30/38 対 30/38。
[07](07-escalation.md) で二層構成の経済性が出なかったのと同じ形で、
「分解すれば良くなる」は**測ると出ないことがある**。

ただし**誤りの形が違います**。組み立ては +2 / −6 で保守的、
素直に聞くのは +4 / −4 で均衡。
**どちらの誤りが高いかで選ぶもの**で、正解率では選べません。

そして組み立てには正解率に出ない値打ちが 1 つあります ——
**4 つの原子が答えの理由になる**。
noul 1 つは「0.19」しか返しませんが、
`(1)=0.19 (2)=0.30 (3)=0.93 (4)=0.95` は
「検査はできるが分けられる部分が無い」と読めます(§4 の表がそれです)。

### 2b. 同じ 5 つを、シナリオの種類ごとに

```
class                    n    direct(cost)  direct(plain)  (1|2)&4  (1|2|3)&4  stay_single
traps (the skill's own)  7    6/7           4/7            5/7      5/7        3/7
condition-3-only         4    4/4           4/4            4/4      0/4        4/4
plain multi              22   6/22          18/22          16/22    16/22      18/22
plain single             6    6/6           5/6            6/6      6/6        6/6
```

**集計が形を隠していました。**
コストを先に述べた noul は「分けない」側で 6/7・6/6 と最良で、
**分けるべき 22 件では 6/22** —— つまりあれは正解率の指標ではなく
**保守性のダイヤル**です。逆に `stay_single` は罠で 3/7 と最も甘い。

→ **偽陽性(不要な分割)が高くつくなら コストを先に述べる。
偽陰性(分けるべきものを分けない)が高くつくなら述べない。**
[21 §7](21-eslint-plugin-jev.md#7-confidence-をゲートにすると-11-ポイント損する) の
「confidence はルーティングに使う」と同じ構図が、
質問の書き方の側に出ています。

---

## 3. 4 つの条件を 1 つずつ

```
condition    right          true mean   false mean  gap    AUC
independent  27/38   71%    0.84 ±0.09  0.49 ±0.25  -0.21  0.906
different    28/38   74%    0.71 ±0.24  0.42 ±0.16  -0.55  0.823
three        30/38   79%    0.72 ±0.21  0.30 ±0.16  -0.33  0.925
bigEnough    30/38   79%    0.72 ±0.22  0.24 ±0.20  -0.44  0.936
```

AUC はどれも 0.82 以上なので**順序としてはよく分かれている**のに、
0.5 で切った正解率は 71〜79% です ——
`gap` が全部負なので、[25](25-thresholds.md) の言い方だと
**「重なっている」= 健全で完全な閾値は存在しない**。
`independent` の偽側の平均が 0.49 ±0.25 というのが一番苦しいところで、
「分けられる部分があるか」は**半分くらい 0.5 のそばに落ちます**。

そして組み立てるときは**どの原子の誤りが効くかがブール式で決まります**:
`(1 or 2) and 4` なので、
- **(4) の誤りは全件を反転させる**(連言)
- **(1) の誤りは (2) も偽のときだけ反転する**(選言)

一番弱い原子 (1) が一番影響の小さい位置にいる、というのは運です。
これが逆なら組み立ては聞くより悪くなります。

---

## 4. 太字の 1 文が何点ぶんか

skill は太字で **`3 is not a reason to spawn.`** と書いています。
条件 3 があり、1 も 2 も無く、4 は正、というシナリオを 4 つ作れば、
2 つの読み方は必ず食い違います。

```
scenario         (1)    (2)    (3)    (4)    rule   +3     direct
three-only       0.19   0.30   0.93   0.95   single multi  0.21
three-only-2     0.13   0.47   0.97   0.94   single multi  0.13
three-only-3     0.20   0.42   0.89   0.93   single multi  0.17
three-only-4     0.16   0.26   0.95   0.85   single multi  0.19
```

**4 件とも single が正解**で、原子はすべて正しく答えています ——
(3) は 0.89〜0.97、(1) は 0.13〜0.20。
それでも規則に 3 を入れると **0/4** になります。

→ **判断は正しく、ブール式だけが間違う。**
このリポジトリは「ラベルが粗いとモデルの正解が誤りに見える」を
[28](28-bilingual.md) と [29](29-skill-select.md) で 2 回見ましたが、
これはその**合成側の版**です ——
原子が全部当たっていても、結合が違えば答えは違う。
だから skill があの 1 文を太字にしているのは正しい。

---

## 5. トポロジーの choice

skill の表 8 行をそのまま `choice` の criteria にしました。

```
on the 22 that have a topology: 22/22 (100%)

on the 16 the skill keeps single, `stay_single` fires 12/16 (75%)
and on the 22 that have a topology it fires anyway on 4:
  library-survey, research-broad, repeated-class, debate-hiring
```

**22/22。** 混同行列を見ると理由が分かります:

```
want \ got     seque fanou super hando black debat dynam evolu singl
sequential     2
fanout               7
supervisor                 3
handoff                          2
blackboard                             2
debate                                       2
dynamic_dag                                        2
evolution                                                2
single         1     2                       1                 12
```

**パターン同士の取り違えは 1 件もありません。** skill が自分で名指ししている
3 つの混同(handoff 対 agent-as-tool、supervisor 対 dynamic DAG、
fan-out 対 debate)も起きていない。
漏れているのは `single` の行だけ ——
分けるべきでない 4 件が sequential 1 / fanout 2 / debate 1 に流れています。

**8 行の表が criteria としてよく効いている**ということで、
[17 §2](17-task-picker.md#2-結果--名前だけで-90説明文を足すと-100) の
「説明文を足すと 100%」と同じ性質です。
表の "Use for" 列は**人がその目的で書いた 1 行**なので、
[29 §9](29-skill-select.md#9-人の-1-行は-skill-自身の-description-より良い) と
同じことがここでも起きています。

### 5b. 逃げ道を外すと

```
on the 22 that have a topology: 22/22 (100%)

with no escape hatch, the stay-single scenarios are forced into:
   sequential     9
   fanout         5
   debate         2

confidence on the 22 real ones 0.87 ±0.18, on the 16 forced ones 0.82 ±0.20
AUC of confidence as a "was this a real choice" detector: 0.601
```

**正解率は変わりません**(22/22)。変わるのは、
分けるべきでない 16 件に**「該当なし」と言う手段が無くなる**ことです ——
9 件が sequential に、5 件が fanout に、2 件が debate に入る。

そして **confidence では代用できません。** 本物の選択 0.87 対
強制された選択 0.82 で、AUC 0.601。ほぼ当てにならない。
[17 §3](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) が
「逃げ道は選択肢ではなく別の問いにする」と書いたことの、
**測り直しと値段**です。choice は必ず答えるし、
答えたことの後悔は confidence に出ません。

---

## 6. もう一度聞くと

[29](29-skill-select.md) と [30](30-skill-pick.md) はどちらも
「繰り返しは 1 回で、ばらつきは測っていない」を限界に挙げました。
ここは 3 回引いています。

```
question      within-scenario sd  max spread  crossings of 0.5
decision      0.012               0.070       0/38
decisionPlain 0.013               0.050       1/38
independent   0.012               0.090       1/38
different     0.014               0.070       1/38
three         0.013               0.060       1/38
bigEnough     0.012               0.080       1/38
staySingle    0.011               0.050       1/38
topology      (a class)                       0/38 changed between draws
```

**決定に届くのは「またぐ」件数だけ**で、それは 38 件中 0〜1 件です。
トポロジーは 3 回とも同じクラスを返しました。

ただし**ゼロではありません**。§2 の `composed` は最初の収集で 31/38、
再収集で 30/38 でした —— 1 件の差は
ここで測った `bigEnough` のまたぎ 1 件と整合します。
**「30/38」と「31/38」は同じ測定の別の draw** だと読むべき数字です。

---

## 何が言えるか

1. **分解が効くとは限らない。** ブール式が書いてあっても、
   組み立てて 30/38・そのまま聞いて 30/38 で同点(§2)。
   分解の値打ちは正解率ではなく**理由が出ること**と
   **誤りの向きを選べること**でした。
2. **質問の枠組みが 21 ポイント。** 第 2 ワーカーのコストを先に述べると
   58%、述べないと 79%。同じ決定・同じ state・同じ 1 リクエスト(§2)。
   → **コストを述べるかどうかは、保守性のダイヤルとして意識的に選ぶ。**
3. **結合の 1 行は原子より脆い。** 4 つの原子が全部当たっていても、
   条件 3 を規則に入れれば 4/4 が 0/4 になる(§4)。
   **判断を測るときは結合を疑う。**
4. **表 8 行をそのまま criteria にすると 22/22。**
   人がその目的で書いた 1 行は、選択肢の説明として強い(§5)。
5. **逃げ道は別の noul で。** confidence は強制された選択を
   AUC 0.601 でしか見分けない(§5b)。
6. **ばらつきは決定に届いていない** —— 38 件中 0〜1 件(§6)。
   [29](29-skill-select.md) と [30](30-skill-pick.md) の
   1 回だけの数字は、この範囲では安全でした。

---

## 正直な限界

- **シナリオ 38 件は私が書きました。** 4 つの事実は各シナリオが宣言し、
  ゲートは skill の文なので**ラベルは私の意見ではありません**が、
  「その事実が読み取れる文章」を書いたのは私です。
  漏れの検査は入れてあります(条件番号・ブール式・パターン名・
  `stay-single` / `go multi` という語が本文と payload に出ないこと、
  罠が自分を罠と名乗らないこと)。
  それでも**難易度は私が決めています**。
- **条件 4 の読み替えが本文で唯一の解釈**です(§1)。
  字義通り読むとゲートは `(1 or 2)` に潰れるので、
  規模の事実として読みました。別の読み方を採ると
  `bigEnough` の 26/12 の分布が変わり、§2 の数字も動きます。
- **4 と 22 と 7 は小さい。** 太字の 1 文の値打ちは **4 件**で測っています。
  「4/4 対 0/4」は綺麗ですが 4 件です。
  罠は 7 件、分けるべきものは 22 件。
  §2b の表の各セルは 4〜22 件ぶんの自信しかありません。
- **トポロジーの 22/22 は上限に当たっています。** 取り違えが 0 なので、
  この corpus では**どの書き方が良いかを比べられません** ——
  もっと紛らわしいシナリオが要ります。
  skill が名指しする 3 つの混同を狙って書いたつもりですが、
  狙いが弱かったということです。
- **`(1 or 2 or 3) and 4` は藁人形ではありません**が、
  「条件 3 を理由にしてしまう読み方」を私が定式化したものです。
  実際にそう誤読する人がどれくらい居るかは測っていません。
  測ったのは「そう誤読したら 4/4 が 0/4 になる」ことだけです。
- **費用**: 152 リクエスト / 151,750 入力トークン / **$0.0064** /
  平均 174 ms。1 シナリオ 8 問を 1 リクエストで聞いています。

---

## 次に試すこと

- **枠組みを軸にして測り直す。** §2 の 21 ポイントは、
  この repo が 30 本かけて一度も軸にしていなかったもの ——
  同じ判断・同じ state で、**質問文にコストを書くかどうか**だけの対比。
  [18](18-permission-hook.md)(危険度判定)や
  [23](23-task-filter.md)(タスクを削る)は
  どちらも「保守側に倒したい」問題なので、
  そこで同じダイヤルが効くかは測る価値があります。
- **紛らわしいトポロジーを書く。** 22/22 は corpus が易しい。
  skill 自身が名指しする 3 つの混同
  (handoff 対 agent-as-tool、supervisor 対 dynamic DAG、
  fan-out 対 debate)を、**両方に読める文章**で書き直す。
- **原子を説明として使う。** §2 で組み立ての値打ちが
  「理由が出ること」だと分かったので、
  4 つの原子から**人間が読む 1 行**を生成して、
  それが正しいかを読む(組み立ての出力が使えるかは正解率では測れない)。
- **TODO の 6 番へ。** 決定的なワークフローを生成して
  コーディングエージェントとして実装する([rlm](https://github.com/mizchi/rlm) のような)
  —— ここで測った「トポロジー選択 22/22」と
  「ゲートは枠組み次第」が、そのまま生成側の入力になります。
