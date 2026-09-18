# 29. コンテキストに入らない skill カタログから選ぶ

[mizchi/skills](https://github.com/mizchi/skills) の
`skill-selector/references/catalog.md` —— 実物の、人が手で選別した
**98 行 / 23 セクションのカタログ**を相手にしました。
各セクションは発火すべき**シグナル**を宣言し、各行は
どれだけ積極的に提案するかの**ティア**を持っています。

ラベルはカタログ自身のティア凡例です。私が決めたものは 1 つもありません:

| ティア | カタログの文言 | 本文でのラベル |
| --- | --- | --- |
| **T0** | Always want. 規模やシグナルに関係なく提案する | `want`(全プロジェクト) |
| **T1** | Applicable. セクションのシグナルが在るとき提案する | シグナル在り → `want` |
| **T2** | Instructed. 明示的に頼まれたときだけ | 依頼在り → `want` |
| **T3** | Occasionally effective. 散文で触れる、既定の提案には入れない | `mention`(正例でも負例でもない) |
| **T4** | Superseded. 代替を挙げる | 常に `no` |

判断に渡すのは**プロジェクト側だけ**です ——
ファイルツリー、`CLAUDE.md` の行、依頼 1 段落。
セクション名もティアもシグナル行も payload に入らないことを
`test.ts` が両方向で検査しています(§正直な限界)。

skill 側は**その skill 自身の `description:`** —— ハーネスが実際に
持っている文字列です。75 行ぶんで 22,583 文字 ≈ **9,410 トークン**。

再現:

```bash
cd experiments/skill-select && npm install
npm test                       # 28 件、API 不要(ラベル規則とラベル漏れの検査)
npm run demo                   # 記録から全部の表、API 不要
npx tsx src/run.ts --arm fanout    # 14 リクエスト・74 問ずつで $0.012
npx tsx src/extract.ts /home/user  # カタログ更新時だけ。corpus/skills.json を作り直す
```

---

## 結論(先に)

**1. ファン・アウトの幅は無料。それも「安い」ではなく「同じ答え」。**
74 問を 1 リクエストに入れた場合と、1 問 1 リクエストで 1,036 回投げた場合で、
**答えは 99.8% が 0.25 以内・平均差 0.032**。
コストは 1 プロジェクトあたり 21,203 対 51,295 トークン、
リクエスト数は 14 対 1,036。**幅を狭めて得るものは何も無い。**

**2. ただし skill を state に移すと落ちる。** 同じ幅 1 で、
skill を質問に置いたまま(`solo`)なら AP 0.53 で答えも一致するのに、
state に移す(`single`)と AP 0.46、一致は 53% まで落ちる。
**幅ではなく置き場所が効く。**

**3. カタログのティア列が一番効く。** T0 の 2 行は
「常に提案」という**方針**で、skill の description のどこにも
そんなことは書いていない。方針をコードに置くだけで
AP 0.41 → **0.70**。判断に聞いた場合の平均順位は 74 件中 41〜53 位。

**4. ラベルを何が決めるかで、勝つ selector が変わる。**
正例 135 件を分解すると `policy` 28・`files` 77・`ask` 30。
**依頼文だけが決める 30 件**では判断が平均 6.7 位、
語彙の重なりは 29.0 位。**ファイル名が決める 77 件**では逆に
重なりが 20.8 位で判断は 27.7〜31.3 位。

**5. 全プロジェクト共通の閾値は無い。** AUC 0.668、gap −2.92。
`youden` をプロジェクトでホールドアウトすると precision 49% / recall 37%。
**プロジェクトごとに上位 k を取る形でしか使えない。**

**6. 人が書いた 1 行の `Use when` は、skill 自身の description より良い。**
AP 0.53 → 0.56、最悪順位 42.2 → 37.6。しかも文字数は
22,168 対 **7,311** —— 3 分の 1 です。

---

## 1. 何を測ったか

14 プロジェクト × 74 skill = **1,036 判断**が 1 arm ぶん。
正例(`want`)は 135 件で 13%。

| プロジェクト | want | mention | 何が在るか |
| --- | --- | --- | --- |
| ts-cf-e2e | 14 | 2 | Node / Cloudflare / Playwright / GH Actions |
| moonbit-lib | 7 | 1 | MoonBit / justfile / GH Actions |
| d1-worker | 16 | 2 | Node / Cloudflare / sqlc カタログ |
| frontend-review | 24 | 0 | Node / Playwright / CI + レビューパスの依頼 |
| aws-ecs | 5 | 3 | AWS / CI / CHANGELOG |
| gleam-api | 4 | 1 | Gleam / devbox |
| flaky-suite | 11 | 0 | Node / CI + フレーキー運用の依頼 |
| dup-hunt | 13 | 0 | Node / sgconfig.yml + 重複検出の依頼 |
| article-draft | 4 | 0 | コード無し + 記事公開の依頼 |
| k8s-crd | 7 | 1 | Node / k8s / zod |
| dep-audit | 9 | 1 | Node / CI / pnpm outdated |
| formal-config | 8 | 0 | Node + TLA+ / Z3 の依頼 |
| act-local | 11 | 0 | Node / CI / actrun.toml + ローカル実行の依頼 |
| bare-repo | 2 | 0 | **何も無い**(負の対照) |

`bare-repo` が正例 2 件だけなのは、T0 の 2 行がそこにしか残らないからです。
負の対照が「常に提案」だけを欲しがるのは、ティア凡例の直接の帰結です。

### 無料の基準線

IDF 重み付きの語彙の重なり(skill 名 + description 対 プロジェクトの文字列)。
IDF は候補 description 群の上で計算するので、
全 skill が使う語("skill", "covers")は 0 点、`wrangler` は高得点になります。

```
mean AP 0.42, mean P@k 0.38, mean worst-positive rank 53.1 of 74
without the two always-on skills: AP 0.44, P@k 0.40, worst 41.1
skills the overlap cannot separate at all (score 0): 17-65 per project
```

同点が多いのが弱点で、プロジェクトによって **17〜65 件が 0 点**です。
`metrics.ts` は同点を必ず selector に不利な向き(正例を後ろ)に割るので、
この 0 点の塊は得点になりません。

そして重なりが構造的に間違えるものが 1 つ:
`justfile` という**名前の skill** は `justfile` を持つリポジトリと
完全一致するので `moonbit-lib` で **74 件中 7 位**に来ますが、
カタログの答えは `mention`(T3、「既存リポジトリは尊重、新規は pkfire」)です。

---

## 2. 7 つの arm

AP / P@k / 最悪順位を、まず全 1,036 対で、次に **T0 の 2 行を落として**。
落とした側が「判断が当たり得る部分」です(§3)。

```
arm       width  AP     P@k    worst  | AP-    P@k-   worst-  | reqs  tok/proj  ms/req  $
rules     -      0.42   0.38   53.1   | 0.44   0.40   41.1    | 0     0         0       $0.0000
fanout    all    0.41   0.31   56.6   | 0.55   0.47   45.7    | 14    20019     449     $0.0118
applies   all    0.39   0.34   62.9   | 0.53   0.43   42.2    | 14    21203     588     $0.0125
batch10   10     0.39   0.34   63.1   | 0.53   0.43   41.4    | 112   24089     203     $0.0142
solo      1      0.39   0.34   63.1   | 0.53   0.43   42.2    | 1036  51295     180     $0.0302
single    1      0.35   0.33   57.4   | 0.46   0.43   42.1    | 1036  50851     172     $0.0299
usewhen   all    0.42   0.33   54.3   | 0.56   0.51   37.6    | 14    17280     488     $0.0102
noul      all    0.40   0.33   69.8   | 0.54   0.48   44.5    | 14    17133     317     $0.0101
```

| arm | 何を変えたか |
| --- | --- |
| `fanout` | 1 プロジェクト 1 リクエスト、skill ごとに `score` 1 問。質問は「**いま必要か**」 |
| `applies` | 同じ幅で、質問を「**このリポジトリのスタックが対象か**」に。カタログが提案する高度 |
| `batch10` | `applies` を 10 問ずつに割る。state を 8 回払う |
| `solo` | `applies` を 1 問ずつ。skill は質問に残す |
| `single` | 同じ幅 1 で、skill を **state** に移す |
| `usewhen` | `applies` だが、質問が運ぶのはカタログの `Use when` 列 |
| `noul` | `applies` の 4 段階を yes/no に |

`solo` と `single` の対が、幅と置き場所を分離します。

---

## 3. 方針は判断に聞くものではない

T0 は 2 行 —— `pkfire` と `apm-usage` —— で、全 14 プロジェクトで `want`。
つまり **135 件の正例のうち 28 件(21%)が方針**です。
そして skill 自身の description には「常に入れる」と書いていないので、
description しか見ない selector には原理的に置けません。

実測でも置けていません。§5 の平均順位で、T0 の正例は
`fanout` 41.5 位・`applies` 50.9 位・`noul` 53.3 位(74 件中)。
重なりが 21.3 位でやや良いのは信号ではなく偶然で、
`apm-usage` の description に含まれる "manager" や "yml"、
`pkfire` の "Taskfile.pkl" が**どのリポジトリのファイル名とも薄く当たる**からです
(`ts-cf-e2e` で 10 位 / 12 位、当たった語は `yml` と `package`)。
何も無い `bare-repo` では両方 0 点で、18 位と 67 位に散ります。

だから本文の表は全部 2 本立てにしてあります。`AP` は課題そのまま、
`AP-` は T0 を落としたもの。**`AP-` のほうだけが selector の話**です。
落とすと `fanout` は 0.41 → 0.55 に上がり、基準線 0.44 を初めて超えます。

---

## 4. ファン・アウトの幅は無料(答えが同じ)

同じ質問・同じ state を、1 リクエストあたり 74 問 / 10 問 / 1 問で投げました。

```
applies   74 q/request     AP- 0.53  14    requests  296845  input tokens
batch10   10 q/request     AP- 0.53  112   requests  337242  input tokens
solo      1 q/request      AP- 0.53  1036  requests  718128  input tokens
single    1 q/request      AP- 0.46  1036  requests  711912  input tokens
```

指標は同じ。ここで見るべきは指標ではなく**答えそのものが動いたか**です:

```
every pair against the widest arm (applies, 74 questions in one request):
arm       n      same level  within 0.25  mean |diff|
applies   1036   100%        100%         0.000
batch10   1036   96%         100%         0.030
solo      1036   97%         100%         0.032
single    1036   67%         53%          0.287
```

**74 問を 1 リクエストに詰めた答えは、1 問ずつ 1,036 回聞いた答えと
0.25 以内で 99.8% 一致します。** レベル(0〜3 の丸め)でも 97%。
[21 §5](21-eslint-plugin-jev.md#5-バッチはほぼ無料--これがこのプラグインの成立条件)は
バッチが**値段として**ほぼ無料であることを測りました。ここで足せるのは
**答えが動かない**ことと、幅を狭めると逆に損をすることです。
入力トークンは 296,845 対 718,128 —— **幅を狭めると 2.4 倍払って同じ答え**。

これが「コンテキストに入らない skill から選ぶ」への直接の答えです。
カタログを state に入れる必要はありません。**質問にすればよい。**
state は 1 回ぶんしか払わず、n 個の description は質問側に乗ります。

そして `single` が唯一落ちた arm です。幅は `solo` と同じ 1 で、
違いは skill が state にあるか質問にあるかだけ。**53% しか一致しません。**
[21 §6](21-eslint-plugin-jev.md#6-ファイルの文脈は精度を上げない下げる)・
[28 §4](28-bilingual.md#4-文書全体を渡すと悪くなるそして機構が見える)の
「state に物を足すと判断が甘くなる」と同じ向きですが、
ここでは足しているのではなく**移している**だけです。
判断対象は state ではなく質問に置く —— それがこの repo で 3 度目の確認です。

---

## 5. ラベルを何が決めるかで、勝つ selector が変わる

ラベル規則は 1 つではなく 3 つで、証拠の出どころが違います。
分解はカタログ側だけで機械的にできます(`route.ts`):

| | 何が決めるか | 件数 |
| --- | --- | --- |
| `policy` | T0 行。プロジェクトの何も決めない | 28 |
| `files` | シグナル行が**ファイル名を挙げている**セクションの T1 行 | 77 |
| `ask` | T2 行、またはシグナルが**活動**であるセクションの T1 行 | 30 |

正例の平均順位(74 件中、小さいほど良い):

```
arm       policy    files     ask
rules     21.3      20.8      29.0
fanout    41.5      31.3      6.7
applies   50.9      27.7      12.4
batch10   51.0      27.6      12.3
solo      50.8      27.8      12.4
single    44.8      29.4      14.4
usewhen   37.8      26.0      11.6
noul      53.3      28.1      13.7
```

**依頼文だけが決める 30 件で、判断は 6.7 位 対 29.0 位。**
`wrangler.toml` が在るかは grep が答えるもので、
「フレーキーテストの運用を継続的にやりたい」が
どのセクションの活動かは grep が答えないものです。

そして質問の高度がここで効きます。`ask` の正例は
「**いま必要か**」(`fanout`、6.7 位)のほうが
「**対象領域か**」(`applies`、12.4 位)より良く、
`files` の正例は逆に `applies`(27.7 位)のほうが `fanout`(31.3 位)より良い。
**質問の高度を、証拠の出どころに合わせる。**

---

## 6. 重みを当てるな、経路を書け

§5 が示す通り grep と判断は別のところで勝つので、混ぜたくなります。
両者をプロジェクト内の**順位**に正規化して 1 つの重み α で混ぜ、
α をプロジェクト単位でホールドアウトして当てました:

```
best in sample: alpha 0.80, AP 0.42
held out: AP 0.35 against 0.42 for the grep alone and 0.41 for the judgment alone
the fitted weight moved between 0.00 and 1.00 across the folds
```

**ホールドアウトすると両方より悪い。** 当てた重みは fold 間で
0.00 から 1.00 まで振れます —— プロジェクトごとの最適が両端に割れていて、
14 プロジェクトでは平均が意味を持ちません。
docs/25 が閾値について測ったこと(手で合わせた数字は楽観的で、
ホールドアウトすると動く)が、混合重みでもそのまま起きます。

当てるのをやめて**経路**にすると話が変わります。経路はカタログだけで決まり、
プロジェクトを見る前に —— ツールを書く時点で —— 確定します:

```
routed: T0 は方針で先頭、ファイル名シグナルの T1 は grep、残りは判断
the routing sends 24 skills to grep, 2 skills to policy, 48 skills to judgment

mean AP: grep 0.42, judgment 0.41, fitted blend (held out) 0.35, routed 0.70
routed P@k 0.63 against 0.38 and 0.31; worst-positive rank 38.8 against 53.1 and 56.6
```

ただし正直に分けると、この跳ね上がりは**ほぼ全部ティア列**です:

```
with the two policy rows dropped -- the same positives the arms were scored on --
routed AP 0.53, P@k 0.47, worst 39.4; the grep alone gets 0.44 and the judgment 0.55
```

T0 の 2 行を落とすと routed は 0.53 で、**判断だけの 0.55 に届きません**。
つまり `files` を grep に回す部分は元が取れていない。§5 で grep は
平均順位では勝っていましたが、同点の塊が正例と負例を同じ位置に置くので
precision にはならないのです。

**残るのは 1 行**: ティア列をコードで適用する。
それが AP 0.41 → 0.70 のほぼ全部で、リクエストは 1 本も増えません。

---

## 7. どこでカタログと食い違うか

`youden` の 2.11(実際に選ぶ動作点)で切ると、`applies` は
正例 83 件を落とし、負例 53 件を上げます。skill 別に畳むと系統が見えます。

落としたほう(83 件):

```
pkfire                      T0     14 project(s) mean 0.13
apm-usage                   T0     14 project(s) mean 0.36
node-sqlite-vec             T1      9 project(s) mean 0.14
pi-coding-agent             T1      9 project(s) mean 0.28
dotenvx                     T1      9 project(s) mean 0.43
opentelemetry               T1      9 project(s) mean 0.80
otel-node                   T1      9 project(s) mean 0.71
   ... 残り 10 件は 1〜2 プロジェクトずつ
```

28 件は T0(§3)。45 件は **Node / TypeScript セクションの T1 5 行 × 9 プロジェクト**。
ここが一番読む価値のある食い違いです。ティア凡例は
「セクションのシグナルが在るなら提案」なので、`package.json` が在れば
5 行全部が `want` になります。しかし各行の `Use when` は
「Node 24+ の `node:sqlite` と `sqlite-vec` を使う」のように**もっと細い**。

**モデルは `Use when` のほうを読んでいて、そちらが正しい。**
最も分かりやすいのが `dup-hunt`(TypeScript の monorepo で重複検出を依頼):

| skill | `fanout` | `applies` | `usewhen` |
| --- | --- | --- | --- |
| check-similarity | 3.00 | 2.86 | 2.81 |
| check-similarity-**ts** | 3.00 | 2.93 | 2.84 |
| check-similarity-mbt | 0.48 | 0.40 | 0.23 |
| check-similarity-py | 0.40 | 0.38 | 0.37 |
| check-similarity-rs | 0.30 | 0.27 | 0.36 |

5 つは同じセクションの T2 行で、依頼が在るのでラベルは全部 `want`。
モデルは**言語の合う 2 つだけを採って 3 つを捨てました**。
`-mbt` / `-py` / `-rs` が「落とした 83 件」に入っているのは
**ラベルが粗いから**で、モデルの誤りではありません。同じ形が他に:

| 対 | 値 | 読んだ結果 |
| --- | --- | --- |
| `moonbit-lib` / ts2moonbit-migration | 1.87 | TS からの移植の skill。このプロジェクトは移植していない |
| `moonbit-lib` / nix-setup | 0.93 | devbox / flake の skill。在るのは `justfile` だけ |
| `d1-worker` / workers-cd-rollback | 1.94 | GH Actions のパイプラインが前提。`.github/` が無い |
| `d1-worker` / sqlc-gen-moonbit-safety | 0.83 | `sqlc-gen-moonbit` 前提。ここは TypeScript |
| `flaky-suite` / flaker-management | 1.63 | 「導入**後**の運用」。このプロジェクトは導入前 |

上げたほう(53 件)は T1 が 26・T2 が 27 で、
T2 側は「適用できる」と「頼まれた」の区別です:

```
dep-lib-review          T1   8 project(s) mean 2.82
actrun                  T2   6 project(s) mean 2.79
conventional-changelog  T1   6 project(s) mean 2.56
security-expert         T2   5 project(s) mean 2.62
frontend-ops-expert     T2   4 project(s) mean 2.45
```

`.github/workflows/` が在るリポジトリは全部
「ローカルで Actions を回す skill が対象領域だ」と答えます。
カタログの T2 は「頼まれたときだけ」なので不一致です。
`fanout` の高度(いま必要か)でも同じで、その arm 自身の balanced 最適
(1.46)で切ると偽陽性 62 件の内訳が T1 27・T2 33 ——
**どちらの高度も T2 の線を引けていません。**

---

## 8. 全プロジェクト共通の閾値は無い

```
1025 pairs, 135 of them want
want 1.36 +/- 1.20, no 0.64 +/- 0.70
AUC 0.668, gap -2.92, verdict: overlapping

placement              at     in-sample                    held out by project
auto+0.05              3.00   tp 2 fp 0 fn 133 P 100% R 1%  tp 11 fp 1 fn 124 P 92% R 8%
boundary+0.05          3.00   tp 2 fp 0 fn 133 P 100% R 1%  tp 11 fp 1 fn 124 P 92% R 8%
midgap                   -    (fit できない)
youden                 2.11   tp 52 fp 53 fn 83 P 50% R 39% tp 50 fp 53 fn 85 P 49% R 37%
q90+0.00               1.74   tp 54 fp 90 fn 81 P 38% R 40% tp 54 fp 92 fn 81 P 37% R 40%
```

ホールドアウトは**プロジェクト単位**です。4 プロジェクトの対で切り、
5 番目で採点する —— まだ見ていないリポジトリで使える唯一の数字だからです。

`auto` は最大負例の上に落ちるので precision 92% / recall 8%、
`youden` は balanced を取って precision 49% / recall 37%。
in-sample とホールドアウトの差は小さいので、
**これは fit の楽観ではなく、そもそも分離していない**のです。

だから使い方は閾値ではありません。**プロジェクトごとに上位 k を取る。**
`usewhen` の P@k が 0.51 —— 正解の件数だけ上から取れば半分が当たり、
最悪順位は 37.6 位。カタログの提案を人が引き算する運用
(`skill-selector` SKILL.md のステップ 3)と形が合っています。

---

## 9. 人の 1 行は skill 自身の description より良い

`usewhen` は質問が運ぶ文字列だけを差し替えた arm です ——
skill の `description:` ではなく、カタログの `Use when` 列。

```
mean AP 0.53 -> 0.56; mean worst rank 42.2 -> 37.6
the two texts are 22168 chars (own) against 7311 chars (curated)
```

P@k は 0.43 → **0.51**。トークンは 21,203 → **17,280**。
**3 分の 1 の文字数で、選択には少し良い。**

理由は形が違うからです。skill の `description:` は
**発火条件**を書くもので、"Use when the user asks to deploy" のように
会話の中の合図を狙っています。カタログの `Use when` は
**どのプロジェクトに要るか**を書いたもので、
"Deploying to Cloudflare Workers / Pages — wrangler commands, secrets" のように
プロジェクトの属性で書かれています。選択に必要なのは後者です。

プロジェクト別に見ると一方向ではありません:
`article-draft` が +0.25、`moonbit-lib` が +0.13 で、
`dup-hunt` が −0.12、`ts-cf-e2e` が −0.09。
差が測れる 13 プロジェクトで **8 勝 4 敗 1 分** ——
**平均では良いが、13 件ぶんの自信しかありません**
(`bare-repo` は T0 以外に正例が無いので AP が出ません)。

---

## `skill-selector` に返せること

測って言えることだけ:

1. **T0 はコードに置く。** カタログのティア列を適用するだけで
   AP 0.41 → 0.70。判断には聞かない ——
   description に「常に入れる」とは書けないから(§3)。
2. **`Use when` を 1 行維持する価値がある。** skill 自身の description より
   選択には良く、トークンは 3 分の 1(§9)。
   逆に言えば、カタログ行を消して description だけにすると悪くなります。
3. **セクション単位の T1 提案は粗い。** `check-similarity-*` の
   言語別 5 行がその証拠で、判断は正しい 2 つを採ります(§7)。
   「提案して引き算させる」のうち**引き算のほうが判断の仕事**です。
4. **候補を state に積まない。質問にする。** 74 問 1 リクエストは
   1 問 1 リクエスト 1,036 回と答えが 99.8% 一致し、コストは 2.4 分の 1(§4)。
   `skill-finder` が想定する「カタログに載っていない広い探索」でも同じ形が使えます。
5. **閾値は作らない。** 共通の切り方は存在しない(AUC 0.668)ので、
   プロジェクトごとに上位 k を出して人に引かせる(§8)。
6. **質問の高度を証拠に合わせる。** ファイルで決まる行には
   「対象領域か」、依頼で決まる行には「いま必要か」(§5)。

---

## 10. 追記 —— 閾値ではなくパイプラインを当てはめる

[37 §9](37-hermes.md#9-正直な限界) の宿題。[§8](#8-全プロジェクト共通の閾値は無い) は
**閾値を単体で**当てはめて「共通の閾値は無い、プロジェクトごとに上位 k」と結んだ。
[`jev-skill-router`](../packages/jev-skill-router/) はその上位 k を
`maxLoad` として出荷しているので、**閾値と cap を一緒に**当てはめ直しました。

```bash
cd experiments/skill-select && npm run fit    # API 不要
```

§8 との違いは 3 つあります。

| | §8 | §10 |
| --- | --- | --- |
| 対 | 1,025(`mention` 11 件を除外) | 1,008(**T0 の 28 件**を除外、`mention` は負例) |
| 当てはめる対象 | 閾値単体 | 出荷している `selectFrom`(閾値 × cap) |
| AUC | 0.668 | **0.746** |

### 10.1 T0 を外す —— 判断していないものを採点していた

カタログの T0 は**ラベル規則が全プロジェクトで `want`** にする段です。
そして skill router の `split()` は T0 を `always` に振り分けて
**質問せずに読み込む**([§5](#5-ラベルを何が決めるかで勝つ-selector-が変わる) の無料の前段)。

つまり 135 の正例のうち **14 × 2 = 28 件は、判断が一度も聞かれていない**。
外すと AUC は 0.693 → **0.746**、0.5 未満に沈む正例は 74 → 47 件になります。

> **これは自分の採点コードのバグでした。** §4 で「hatch が必要なプロジェクトは
> 0 件」と出したあと、`bare-repo`(最大スコア 0.77、閾値を超えるものが 0 件)が
> **2 件を want にしている**のに気づいて調べたら、
> 両方 T0 —— つまり `always` バケツでした。

### 10.2 分布 —— recall の上限は質問の側にある

```
  score band   want   mention    no
  0.0-0.5        47         4   700
  0.5-1.5        10         4   132
  1.5-2.5        14         1    49
  2.5-3.0        36         2     9
```

**107 の正例のうち 47 件(44%)が 0.5 未満。** 上の帯では 36 対 9 で当たるので、
**スコアが高いときは正しく、正しいものの多くはスコアが高くならない**。
これは閾値では動きません —— [§8](#8-全プロジェクト共通の閾値は無い) の
「そもそも分離していない」を分布で見た形です。

### 10.3 出荷しているパイプラインを格子で

```
  loadAt   cap   loaded/project   precision   recall   wanted-and-missed/project
     1.5     1             0.93       0.846    0.103                        6.86
     1.5     3             2.57       0.750    0.252                        5.71
     1.5    10             6.00       0.500    0.393                        4.64
     2.0     3             2.50       0.771    0.252                        5.71
     2.5     1             0.93       0.846    0.103                        6.86
     2.5     3             2.29       0.844    0.252                        5.71
     2.5     5             2.86       0.750    0.280                        5.50
     2.5    10             3.21       0.778    0.327                        5.14
     2.8     3             2.07       0.828    0.224                        5.93
```

ホールドアウトはプロジェクト単位(§8 と同じ)。

**出荷している 2.5 / cap 3 が格子の最良**です —— precision 0.844。
同じ cap で 2.0 は 0.771、1.5 は 0.750。
cap を上げると recall が上がり precision が下がるのは
[30 §5](30-skill-pick.md) の再現です。
**cap 1 ではどの閾値も同じ答え**になる —— そこでは cap だけが決めている。

### 10.4 単体で当てはめると逆を向く

```
  cutoff   source                               loaded/project   precision   recall
    2.50   出荷(レベル 2 と 3 のあいだ)                   2.29       0.844    0.252
    1.39   youden、閾値を単体で当てはめた                   2.57       0.750    0.252
```

**recall は同じ 0.252 のまま、precision が 0.844 → 0.750。厳密に悪化します。**

理由は cap です。**cap 3 が既に効いているので、閾値を下げても
「欲しい skill」が増えることはなく、同じ 3 席に要らないものが増えるだけ。**
どれが入るかを決めるのは順位で、閾値が決めるのは**何が候補になるか**だけ。

そして厄介なのは、**単体の数字はそうと言わない**ことです ——
閾値単体の held-out balanced accuracy は
1.39(0.686)が 2.50(0.662)に**勝つ**と言います。
プロジェクト単位で交差検証した本物の数字で、それが逆を向く。

> **部品ではなくコードがやることを当てはめる。**
> [25](25-thresholds.md) は閾値を当てはめる道具の話で、
> [31 §8](31-orchestration.md#8-追記--閾値を-framing-ごとに当てはめる追加リクエスト-0) は
> 「質問の書き方が変われば閾値も変わる」でした。
> ここは 3 つ目の形 —— **閾値の後ろにもう 1 つ決定があるなら、
> 閾値だけを最適化した数字は信じられない。**

### 10.5 `noneAt` は当てはめられない(1 件しかない)

```
  projects whose correct `none_apply` answer is TRUE: 1 of 14  (bare-repo)

  the free substitute ("no skill cleared 2.5") fires on: bare-repo
  It agrees with the label on every project.
```

判断した skill の中に `want` が 1 件も無いプロジェクトは
**`bare-repo` だけ**(「まだ何も決まっていないリポジトリ」)。
**正例 1 件で閾値は置けません** ——
[36 §5](36-routers.md) が 53 件中 1 件でレポート 1 本書いたのと同じ形です。

そして**無料の代用がその 1 件を当てます**:
「閾値を超えた skill が 0 件」は同じ結論で、質問は 1 つも要りません。
[33 §1](33-review.md) の「無料の指標を先に測る」が 3 つ目の場所で出ました。

だから `noneAt` は既定のまま、**未当てはめと書いてあります**。
逃げ道の**形**は [17 §3](17-task-picker.md#3-逃げ道は選択肢ではなく別の問いにする) が
測った(18/18 対 16/18)ので残しますが、
**このカタログでは値段に見合っていない**。
決着させるには「どの skill も当てはまらない文脈」が何件か要ります。

---

## 正直な限界

- **プロジェクトは私が書いた合成です。** ファイルツリーと依頼文は
  セクションの宣言シグナルを実物のリポジトリらしく具体化したもので、
  ラベルはそのシグナル集合とティアから機械的に出ています。
  漏れの検査は両方向で入れてあります ——
  プロジェクト文が skill 名を含まないこと(例外は `justfile` と `actrun`
  の 2 語で、どちらもカタログが**シグナルとして宣言している**)、
  見出しパス・ティア・`Signals` 行が payload に入らないこと。
  それでも「実在の 14 リポジトリで測った」ではありません。
- **74 skill は 98 行のうち 75 行から。** 残り 23 行は
  `mizchi/mnemo` と `mizchi/security-review` が非公開、
  MoonBit 生態系の単独行と `(out-of-band)` の 1 行が読めないためです。
  結果として **Memory / session と Security review のセクションが 0 行**になり、
  T2 の難しい混同(3 つのセキュリティ系 skill の撃ち分け)が 1 つ減っています。
- **シグナルを宣言しないセクションが 5 つあります**(Reliability / Flakiness,
  Skill authoring, dotfiles, Writing, Migration)。
  「シグナルが在るとき提案」を字義通り読むと永久に発火しないので、
  それらの T1 行は**依頼がそのセクションの活動を名指したときだけ** `want`
  としました。**これが本文で唯一の解釈**で、`projects.ts` の冒頭に書いてあります。
  別の読み(セクション無条件で `want`)を採ると `flaky-suite` の正例が
  11 件から 8 件に減り、`ask` の分解が薄くなります。
- **`mention`(T3、10 skill)は正例でも負例でもない。** 順位指標から外し、
  §7 の末尾に 11 対を並べるだけにしています。
  `moonbit-lib/justfile` 2.99・`k8s-crd/k8s-crd-from-typed-schema` 3.00・
  `dep-audit/tech-trend-watch` 2.29 が動作点より上 ——
  T3 を「提案に入れない」と判断させるには、
  ティアと同じくコード側の情報が必要です。
- **繰り返しは 1 回**です。同じ (プロジェクト, skill) を複数回引いた
  ばらつき(draw noise)は測っていないので、
  §4 の `youden` 2.11 のような数字にどれだけ余裕があるかは分かりません。
  `--repeat 3` で取れますが、この報告の数字は 1 回ぶんです。
- **routed selector はカタログのティア列を読みます。** arm は
  description しか見ていないので、§6 の 0.70 と arm の 0.41 は
  **情報量が違う比較**です。同じ正例で比べた 0.53 対 0.55 も併記してあります。
- **費用**: 全 arm で 7,252 判断 / 2,240 リクエスト / 2,826,184 入力トークン /
  **$0.1187**。うち幅 1 の 2 arm が 1,430,040 トークン(51%)です。

---

## 次に試すこと

- **コンテキストに入らない規模で測る。** 74 skill・9,410 トークンは
  32Ki の state にも 64Ki のリクエストにも入ります。
  1,000 skill だと description は 12 万トークンで**質問側も入りません**。
  そのときの形は 2 段 —— 安い前段で候補を削り、後段で聞く ——
  で、前段に何を使うか(語彙の重なり? `Use when` だけの狭い fanout?)は
  測れば決まります。これが TODO の
  「評価ループを回して常用できるまで改善する」の中身です。
- **実在のリポジトリで。** このリポジトリ自身、`mizchi/skills` 自身、
  `mizchi/similarity` などを入力にすれば
  「私が書いた合成」の限界が 1 つ消えます。
  ラベルは mizchi 本人の `apm.yml` が答えになります。
- **`mention` と `on_request` をコード側に。** §7 の残差はほぼ
  T0・T3・T2 の 3 つの方針で、どれも description に無い情報です。
  ティア列を渡した上で判断に**引き算だけ**させる arm を測る。
- **draw noise。** `--repeat 3` で (プロジェクト, skill) 単位の
  ばらつきを取り、docs/25 の `drawNoise` に通す。
  幅 74 と幅 1 で**ばらつきの大きさが違うか**は、
  ここで測った平均差 0.032 とは別の問いです。
