# 30. 461 個の skill から選ぶ — 入るのか、前段は何を買うのか

[29](29-skill-select.md) は 74 skill で測って、限界を正直に書きました ——
description が 9,410 トークンで**まだ全部入る**ので、
「コンテキストに入らないカタログ」は名前だけで、状況ではなかった。

この回はそこを潰します。ロスターは **461 個**で、
出どころは mizchi 自身の `skill-finder` が探索順として挙げている先
(Anthropic 公式 → registry → VoltAgent → Superpowers → GitHub topic)と
mizchi のリポジトリ群です。**全部が実在の公開 skill / subagent**で、
かさ増しは 1 件もありません。

| | 件数 | 何か |
| --- | --- | --- |
| wshobson/agents | 183 | plugin ごとの `SKILL.md` |
| VoltAgent/awesome-claude-code-subagents | 161 | subagent 定義(name + description は同じ形) |
| mizchi/skills ほか 4 リポジトリ | 83 | mizchi 本人のもの |
| anthropics/skills | 20 | 公式 |
| obra/superpowers | 14 | |

ラベルは **[29](29-skill-select.md) のものをそのまま**使います
(カタログのティア凡例をプロジェクトごとに適用したもの)。
カタログに載っている 74 件がその対象で、残り **387 件は distractor** ——
カタログの方針に従えば提案に入らないもの、というのは**構成上のラベル**なので、
§5 で上位を読んで確かめます。

再現:

```bash
cd experiments/skill-pick && npm install
npm test                      # 20 件、API 不要(join とラベル漏れの検査)
npm run demo                  # 記録から全部の表、API 不要
npx tsx src/pick.ts . --stage1-only          # 道具、API キー不要
npx tsx src/pick.ts . --prior --intent "..."  # 1 リクエスト、$0.0004
npx tsx src/run.ts --ceiling                 # 10 リクエスト: 400 がどこから出るか
npx tsx src/collect.ts /home/user            # ロスター再構築(クローンが必要)
```

---

## 結論(先に)

**1. 書いたままでは入らない。書き方を変えると入る。**
通常の fan-out は 1 問ごとに**タスク文と 4 つの criteria を繰り返す**ので、
1 問 251 トークン —— うち description は 131 トークンだけ。
**260 問で 65,151 トークン、280 問で 400。** 461 問は入りません。
criteria を state に 1 回だけ置くと 1 問 118 トークンになり、
**461 問が 1 リクエスト 54,284 トークンで入ります**(520 問まで入り、560 で 400)。

**2. それでも前段は残す。ただし理由が逆。** 前段の値打ちは recall ではなく
**precision** でした。k を増やすと recall は 63% → 100% に上がるのに、
ユーザーが読む 12 行の当たり率は **0.25 → 0.19 に下がる**。
461 件のうち 387 件は curate されていない実在 skill で、
その多くが**どのリポジトリにも当てはまる**からです。

**3. 「どこでも高い」を引くと直る。** skill ごとの
**他 13 プロジェクトでの平均**を引くだけで、
P@12 0.25 → 0.28(k=60)、0.19 → 0.23(全件)、AP は 0.19 → 0.29。
判断に対する IDF です。

**4. 無料の前段には recall の天井がある。** 語彙の重なりは
k をいくら増やしても **85% で止まります** ——
欲しい行の 15% はプロジェクト文と語彙を 1 つも共有していない。
第 1 文だけに当てる版は 67% で止まります。

**5. 道具として成立した。** 評価ループの終点は
`overlap@60 + terse + prior` で、**1 リクエスト・$0.0003/プロジェクト・P@12 0.30**。
無作為に 60 件残す対照は 0.08 なので、**3.75 倍**です。

**6. 実在の 2 リポジトリで回しました。** [29](29-skill-select.md) の
「プロジェクトは私が書いた合成」という限界の半分が消えます(§9)。

---

## 1. 入るのか

```
form    questions  result                   input tokens  per question
full    120        OK                       32025         267
full    200        OK                       51034         255
full    240        OK                       60590         252
full    260        OK                       65151         251
full    280        max_tokens_exceeded      -             -
full    300        max_tokens_exceeded      -             -
full    461        max_tokens_exceeded      -             -
terse   461        OK                       54284         118
terse   520        OK                       62965         121
terse   560        max_tokens_exceeded      -             -
```

`full` は [29](29-skill-select.md) と同じ書き方です。
1 問が運ぶのは skill 名・description・タスク文・4 段階の criteria で、
**後ろ 2 つは全問で同一の文字列**。それが 1 問 251 トークンのうち
120 トークン前後を占めます。

`terse` はその 2 つを state に 1 回だけ置き、
質問に残すのは skill と 4 つの単語(`no use` / `adjacent only` /
`fits, but unasked` / `needed now`)だけ。それ以外は何も変えていません。

→ **ロスターが「入らない」のはロスターの大きさではなく、
fan-out が方針文を n 回払う書き方のせいでした。**
答えがどれだけ動くかは §7。

---

## 2. 無料の前段は何を残すか

欲しい行(`want`)のうち、上位 k に残った割合:

```
prefilter   k=15    k=30    k=60    k=90    k=120   k=180   k=260
overlap     39%     52%     63%     78%     82%     85%     85%
tfidf       37%     51%     63%     78%     82%     85%     85%
firstline   33%     46%     64%     66%     66%     67%     67%
random      7%      11%     22%     40%     48%     49%     59%
```

`random` は対照です。k で k/461 を残すので、
そこを大きく超えない前段は何も買っていません。
同点は**必ず前段に不利な向き**(正例を後ろ)に割ります
—— [29](29-skill-select.md) と同じ規則で、
これを入れないと「半分が 0 点」の前段がソート順で得点します。

**そして天井があります。** `overlap` は k=180 以降 85% で止まる ——
`k` を 461 にしない限り上がりません。止まる理由は
**欲しい行の 15% がプロジェクト文と語彙を 1 つも共有していない**からで、
0 点の塊の中に沈んだままになります。
[29](29-skill-select.md#1-何を測ったか) が 74 件で
「プロジェクトによって 17〜65 件が 0 点」と書いたものが、
461 件では取り返しのつかない形で出ます。

`firstline`(description の第 1 文だけ)は 67% で止まります。
**description の後ろの方に効く語が入っている**ということです。

---

## 3. 上げるべきは recall ではなかった

前段の k を変えて、同じ判断で端から端まで測ります。

```
prefilter   k     recall  AP     P@12   worst  reqs  tok/proj  $/proj
overlap     60    63%     0.39   0.25   50.3   1     14524     $0.0006
overlap     120   82%     0.34   0.24   91.8   1     29049     $0.0012
overlap     260   85%     0.27   0.21   186.8  1     62939     $0.0026
tfidf       60    63%     0.42   0.26   49.3   1     14524     $0.0006
firstline   60    64%     0.34   0.21   49.1   1     14524     $0.0006
random      60    22%     0.39   0.08   38.3   1     14524     $0.0006
none        461   100%    0.19   0.19   321.6  2     111596    $0.0047
```

**recall が上がるほど提案が悪くなります。** P@12 は
0.25(k=60)→ 0.24 → 0.21 → **0.19(全件)**。
`worst`(欲しい行のうち一番下の順位)も 50 位 → 322 位。

読むのは AP ではなく **P@12** です。AP は**残った候補の中**で計算するので、
正例をほとんど捨てた前段でも「残した 2 つを完璧に並べた」なら高く出ます ——
`random@60` が AP 0.39・P@12 0.08 なのがその形です。
P@12 は「ユーザーが読む 12 行に何が入っていたか」を聞きます。

`tfidf`(IDF を 2 乗して、同じ語彙で書かれた 183 件の agent を強く割り引く)が
`overlap` を P@12 で 0.01 上回りますが、**recall は同じ 63%** ——
つまり残す顔ぶれが少し良いだけで、差は 14 プロジェクトぶんの自信しかありません。

---

## 4. §3 が乗っている仮定を測り直す

§3 の表は**全部 1 つの記録から**出しています。461 問を投げた記録を
「前段の上位 k に絞って読む」ことが「k 問だけ聞いた」と同じだ、
という仮定に乗っていて、それは
[29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ) が測ったことです。
別のドメインで引用するだけでは足りないので、ここでも測りました:

```
60 questions per request against 182, same state, same question:
840 pairs, same level 97%, within 0.25 100%, mean |diff| 0.020

AP over the k=60 survivors: 0.38 asked narrow, 0.39 taken from the wide run
```

**成立しています。** 60 問のリクエストで聞いた答えと、
182 問のリクエストから取り出した答えは、
レベルで 97%・0.25 以内で 100% 一致します。

これは道具としても効きます:
**ロスター全体を 1 回測れば、前段の設計をいくつ試しても追加のリクエストは 0** です。
§8 の評価ループ 10 行は、それで 1 回ぶんの費用しかかかっていません。

---

## 5. 判断が好む distractor を読む

387 件の distractor は「カタログに無い」ので `no` です。
**それは構成上のラベル**なので、上位を読みます。

| プロジェクト | 1 位 | 2 位 | 3 位 |
| --- | --- | --- | --- |
| ts-cf-e2e | webapp-testing 2.96 | github-actions-templates 2.95 | devops-engineer 2.94 |
| aws-ecs | changelog-automation 3.00 | deployment-engineer 3.00 | devops-engineer 3.00 |
| flaky-suite | test-automator 3.00 | systematic-debugging 2.91 | devops-engineer 2.89 |
| dep-audit | dependency-manager 3.00 | dependency-upgrade 2.73 | verification-before-completion 2.42 |
| article-draft | doc-coauthoring 2.99 | technical-writer 2.99 | content-quality-editor 2.93 |
| gleam-api | code-review-excellence 2.99 | code-reviewer 2.99 | requesting-code-review 2.97 |
| bare-repo | context-manager 2.96 | context-driven-development 2.50 | scan 1.92 |

読んだ結論は明快です。**モデルは間違っていません。**
GitHub Actions で deploy する ECS サービスに `deployment-engineer` は当てはまるし、
`pnpm outdated` が溜まったリポジトリに `dependency-manager` は当てはまる。
`no` なのは「mizchi が curate していない」からで、「違う」からではない。

そして**それが問題**です。`code-reviewer`・`devops-engineer`・
`test-automator` のような skill は**どのリポジトリにも当てはまる**ので、
上位 12 行をそれで埋めても正しくて役に立ちません。
数字でも出ています —— 2.5 以上を付けた割合は
カタログ行 1,036 件中 **5%** 対 distractor 5,418 件中 **2%**。
つまり判断はカタログ行を 2.5 倍好むのに、母数が 5 倍なので**負けます**。

→ **候補プールを curate していないとき、「候補を増やす」は
「選択が良くなる」ではありません。** curation は
どの selector も取り返せない仕事をしています。

---

## 6. どこでも高いものを引く

§5 の言い換えです: 情報は score そのものではなく、
**その skill 自身の水準からどれだけ超えているか**。
なので skill ごとの平均を引きます。**判断に対する IDF** です。

平均は**プロジェクト単位でホールドアウト**します ——
ある skill の水準は「その 1 件を除いた 13 プロジェクトでの平均」なので、
自分の答えが自分の補正を決めることはありません。
道具側では、これは**ロスターと一緒に配る 1 列の数字**になります(§9)。

```
prefilter   k     P@12 raw  P@12 spec  AP raw  AP spec  worst raw -> spec
overlap     60    0.25      0.28       0.39    0.45     50.3 -> 42.0
overlap     120   0.24      0.27       0.34    0.41     91.8 -> 85.1
overlap     260   0.21      0.25       0.27    0.37     186.8 -> 187.6
none        461   0.19      0.23       0.19    0.29     321.6 -> 341.4
```

**プールが大きいほど効きます** —— 全件では AP が 0.19 → 0.29(+53%)。
当然で、大きいプールほど「どこでも当てはまる」ものが多く入ります。

水準の高い順に並べると、上から 8 件のうち 7 件が distractor です:

```
verification-before-completion     2.25  distractor
code-reviewer                      1.89  distractor
requesting-code-review             1.89  distractor
writing-plans                      1.83  distractor
devops-engineer                    1.71  distractor
github-actions-templates           1.60  distractor
security-expert                    1.56  catalogued
discernment-nudge                  1.55  distractor
```

唯一のカタログ行 `security-expert` は、
[29 §7](29-skill-select.md#7-どこでカタログと食い違うか) が
「5 プロジェクトで誤検出」と名指ししたものです。同じものが 2 つの測り方で出ます。

461 件のうち **158 件は平均 0.05 未満** —— このロスターの 3 分の 1 は
14 プロジェクトのどれにも当てはまりません。

---

## 7. criteria の文字列の値段

§1 の「1 問 251 トークン、うち description は 131」の差は、
タスク文と 4 つの criteria を 1 問ごとに繰り返している分です。
**fan-out の payload の中で唯一、全問が同一の部分**なので、
縮めるのは自明な手ですが、答えが動くかどうかは測る話です。

```
arm      tokens/question  tokens/project  questions per request  ms/req
full     242              111596          270 would fit          576
terse    120              55364           545 would fit          435

6454 pairs: same level 95%, within 0.25 95%, mean |diff| 0.057

at overlap@60: AP 0.39 -> 0.38, P@12 0.25 -> 0.24
with the §6 correction: AP 0.45 -> 0.46
```

**半分になって、答えはほぼ動きません。** レベル一致 95%、平均差 0.057。
指標も動かない(§6 の補正込みなら AP は 0.01 良くなる)。

そして §1 が測ったとおり、これが**ロスターが 1 リクエストに入るかどうかの差**です。
質問数の上限は質問数ではなくトークンなので
([00](00-api-notes.md#token-ceilings))、
**質問ごとに同じ文字列を置くのをやめると上限そのものが 2 倍になります。**

---

## 8. 評価ループ

1 回に 1 つだけ変えます。行が動かなければ、それは効かなかったということです。
全行が**同じ記録**から出ていて(§4)、費用も**その arm の実測平均**です。

```
#   config                   recall  AP     P@12   reqs  $/proj   what changed
1   random@60                22%     0.39   0.08   1     $0.0006  対照: 無作為に 60 件
2   overlap@60               63%     0.39   0.25   1     $0.0006  IDF の重なりに変える
3   firstline@60             64%     0.34   0.21   1     $0.0006  description の第 1 文だけ
4   tfidf@60                 63%     0.42   0.26   1     $0.0006  IDF を 2 乗する
5   overlap@120              82%     0.34   0.24   1     $0.0012  素の重なりに戻して予算 2 倍
6   overlap@260              85%     0.27   0.21   1     $0.0026  full 形式で 1 リクエストに入る最大
7   none@461                 100%    0.19   0.19   2     $0.0047  前段なし、full 形式
8   none@461 terse           100%    0.20   0.20   1     $0.0023  criteria を 1 回だけ払う(§7)
9   none@461 terse+prior     100%    0.29   0.23   1     $0.0023  skill の水準を引く(§6)
10  overlap@60 terse+prior   63%     0.46   0.30   1     $0.0003  その上に前段を戻す
```

**終点は 10 行目**: `overlap@60 + terse + prior`。
**P@12 0.30・AP 0.46・1 リクエスト・$0.0003/プロジェクト。**
対照(1 行目)の 0.08 に対して 3.75 倍、
素直に全件投げる 7 行目に対して **P@12 1.6 倍でコスト 16 分の 1** です。

行ごとに読めること:

- **2 対 1**: 前段が効く(0.08 → 0.25)。
- **3 対 2**: 第 1 文だけでは落ちる(0.25 → 0.21)。description は全部使う。
- **4 対 2**: IDF の 2 乗はほぼ無差別(+0.01)。**効かなかった**。
- **5 / 6 対 2**: 予算を増やすと悪くなる(0.25 → 0.24 → 0.21)。
- **8 対 7**: 書き方だけでコスト半分・品質同じ。
- **9 対 8**: 水準を引くと +0.03。
- **10 対 9**: 前段と水準は**独立に効く**(0.23 → 0.30)。

---

## 9. 道具として、実在の 2 リポジトリで

`src/pick.ts` はディレクトリを 1 つ受け取って提案を出します。
プロジェクトの事実は `project.ts` がディスクから読みます ——
ファイル survey(manifest とディレクトリ名、`node_modules` は除外、120 パスまで)、
`CLAUDE.md` の行、そして**依頼 1 文**。最後のものは人が書く必要があります
([29 §5](29-skill-select.md#5-ラベルを何が決めるかで勝つ-selector-が変わる) の
`ask` クラスが正例の 30/135 で、ファイルツリーからは出ないものだからです)。

```
mizchi/jev-playground -- overlap@60, 1 request, 10590 tokens, $0.0004
  「MoonBit と TypeScript の混在リポジトリで、実験の測定コードを書き足しては
    just でテストと lint を回している。docs のレポートを増やす作業が主で、CI は GitHub Actions」
    1.64  justfile                   mizchi/skills
    1.50  content-quality-editor     VoltAgent
    1.41  moonbit-practice           mizchi/skills
    1.37  knowledge-synthesizer      VoltAgent
    1.34  moonbit-js-binding         mizchi/skills
    1.31  performance-monitor        VoltAgent
    1.17  trace-to-training-data     wshobson/agents
    0.94  avoid-ai-writing           wshobson/agents

mizchi/similarity -- overlap@60, 1 request, 11296 tokens, $0.0005
  「Rust で書いた CLI を npm と cargo に publish している。
    TypeScript の薄いラッパーもあり、リリースとテストを整えたい」
    2.39  rust-engineer              VoltAgent
    1.93  check-similarity-rs        mizchi/similarity
    1.59  changelog-automation       wshobson/agents
    1.31  check-similarity-py        mizchi/similarity
    1.19  javascript-testing-patterns wshobson/agents
    1.17  python-packaging           wshobson/agents
    1.07  check-similarity-ts        mizchi/similarity
    0.95  actions-ci-tuning          mizchi/skills
```

実在リポジトリにラベルは無いので、**読むしかありません**。読んだ結果:

- `jev-playground` の上位 8 件のうち**正しいのは 3 件** ——
  `justfile`(このリポジトリの task runner)、`moonbit-practice`、
  `moonbit-js-binding`。`opentelemetry` と `retrospective-codify` は
  **11 位と 12 位**で、12 行に入りはしますが下の方です。
  上位に混ざる 5 件は curate されていない側のノイズで、§5 と同じ形です。
  **§3 の P@12 0.30 という数字は、こう見えます。**
- `similarity` は **1 位が `rust-engineer`** で、これは正しい
  (Rust の CLI です)が**カタログには無い**もの。2 位が
  `check-similarity-rs` —— **そのリポジトリ自身が配っている skill** を、
  言語まで合わせて当てています。`-py` と `-ts` も上位に入り、
  [29 §7](29-skill-select.md#7-どこでカタログと食い違うか) で見た
  「言語別の撃ち分け」がここでも出ます。
- どちらも `CLAUDE.md` が無いので、判断が読んだのは
  **ファイルツリーと依頼文だけ**です。

`--stage1-only` は API キーもネットワークも要りません。
前段だけで k=60 の recall が 63% なので、
**短いリストを渡すには足ります**(§2)。

---

## 何が言えるか

1. **「入らない」は大きさではなく書き方だった。**
   461 問は通常の fan-out では 400 になり、
   criteria を state に移すと 1 リクエストに入る。上限は
   質問数ではなくトークンなので、**全問で同一の文字列は state に置く**(§1 / §7)。
2. **前段は recall のためではなく precision のために置く。**
   k を増やすと recall は上がって提案は悪くなる(§3)。
3. **curate されていない候補を足すと選択は悪くなる。**
   足した 387 件は実在の skill で、判断はそれを正しく高く評価し、
   そのせいで提案が「どのリポジトリにも当てはまるもの」で埋まる(§5)。
4. **「どこでも高い」を引く。** skill ごとの水準を他プロジェクトから測って引くと、
   プールが大きいほど効く(全件で AP +53%)(§6)。
5. **1 回測れば設計は何度でも試せる。** 幅で答えが動かない
   ([29 §4](29-skill-select.md#4-ファンアウトの幅は無料答えが同じ))ので、
   ロスター全体を 1 回測った記録から評価ループ 10 行が出せる(§4 / §8)。
6. **常用できる値段になった。** 1 リクエスト・$0.0003/プロジェクト・
   レイテンシは実測 340 ms と 413 ms。1 日 100 回呼んでも 1 か月 $0.9 です。

---

## 正直な限界

- **ラベルは 74 件ぶんしかありません。** 387 件の distractor は
  「カタログに無い」で `no` にしていますが、§5 で読んだとおり
  **その多くは実際に当てはまります**。だから P@12 の絶対値は
  「mizchi の curate した提案をどれだけ再現したか」で、
  「良い提案か」ではありません。
  §3 の「recall を上げると P@12 が下がる」は
  **この読み方でも向きが変わりません**(distractor が本当に妥当なら、
  なおさら「増やすと curate 済みの提案からは離れる」だけなので)が、
  「0.30 が良い数字か」には答えていません。
- **プロジェクトは 14 件で、12 件は [29](29-skill-select.md) の合成です。**
  §9 の 2 件だけが実在で、そこにはラベルがありません。
  §6 の水準(prior)は 14 件の平均なので、
  **参照プロジェクトが変われば prior も変わります**。
  道具では記録から読む形にしてあり、キャッシュが無ければ
  `--prior` は何も引かずにそう表示します。
- **VoltAgent の 161 件は skill ではなく subagent です。**
  選択に使う 2 つのフィールド(name と description)は同じ形なので
  ロスターに入れましたが、**「入れるべきもの」の集合としては別物**です。
  `kind` で区別できるようにしてあります。
- **`terse` の 4 語は私が書きました。** 段階の意味は state 側に
  full 形式の 4 文をそのまま置いてあるので情報は落ちていないつもりですが、
  「4 語が最短か」は測っていません。
  答えは平均 0.057 動いていて、**0 ではありません**。
- **繰り返しは 1 回**です。§7 の「平均差 0.057」が
  同じ質問を 2 回聞いたときのばらつきより大きいかは測っていません
  ([25](25-thresholds.md) の `drawNoise` に通すべきもの)。
- **前段の recall 天井 85% は語彙の問題**で、
  埋めるには別の前段(埋め込み、あるいは狭い fanout)が要ります。
  この報告はそれを測っていません。
- **費用**: 全 arm で 13,748 判断 / 98 リクエスト / 2,562,763 入力トークン /
  **$0.1076**。§1 の梯子(`--ceiling`)は別に 10 リクエストです。

---

## 次に試すこと

- **前段を判断にする。** §2 の天井 85% は語彙が共有されていないせいなので、
  前段自身を狭い fanout(名前 + 第 1 文だけ、`terse` 形式)にすると
  どうなるか。1 問 40 トークンなら 461 問が 18,400 トークンで入ります。
  **無料ではなくなりますが、天井は語彙の問題ではなくなります。**
- **prior をロスターと一緒に配る。** §6 の補正は
  「参照プロジェクト群での平均」1 列で済みます。
  参照が何件あれば安定するか(14 件で足りているか)を測る。
- **curate されていないロスターの扱い。** §5 が言っているのは
  「curation は取り返せない」ですが、
  **curation を判断で作れるか**は別の問い ——
  「この skill はどのリポジトリにも当てはまるか」を 1 問聞けば
  §6 の prior を API 1 回で出せるはずです。それが当たるなら、
  新しいロスターに prior を配る前でも補正が効きます。
- **[31] に向けて**: TODO の 5 番
  ([multi-agent-orchestration](https://github.com/mizchi/skills/tree/main/multi-agent-orchestration)
  のパターン選択)は、選択肢が 5〜8 個で相互排他なので
  `choice` です。ここまでの `score` の fan-out とは形が違います。
