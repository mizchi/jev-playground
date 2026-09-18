# 26. 実リポジトリで jev/rule を走らせる — 散文の規約を 9,315 行に当てる

[24](24-adhoc-rules.md) は「セレクタだけコードで書き、述語は 1 文」が成立することを
**641 行のラベル付きコーパス**で示して、限界をそのまま残していた ——
**実リポジトリでは走らせていない。**

ここがその実行です。対象は**このリポジトリ自身の JavaScript 9,315 行**(24 のコーパスの 14.5 倍)。
ルールは 3 系統で、どこから来た文かが実験の本体です:

| 系統 | 何か | なぜ |
| --- | --- | --- |
| **reused** | [24](24-adhoc-rules.md) の 5 文のうち 3 文を**そのまま** | 同じ問いを新しいコードに当てる。gap が移動に耐えるかどうか |
| **prose** | このリポジトリが `docs/` にだけ書いている規約 | どの linter にも無く、AST で書くと 1 週間かかる類 |
| **probe** | **すでに守れている**規約 | 実コードにラベルは無い。ここでの指摘は**定義上すべて誤検出**で、これが手に入る唯一の正解 |

> reused の 3 文が本当に逐語であることは
> [`experiment/test.mjs`](../experiments/eslint-plugin-jev/experiment/test.mjs) が検査しています
> (`no-swallowed-catch` は文と閾値が逐語で、note だけ §5 で書き直した)。

再現:

```bash
# 記録から全部の表を出し直す(API 不要)
R=experiments/eslint-plugin-jev/experiment
node $R/rules-report.mjs --cache $R/out-repo-rules.json  --rules eslint.rules.mjs
node $R/rules-report.mjs --cache $R/out-repo-drafts.json --rules $R/repo-drafts.mjs
node $R/rules-report.mjs --cache $R/out-repo-corpus.json --rules $R/repo-drafts.mjs

# 実物の lint。記録を引くだけなので API も要らない
experiments/eslint-plugin-jev/node_modules/.bin/eslint .

# 聞き直す(要 API・$0.012)。--dry-run は件数と設定の検査だけ
node experiments/eslint-plugin-jev/src/warm.mjs \
  "hooks/**/*.mjs" "jevlang-js/**/*.mjs" \
  "experiments/eslint-plugin-jev/src/*.mjs" "experiments/eslint-plugin-jev/experiment/*.mjs" \
  --config eslint.config.mjs --only rules --cache $R/out-repo-rules.json --dry-run
```

ルールは [`eslint.rules.mjs`](../eslint.rules.mjs)、設定は [`eslint.config.mjs`](../eslint.config.mjs)。
どちらもリポジトリのルートにある**実物**で、`npx eslint` がそのまま読みます。

---

## 結論(先に)

**1. 579 判定が 19 指摘になり、直したのは 2 件。** 残り 17 件はほぼ全部
**意図的にそうしてあるコード**でした。[24](24-adhoc-rules.md) のコーパスには
「その形をわざとやっている版」が 1 つも入っていなかったので、文は知りようがなかった。

**2. 自信のある指摘が全部外れ、当たった 2 件はどちらも「質問」として出た。**
confidence ≥ 0.5 の 5 件は 0/5、当たった 2 件は **conf 0.29 と 0.19**。
[24](24-adhoc-rules.md) の「自信のある 5 件は 5/5 正解」と正反対で、理由は
**confidence が「文が literal に当てはまるか」の確信であって「直すべきか」の確信ではない**から。

**3. level 0 は実コードで本当に効く。** わざと広くした `TemplateLiteral` の
**422 件中 398 件(94%)が「このルールは当てはまらない」**に落ちた。
[24 §4](24-adhoc-rules.md#4-セレクタはわざと広く書くのが正しい) の「広く書け」は実測で裏付けられた ——
ただし**タダではない**。その 1 ルールが実行全体のトークンの 74% を使って、指摘は 0 件。

**4. gap だけでは足りない。band(答えがどのレベルに居るか)が要る。**
狭い gap が 3 ルールで出て、**2 つは「違反が無い」・1 つは「文が働いていない」**だった。
同じ数字が反対の意味になるので、[report ツールに band を足した](#4-gap-の隣に-band-を置いた)。

**5. 文でも subject でも直らない判断がある。** `no-swallowed-catch` を 3 通り
(note を書き直す / subject を catch 節から囲む関数に広げる)測ったが、
**ラベル付きコーパスで「意図的な catch」が「本物のバグ」を上回る順位は 3 通りとも変わらなかった**。
必要な情報(呼び出し元が失敗を判別すべきか)が**コードのどこにも書いていない**。

費用の合計は **$0.038**(6 回の warm)。一番大きい 1 回が **579 判定・2.9 秒・$0.0135**。

---

## 0. 何に当てたか

| | |
| --- | --- |
| 対象 | `hooks/` `jevlang-js/` `experiments/eslint-plugin-jev/{src,experiment}` の **24 ファイル・9,315 行** |
| 外したもの | `experiment/corpus/**`([22](22-code-criteria.md) の植え込みバグ 641 行。**ここで数えるのは実コードの指摘だけ**) |
| ルール | 8 文(reused 3・prose 3・probe 2) |
| セレクタが当てたノード | **670**(重複ノードを畳んで 579) |
| リクエスト | **25**(ファイル 1 個 = 1 リクエスト) |

ルールと、セレクタが何を拾ったか:

| id | 系統 | セレクタ | 当たった |
| --- | --- | --- | --- |
| `no-swallowed-catch` | reused | `CatchClause` | 28 |
| `explicit-sort-comparator` | reused | `CallExpression[callee.property.name='sort']` | 10 |
| `no-string-built-query` | reused | `TemplateLiteral` | **422** |
| `measured-number-has-a-source` | prose | `VariableDeclarator[id.name=/^[A-Z][A-Z0-9_]*$/]` | 69 |
| `no-threshold-in-question` | prose | `Property[key.name='instructions']` | 14 |
| `no-process-exit-in-module` | prose | `CallExpression[...process.exit]` | 7 |
| `noul-criteria-nested` | probe | `ObjectExpression:has(Property[key.name='type'][value.value='noul'])` | 19 |
| `fail-safe-silence` | probe | `CatchClause`(`hooks/**` に限定) | 10 |

prose の 3 文はこのリポジトリの散文から取りました:
[00](00-api-notes.md#noul-criteria) の「noul の criteria はネストする(トップレベルは黙って無視される)」、
[19](19-jevlang.md#1-言語の形) の「閾値は質問文に書かない」、
[22](22-code-criteria.md)〜[25](25-thresholds.md) が繰り返している「実測値には出典を書く」、
[18](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質) の「失敗は判断なしに落とす」。
**どれも linter には存在せず、`docs/` にしか書いていない**規約です。

---

## 1. 一回目の実行 — 579 判定・2.9 秒・$0.0135

```
rule                            cutoff  matches  reported  widest gap   n/a  sat  arg  vio
measured-number-has-a-source      2.00       69         5        0.26    46    8   15    0
no-string-built-query             2.50      422         0        0.60   398   23    1    0
no-process-exit-in-module         2.00        7         0        0.01     0    7    0    0
no-swallowed-catch                1.50       28        12        0.39     0   16    8    4
fail-safe-silence                 2.00       10         1        0.74     0    8    2    0
noul-criteria-nested              2.00       19         1        0.58     0   15    3    1
no-threshold-in-question          2.00       14         0        0.07     0   14    0    0
explicit-sort-comparator          2.00       10         0        0.12     0   10    0    0
```

最後の 4 列が band(四捨五入したレベルごとの件数): not-applicable / satisfied / arguable / violation。

- **指摘は 19 件 / 579 判定。** 5 ルールは 1 件も出さず、残り 3 ルールに集まった。
- **`no-string-built-query` の 398/422 が level 0。** 「文字列連結で SQL を作るな」を
  表を出力するだけのコードに 422 回聞いて、**398 件が「当てはまらない」・誤検出 0**。
  過剰なセレクタは level 0 が吸う —— これが [24 §4](24-adhoc-rules.md#4-セレクタはわざと広く書くのが正しい) の設計で、
  実コードでの数字はここで初めて出ました。
- **ただし広さの値段は測れる。** この 1 ルールで 422 / 579 判定 = トークンの **74%**。
  指摘 0 件に $0.010 払っています。**広く書くのは正しく、無料ではない。**

---

## 2. 19 件を全部読んだ

ラベルが無いので、**1 件ずつコードを読んで分類**しました。

| ルール | 指摘 | 読んだ結果 |
| --- | --- | --- |
| `no-swallowed-catch` | 12 | **0 件が要修正。** 4 件(自信あり)は判定層の意図的な沈黙とプローブの契約 |
| `measured-number-has-a-source` | 5 | **2 件が要修正**(下記)。3 件は列挙型 `DENY = 2`・配列定数・コメント済みの定数 |
| `noul-criteria-nested` | 1 | 誤検出。`criteria` を持たない noul で、**note が明示的に対象外と書いてある**のに発火 |
| `fail-safe-silence` | 1 | 誤検出、ただし原因は glob(§7)—— フックではなく**フックのテストハーネス**を拾っていた |

**直した 2 件:**

| 場所 | 何が無かったか | 直し方 |
| --- | --- | --- |
| `hooks/jev-permission-gate.mjs` の `TIMEOUT_MS = 2500` | 2500 の由来がどこにも無い | [18](18-permission-hook.md) の実測(median 329 ms / p90 394 ms)と、**2500 は実測ではなく予算**だと書いた |
| `src/rules.mjs` の `INLINE_LIMIT = 600` | コメントは「何のための定数か」しか書いていない | **600 は測った値ではなく選んだ値**だと書いた |

3 つ目に `test-gate.mjs` の `REPEATS = 3`(なぜ 3 回か)も同時に書きました。
**指摘の中身は「バグ」ではなく「書かれていない前提」**で、
このリポジトリの規約([22 §11.4](22-code-criteria.md#114-当てはめた閾値は予告どおり壊れたそして直せた)・
[25](25-thresholds.md))が一番気にしている種類のものです。

**要修正でなかった 17 件のうち、一番読む価値があるのはこれです:**

```js
// experiments/eslint-plugin-jev/src/index.mjs -- score 2.90 / conf 0.90
  } catch {
    return {};                     // ← 「失敗を成功と区別できない値」そのもの
  }
```

文の通りで、**設計の通り**でもある。[18](18-permission-hook.md#1-精度より先に決めるべき-3-つの性質) と
[21](21-eslint-plugin-jev.md) で決めた「判定層は必ず沈黙に倒す」がこの形です(§6)。
同じことがラベル用プローブでも起きていて、`catch { return true }` は
**その `true` がアサーションそのもの**です。

---

## 3. confidence は「直すべきか」ではなく「文が当てはまるか」

| | 指摘 | うち要修正 |
| --- | --- | --- |
| confidence ≥ 0.5(verdict として出る) | 5 | **0** |
| confidence < 0.5(質問として出る) | 14 | **2**(conf 0.29 / 0.19) |

[24](24-adhoc-rules.md#結論先に) では**自信のある 5 件が 5/5 正解**でした。ここでは完全に反転しています。
理由は逆説的ではありません:

- `catch { return {} }` が「失敗を成功と区別できない値を返している」ことは**一目で分かる**。
  だから confidence が高い。**そして直すべきかどうかは別の話**。
- 「この数値の由来がコメントに書かれているか」は**本当に微妙**。だから confidence が低い。
  **そして直すべきものはこちらに居た**。

→ [21 §7](21-eslint-plugin-jev.md#7-confidence-をゲートにすると-11-ポイント損する) の
「confidence はルーティング、ゲートではない」はここでも正しく、
**ルーティングの向きが逆になることがある**。
低 confidence を「弱い指摘」として畳むと、実リポジトリでは**当たりを畳む**。

---

## 4. gap の隣に band を置いた

[24 §1](24-adhoc-rules.md#1-読むのは閾値ではなく-gap) の「読むのは gap」で走らせたら、
狭い gap が 3 つ出て、**中身が正反対**でした:

| ルール | gap | 答えがどこに居るか | 本当の意味 |
| --- | --- | --- | --- |
| `no-threshold-in-question` | 0.07 | 14 件全部が 0.79〜1.00 = **satisfied** | **違反が無い。ルールは働いている** |
| `explicit-sort-comparator` | 0.12 | 10 件全部が 0.72〜1.01 = satisfied | 同上(全 sort に比較関数がある) |
| `measured-number-has-a-source` | 0.26 | **0.05〜2.29 に連続**、閾値をまたぐ | **文が働いていない** |

gap は「閾値では助からない」しか言っていないので、**どちらなのかは band が言う**。
`rules-report.mjs` に 4 列足して、助言も分けました:

```
widest gap 0.07 -- but every answer is at `satisfied` or below: nothing to report, and nothing to fix
widest gap 0.26 -- too narrow to separate anything, and the answers cross the cutoff; rewrite the sentence
```

[24](24-adhoc-rules.md) が「狭い gap = 文を書き直す」と書けたのは、
**コーパスに違反が植えてあることを知っていたから**です。
実リポジトリでは「違反が無い」が普通の状態なので、この区別が無いと**働いているルールを毎回書き直す**ことになる。

---

## 5. 文を書き直す / subject を広げる — 3 draft 測って、どれも直らなかった

`no-swallowed-catch` が 12 件出したので、[24 §3](24-adhoc-rules.md#3-書き直しは安い--文がキーに入っているから) の
書き直しループを実リポジトリで回しました。**1 文直して再質問 100 件・$0.005**(安さは実コードでも同じ)。

**draft 2**: note に「失敗をカウンタやログに記録している場合」「テストで例外自体を判定に使っている場合」を追加。

| ノード | 何をしているか | draft 1 | draft 2 |
| --- | --- | --- | --- |
| `src/warm.mjs:295` | `failed += 1` してログを出す | 2.73 | **1.77** |
| `src/cache.mjs:43` | `{...empty, reason}` を返す | 1.91 | **1.42**(報告から外れた) |
| `labels.mjs:251` | プローブの `catch { return true }` | 2.75 | 2.55 |
| `src/index.mjs:126` | 判定層の `catch { return {} }` | 2.90 | 2.87 |

**効いたのは「証拠がブロックの中にある」例外だけ。**
カウンタもログも戻り値のフィールドも catch 節の中に見えるので下がり、
「これはテストのプローブである」は**catch 節から見えない**ので下がらない。
[24 §2](24-adhoc-rules.md#2-5-ルール中-2-つは最初の文が失敗した) の
「判断できない条件を文に書かない」が、**例外の側でもう一度**出た形です。

**draft 3**: 文も note も変えず、**subject を変えた** —— セレクタを
`FunctionDeclaration:has(CatchClause)` 系にして、囲んでいる関数を判定させる。
両方をラベル付きコーパス([22](22-code-criteria.md) の 641 行)で採点すると:

| ノード | ラベル | draft 1(catch 節) | draft 2(catch 節) | draft 3(関数) |
| --- | --- | --- | --- | --- |
| `fsutil.js` `readJsonOrDefault` | **nearmiss**(意図的) | **2.43** | **2.35** | **2.31** |
| `fsutil.js` `saveAll` | **bug**(本物の握り潰し) | 1.57 | 1.76 | 1.69 |
| `retry.js` ×2 | clean | 1.09 / 1.07 | 1.05 / 1.00 | 0.97 / 0.95 |

- **3 通りとも、意図的な catch が本物のバグより上に来る。** 順位はラベルと逆で、安定して逆。
- **例外を渡してもラベル付きのバグは失われなかった**(1.57 → **1.76**)。
  [16 §5](16-eslint-oracle.md#5-逃げ道を渡したら直るのか--spec-arm) の
  「逃げ道を渡すと見逃しが 0 → 11 件」はここでは起きていません。
  差は例外の種類かもしれない —— 16 が渡したのは**仕様の例外**、こちらは**証拠の形**。
- **subject を広げると実リポジトリではノイズが増える**(10/28 → **23/36**)。
  関数 1 個には「怪しく見える箇所」が catch 節より多い。

`readJsonOrDefault` が上に来るのは、実はモデルの誤りではありません。
score のレベル 2 は「reviewer が指摘しうるし、見逃してもよい」で、
それは [21](21-eslint-plugin-jev.md) の `nearmiss` クラス(「警戒すべく見えるが正しい」)**そのもの**です。
つまり **level 2 は指摘ではなく質問**で、閾値 1.5(= level 2 の途中)で切れば
「意図的にそうしてあるコード」が必ず入ってくる。

→ この文はこのリポジトリでは **retire** しました(§8)。

---

## 6. 規約が 2 つ、同じノードで矛盾した

```
docs/18: 判定を返す層は、失敗を「判断なし」に落とすこと。
docs/24: catch 節を、失敗を成功と区別できない値を返して終わらせないこと。
```

`src/index.mjs:126` の `catch { return {} }` に対して、前者は**満たしている**(1.08)、
後者は**明確に違反**(2.90)と答えます。**どちらのモデルも間違っていません。**

実リポジトリに向けて初めて見えるのはこれで、
**規約同士の衝突は、規約を散文で置いている限り気付けない**。
ルールにすると同じノードで正反対の点が付いて、初めて選択を迫られます。

---

## 7. 設定の罠 3 つ

**(a) ESLint はルールオプションをブロック間でマージしない。**
`hooks/**` に絞ったブロックを足したら、**他の 7 ルールが `hooks/**` から消えました**。
気付けたのは `--dry-run` の件数で、655 行のファイルの match が **3 件**だったから。
→ **`--dry-run` はコスト見積もりではなく設定のテスト。**

**(b) ファイル glob は鈍い。** `hooks/**` は**フックのテストハーネス**まで拾い、
`fail-safe-silence` の唯一の指摘はそこでした(ハーネスがパース失敗を
`{parseError}` という decision 風のオブジェクトにしている)。
スコープを `hooks/jev-permission-gate.mjs` の 1 ファイルに直しました。
[24 §5](24-adhoc-rules.md#5-セレクタは静かに失敗するこれは直せない) の
「セレクタは静かに失敗する」に、**glob も静かに当たりすぎる**を足しておきます。

**(c) コメントが証拠のルールは、コメントを直してもキャッシュが無効化されない。**
キャッシュキーはノードのテキストで、**コメントはノードの外**。
`TIMEOUT_MS` の由来を書いても、キーは変わらないので古い判定が残ります。
`--force` が必要で、`--force` は**同じ名前空間の記録を落とす**(だから retire した 2 文の
判定は `out-repo-drafts.json` に別に置いてあります)。

---

## 8. 2 文を retire した。そして 2 件直した

| 文 | どうしたか | 理由(測った結果) |
| --- | --- | --- |
| `no-swallowed-catch` | **retire** | このリポジトリでは 12/28 が指摘になり、要修正が 0。§5 のとおり文でも subject でも直らない |
| `measured-number-has-a-source` | **retire** | 2 draft とも分離しない(gap 0.26 / 0.39、答えが閾値をまたぐ)。**「なぜその数か」に決定可能な版が無い** —— タイムアウトには理由が要り、列挙型の 0/1/2 には要らず、コードはどちらかを言わない |
| 残り 6 文 | **出荷** | 481 判定・**指摘 0**。`eslint .` は 31 ファイルを見て 0 件 |

retire した文は消さずに
[`experiment/repo-drafts.mjs`](../experiments/eslint-plugin-jev/experiment/repo-drafts.mjs)
に置いてあります。**試して駄目だった文は、書き直しループの一番高い部分**なので、
次に「数値には出典を書け」を思い付いた人がここで 2 回測ってあることに気付けるように。

そして**直した 3 つのコメントは、ルールを黙らせました** ——
`TIMEOUT_MS` と `REPEATS` は再質問で閾値の下(**1.41** / **1.44**)に落ちました。
`INLINE_LIMIT` は**書いても 2.12 のまま**で、これは「600 は選んだ値」と書いた文が
「なぜ 600 か」に答えていないから。**ルールの方が正しい。**

> **報告件数は draw で ±2 動きます。** 同じ文・同じコードで 12 → 10。
> そして**唯一の「自信のある誤検出」(2.50 / conf 0.50)は再 draw で閾値の下に落ちました**。
> [25 §7](25-thresholds.md#7-同じ-diff-を-10-回投げる23-11-の宿題) の
> 「閾値のすぐ近くは coin flip」が、指摘のレベルで再現しています。
> → **閾値のすぐ上の指摘は 2 回聞く。**

---

## 何が言えるか

- **散文の規約は、実際にルールになる。** ただし出てくるのは「バグ」ではなく
  **「書かれていない前提」**でした(2 件とも数値の由来)。
  [16 §9](16-eslint-oracle.md#9-正直な限界) が本命と呼んだ形は、この形で当たる。
- **コーパスに無いのはバグの種類ではなく「わざとやっている版」。**
  [22](22-code-criteria.md) の「列挙の穴」は**正例**の穴だったが、
  実リポジトリで開くのは**負例**の穴 —— [21](21-eslint-plugin-jev.md) が
  `nearmiss` クラスを作ったのと同じ理由で、ad-hoc ルールにもそれが必要になる。
- **level 0 は効く。セレクタは広く書いてよい。** 422 件の 94% が自分で「対象外」に落ちた。
  **ただし請求書は来る**(実行の 74%)。
- **gap の隣に band を置く。** 「狭い gap」は「違反が無い」と「文が働いていない」の
  両方に見える。実リポジトリでは前者が普通の状態。
- **文を答えられる形にすることと、正しく判定させることは両立しないことがある。**
  [24 §2](24-adhoc-rules.md#2-5-ルール中-2-つは最初の文が失敗した) に従って
  subject から見える範囲だけを聞くようにすると、**意図を見分ける情報がまさに範囲外**になる。
  subject を広げても直らなかったので、これは書き方の問題ではない。
- **confidence の向きは領域で変わる。** 形が自明なほど自信は高く、
  形が自明な違反は**意図的であることが多い**。
  だから「低 confidence を畳む」は実リポジトリでは当たりを畳む。

## 正直な限界

- **ラベルが無い。** 19 件の分類は**こちらがコードを読んだ判断**で、
  [23 §12](23-task-filter.md#12-追記--このリポジトリ自身で正解ラベルを実測した) のように
  終了コードで証明はできていません。probe 系の 2 文だけが「指摘は全部誤検出」という
  構造的な正解を持っています。
- **このリポジトリは規約の書かれ方が異常に丁寧。** 定数にコメントが付いていて、
  catch が意図的で、`docs/` に理由が書いてある。**指摘が 19 件で済んだのはそのため**で、
  普通のリポジトリの数字ではありません。
- **要修正 2 件は「率」ではない。** 9,315 行に対して 2 件で、
  同じ文を他のリポジトリに当てたときの精度は何も言えない。
- **TypeScript を見ていない。** warm パスの walker が ESLint の既定パーサなので、
  `experiments/*/src/*.ts`(task-filter・threshold-fit・shared で 3,000 行超)は対象外。
  TS パーサを足せば入りますが、**この実験の論点ではない**ので足していません。
- **`out-repo-rules.json` は「直したあと」の記録。** §1〜§3 の数字は
  最初の実行(2 つのコメントを書く前)のもので、
  `out-repo-drafts.json` にある retire した 2 文の判定は**直したあとの木**に対するものです。
  §8 の「ルールが黙った」がその差です。

## 次に試すこと

- **`nearmiss` を ad-hoc ルールのコーパスに入れる。** §5 の失敗は
  「わざとやっている版」がコーパスに無かったことに尽きます。
  [22](22-code-criteria.md) の 15 ファイルに**意図的な握り潰し**を数個足して、
  「意図的 vs 事故」を分ける文が存在するのかを測る。無ければそれが答え。
- **level 2 を報告しない運用を測る。** §5 のとおり level 2 = nearmiss なら、
  `reportAt` は 2.5(= 明確な違反のみ)が既定であるべきかもしれない。
  [24](24-adhoc-rules.md) の 2.0 はレベル境界の議論から来ていて、**実コードでは測っていない**。
- **他人のリポジトリで走らせる。** このリポジトリは自分で規約を書いて自分で守っている。
  **規約を守っていないコードが本当に出てくるか**は、外のコードでしか測れない。
- **`--dry-run` を設定のテストとして名前を変える。** §7 (a) で分かったのは
  「件数を見ると設定の間違いが出る」で、これは見積もりではなく検査です。
