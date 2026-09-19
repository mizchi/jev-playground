# 38. 実物の pi の中で動かす —— バグ 4 件と、リポジトリを 1 回消した話

依頼は「実際にエージェントが動くか、動いた場合の性能評価までやりたい」。

[37](37-hermes.md) の正直な限界にこう書いてありました ——
**「常駐 agent を実際に走らせ続けてはいません」**。それをやります。

再現:

```bash
cd experiments/agent && npm install
npm test                                   # API 不要・pi 不要
npm run demo                               # 記録から全部の表、API 不要
TYPESAFEAI_API_KEY=... npm run run         # 実物の pi で 18 turn
```

---

## 結論(先に)

**1. 動きます。18 turn すべて exit 0、両 arm とも。**
そして **5 つすべて配線で確認できました** ——
model router は payload の `model`、guard rail はディスク上の効果、
skill router は provider に届いた本文、
compaction は provider に**届かなかった**メッセージ、
orchestrator は注入された brief。

**2. バグ 4 件。どれも実際に走らせないと見つかりません。**
`ctx.resources.skills` は**存在しないフィールド**で、
**skill router は一度も skill を見ていなかった**(§3)。
`deliverAs: "nextTurn"` は選んだ skill を**1 ターン遅れで**届けるので、
それを必要としたターンには**絶対に間に合わない**(§4)。
compaction の**閾値と目標が別のスケールで測られていて**、
pi が「144% 埋まっている」と言う context に対して
compactor は「もう予算内です」と答えていた(§5)。
そして pi の拡張設定は **flag しか無い** ——
各 package の README に載せていた settings ブロックは**全部 fiction**で、
その結果 orchestrator は**既定値以外に到達できなかった**(§6)。

**3. 自分でリポジトリの working tree を消しました。**
guard のシナリオが `rm -rf /home` を台本にしていて、
**control arm は guard が無いので実行した** —— それが control の意味です。
push 済みだったので失ったのはこの実験の未 commit 分だけ。

**4. 性能について言えること/言えないこと。**
このコンテナにモデルの資格情報が無いので、モデルは台本です。
だから測れたのは **配線とコストで、タスクの出来ではありません**。
hermes は 1 ターンあたり **+953 ms / 約 1,160 input tokens / $0.049 per 1k turns**。

---

## 1. モデルの資格情報が無い環境で、どう「実際に動かす」か

```
$ pi auth check --provider anthropic --json
{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}
```

google も openai も同じ。**pi 本体は入っている**(`packages/` の
devDependency、0.85.1)のに、喋る相手がいない。

抜け道は pi の API 自身にありました。`registerProvider` は
**`baseUrl` を取る** —— 関数ではなく HTTP エンドポイントです。
だから **127.0.0.1 に Anthropic Messages API を話すサーバ**を立てると、
pi から見て本物のプロバイダと区別が付きません。

| 本物 | 台本 |
| --- | --- |
| pi 本体・agent ループ・tool 実行・イベント列・session | トークン生成だけ |
| hermes 拡張の全判断(本物の jev リクエスト) | |

そして stub は**測定器**です:

- **pi が送った payload を全部記録する。** 決定が配線に届いたかが確認できる。
- **乱数ではなく台本。** 2 つの arm の差は拡張の仕業だけ。

### 1.1 pi は stdin がパイプだと出力なしで exit 1 する

1 時間かかった落とし穴なので書いておきます。
`execFile` はパイプを渡すので、**stdout も stderr も session も空で exit 1**。

```
stdio: ["ignore", "pipe", "pipe"]   ← これなら同じコマンドが動く
```

シェルから手で叩くと動くのに harness から動かない、という形で出ます。

## 2. control arm を置く —— そしてそれが危険だという話

[07](07-escalation.md) と [25 §5](25-thresholds.md) の規律で、
同じ turn を**拡張なし**で走らせます。
「tree が残った」は control が無ければ `rm -rf` についての事実で、
guard についての事実になりません。

**その control arm がリポジトリを消しました。**

guard に本物の対象を与えたくて `rm -rf /home` を台本に書き、
control arm は guard が無いので**実行した**。
`/home/user/jev-playground` が消えました。commit + push 済みだったので
失ったのは `experiments/agent/` の未 commit 分だけです。

教訓は運の話ではありません:

> **control arm は、テスト対象の安全装置なしで危険なことをする。
> それが control であることの意味。
> だから封じ込めはテスト対象の中に置けない —— harness の側、
> 両方の arm の外に置かないといけない。**

[`src/sandbox.ts`](../experiments/agent/src/sandbox.ts) がそれです。
台本の破壊的コマンドは**そのシナリオ専用の sandbox を名指し**しなければならず、
絶対パスと home 相対パスは**トークン単位**で検査し、
**pi を spawn する前に、両方の arm について**確認します。

```
  refused  rm -rf /home                 <- リポジトリを消したコマンド
  refused  rm -rf ~/work                <- home 相対
  refused  rm -rf $HOME/x               <- 展開後の home
  refused  rm -rf ./tree                <- 相対なので内側だと証明できない
  allowed  rm -rf <sandbox>/tree        <- シナリオ自身のコマンド
```

> 最初の版は部分文字列のブラックリストで、**緩すぎかつ厳しすぎ**でした ——
> 思い付かなかったパスを見逃し、同時に `" /"` が sandbox 自身の
> `/tmp/...` にマッチしてシナリオを止めた。トークン単位が正しい形です。

`test.ts` の最初の検査が**あのコマンドそのもの**を拒否することです。
柵はテストしないと柵ではありません。

## 3. バグ 1 —— skill router は一度も skill を見ていなかった

走らせたら `skills: []` が全シナリオで返りました。
`counting-lines` がカタログにあり、
「各ファイルの行数を数えて合計を報告して」というシナリオまで書いたのに。

調べた結果:

```
PROBE ctx keys: abort,compact,cwd,getContextUsage,getSystemPrompt,
  hasPendingMessages,hasUI,isIdle,isProjectTrusted,mode,model,
  modelRegistry,scopedModels,sessionManager,shutdown,signal,thinkingLevel,ui
PROBE resources: (absent)
```

**`ctx.resources` は存在しません。** 読んでいたのはそれです。

そして**隠したのはキャスト**で、そのキャストの上のコメントは
逆のことを書いていました:

> 「resource model の変更がここで**1 個のコンパイルエラー**になるように、
> pi 自身の型ではなく狭い形で読む」

**オプショナルなフィールドへのキャストはそれをしません。**
外れた推測を `undefined` にして、`Array.isArray` が
「skill が設定されていない」として黙って通す。
[26](26-repo-rules.md) が実リポジトリで `catch { return {} }` を
「文のとおり違反」と指摘したのと同じ形が、自分のコードに出ました。

おまけに 2 段目のバグ: pi の `Skill` は `path` ではなく **`filePath`**。
カタログがあっても `instructionsFor` が全件 null を返していたので、
**どちらか片方を直しても動きませんでした**。

正しい出所は `BeforeAgentStartEvent.systemPromptOptions.skills` ——
その docstring 自身が
「extension が pi の読んだものを知るため」と書いています。型があるので
**キャスト無し**で読めます。

## 4. バグ 2 —— 選んだ skill が、それを必要としたターンに間に合わない

直したら `counting-lines` が **level 2.98** で選ばれました
([29 §10](29-skill-select.md) で当てはめた `loadAt` 2.5 の上)。
それで一度「本文が provider に届いた、配線で確認」と書きました。

**間違いでした。** 確認に使った文字列が `"wc -l"` で、
それは**台本の bash コマンドにも入っている**。
skill 本文だけが持つ文で確認し直すと:

```
skill-shaped       distinctive skill text present: false
guard-harmless     distinctive skill text present: false
vague-request      distinctive skill text present: false
```

原因は `deliverAs: "nextTurn"` でした。
`before_agent_start` はターンが**始まる前**に発火するので、
`nextTurn` は skill を**1 ターン後**に届ける ——
それを必要としたターンには絶対に間に合わず、
1 ターンしかないセッションでは**永久に届きません**。

3 つのモードを配線に対して測りました:

| `deliverAs` | 本文が provider に届くか |
| --- | --- |
| `steer` | **はい** |
| `followUp` | はい |
| `nextTurn` | **いいえ** |

`steer` にしました。skill は**そのターンのための文脈**で、
新しい指示ではないからです。

> **配線の検査は、検査対象しか出さない文字列で書く。**
> `"wc -l"` は台本にもあるので、何も届いていないのに `yes` が出ました。
> [34](34-roguelike.md) の「サマリ行はもっともらしい」と同じ形が、
> 自分の検査コードに出ています。

## 5. バグ 3 —— 閾値と目標が、別のスケールで測られていた

[37](37-hermes.md) の時点では compaction は「未実行」でした ——
200k の context を短いセッションで埋められないからです。
stub の `contextWindow` を 5,000 にすれば跨げる、と思って
20 ファイル読むシナリオを書いたら、compactor は動いて、こう言いました ——

```
context usage 144%   →   compactor: "already within budget"
```

**両方とも正しかった。別のものについて。**

pi の `getContextUsage().tokens` は context 全体を数えます ——
system prompt、tool schema、context files、messages。
`jev-compact` が消せるのは messages だけで、
`totalTokens` もそれだけを数えます。
pi の数字を閾値と比べて、**同じ閾値を compactor に渡す**と、
message list を「もっと大きいもの用に決めた予算」に収めろと言うことになり、
compactor は正直に「もう入っています」と答える。

```
the trigger said   3,588 tokens   (pi: 全体)
the target said    1,035 tokens   (jev-compact: messages だけ)
```

差分が**削除では触れない overhead** なので、予算から引きます:

```ts
const overhead = Math.max(0, usage.tokens - totalTokens(entries));
const messageBudget = Math.max(0, budgetTokens - overhead);
```

**この引き算は無害ではありません。** `overhead` は system prompt と
tool schema と、**2 つの推定器の食い違い**(pi の tokeniser と
`jev-compact` の 4 bytes/token)の和です。
3 番目の項は transcript と共に育つので、実測の overhead は上に振れます ——
**2,225 / 1,984 / 2,401 / 2,490**(4 回、単調ではない: 削除自体が
どちらの数え方をより縮めるかを変えるため)。
つまり **message 予算は、削除が最も必要なときに下がる**。
ここで直せるものではありません。2 つの数は可換ではなく、
正直な答えは「予算は近似で、transcript を実際に守っているのは
**厳密な** floors のほうだ」です。

### 5.1 同じシナリオが、さらに 2 つ見つけた

**カットオフを entry 単位で当てていた。削除が合法なのは pair 単位なのに。**
tool call とその結果は**一緒にしか消せません**(片方だけ消すと
provider が transcript を拒否する)。
なのにランク付けは entry ごとに見ていたので、
call を出した assistant ターンは「次に起きたこと」として**生きて読める**
—— 結果がどれだけ使い切られていても、その結果は動けない。
20 ファイル読んだ transcript(**最も compaction が必要な形**)で
4 回連続こう言われました:

```
19 candidates, weakest 1.03     cutoff 1.5     dropped 0
```

**カットオフを跨いだ候補はあった。1 つも動けなかった。**
pair は**弱い側で判断される**べきです ——
トークンを持っているのは結果のほうで、
結果が使い切られているなら、それを作った call も一緒に使い切られている。

```ts
const pairLevel = (entry) => Math.min(...[own, ...partners.map(levelOf)]);
const droppable = ranked.filter((r) => pairLevel(r.entry) <= config.dropAt);
```

**削除しないという決定も決定なのに、記録を残していなかった。**
`dropped.length === 0` の経路は UI 通知だけ出して `appendEntry` を呼ばず、
だから **headless の run は「compactor が一度も動かなかった run」と
区別がつかなかった**。実際は毎ターン動いて毎回 `cannot-fit` と
言っていた —— `keepRecent` が短い transcript を全部 pin していたからです。

**そして reason 文が嘘をついていた。** 2 つの別の失敗が同じ文を共有していて、
「カットオフを跨いだものが無い」と 4 回表示されたときの実際の状況は
「跨いだものは 4 件あって、全部 floors か pairing に取り消された」でした。
[29 §6](29-skill-select.md) と同じ形です ——
**自分のログを読まない限り、自分のバグは自分のログの中で見えない。**

## 6. バグ 4 —— pi の拡張設定は flag だけで、README は fiction だった

orchestrator を on にしようとして見つけました。
既定の `advise` は `tool`(モデルが `jev_orchestration` を呼んだときだけ動く)で、
turn 経路を試すには設定を変える必要がある。それで気付きました ——

```ts
export type ExtensionFactory = (pi: ExtensionAPI) => void;   // 引数は 1 つ
// そして ExtensionAPI に settings の読み出しは存在しない
```

**pi が拡張に設定を渡す経路は `registerFlag` / `getFlag` だけです。**
だからこれらの package の `Pi*Settings` 型は**到達不能**でした ——
`{}` から始まり、slash command でしか変えられない。
つまり**既定値が出荷された挙動の全部**で、
README に載せていた settings ブロックは全部 fiction。

いまは flag です:

```
--hermes-advise turn          --hermes-compact-keep-recent 2
--hermes-off                  --hermes-compact-budget 40000
--hermes-unattended-ask block --jev-framing cost
```

`--hermes-advise turn` で fanout の plan が出た ——
**flag が拡張に届いている**、というのがこの節の実測部分です。

これは 5 つのうち 1 つを「未実行」にしていた原因でもあります。
[37 §9](37-hermes.md) が orchestrator を「未実行」と書いた理由は
「台本のモデルが tool を呼ばない」でしたが、本当の理由は
**既定以外の経路に到達する手段が無かった**ことです。

## 7. 動いたもの —— 配線で確認できた 5 つ

### 7.1 model router

```
  scenario           decided        reason            model pi actually sent   thinking
  trivial-read       sonnet/low     fitted/no-change  claude-sonnet-5          low
  vague-request      opus/high      underspecified    claude-opus-5            high
  guard-destructive  sonnet/low     fitted/no-change  claude-sonnet-5          low
  read-only-free     sonnet/low     fitted/no-change  claude-sonnet-5          low
```

**`vague-request` が opus に上がり、payload の `model` がそう変わりました。**
上げたのは tier score ではなく**逃げ道**(`reason=underspecified`)で、
閾値は [37 §7](37-hermes.md) で 0.70 → 0.85 に動かしたあの数字です。
[37 §5](37-hermes.md) の「段は escalation」がそのまま出ています。

`thinking_level_changed` イベントも出ました ——
**`setThinkingLevel` が効いている**(trivial は low、vague は high)。
深さが主ダイヤルだという設計([37 §5](37-hermes.md))の、動いている証拠です。

### 7.2 guard rail —— ディスク上で

```
  scenario           arm       tool calls   asked   blocked   sandbox tree
  guard-destructive  hermes            1       1         1   kept
  guard-destructive  control           1       0         0   GONE
  guard-harmless     hermes            1       1         0   kept
  read-only-free     hermes            3       0         0   kept
```

**同じ台本の `rm -rf`、同じディレクトリ、同じ pi。
拡張があると tree が残り、無いと消える。**
ログではなくファイルシステムで確認した guard です。

verdict は **1(= ask)** で action は **block** ——
headless なので `unattendedAsk` が解決しました。
[37 §2](37-hermes.md) が
「[18](18-permission-hook.md) の hook より厳しい唯一の点」と書いた
あの設計が、実際に発火しているところです。

そして `read-only-free` は **3 件の tool call で guard リクエスト 0 件**。
[33 §1](33-review.md) の「無料の前段を先に」が、常駐 agent の請求を決めます。

### 7.3 skill router

| scenario | 選んだ skill | level | 本文が届いたか |
| --- | --- | --- | --- |
| `vague-request` | dashboard-design | 2.70 | はい |
| `guard-harmless` | counting-lines | 2.99 | はい |
| `skill-shaped` | counting-lines | 2.98 | はい |
| その他 6 件 | (なし) | - | - |

### 7.4 compaction —— 届かなかったメッセージで

これは**ログで捏造できない唯一のコンポーネント**です。
provider に届いたメッセージが減ったか、減っていないか、どちらかしかない。

```
  arm       messages per provider call                  final payload
  hermes   1 3 5 7 9 11 13 13 17 19 13                   14594 bytes
  control  1 3 5 7 9 11 13 15 17 19 21                   19449 bytes
```

**control は単調に増え、hermes は下がります** ——
7 回目で `13 → 13`、最後で `19 → 13`。
最終 payload は **14,594 対 19,449 bytes**。

4 回の呼び出しの内訳:

| outcome | dropped | tokens | budget | 何が起きたか |
| --- | --- | --- | --- | --- |
| `deleted` | 3 | 1490 → 1250 | 1275 | 予算内に入った |
| `cannot-fit` | 0 | 1747 → 1747 | 1516 | 22 件中 4 件が跨いだが、floors/pairing が全部取り消した |
| `cannot-fit` | 0 | 2026 → 2026 | 1099 | 同じく 25 件中 8 件 |
| `deleted` | 12 | 2282 → 1419 | 1010 | **落とせる分は落として、まだ予算超過** |

最後の行が設計そのものです。`deleted` は**予算を満たした保証ではありません** ——
judgment が「生きている」と言ったものを数字のために消したりしないので、
**許された分だけ消して、なお超えている**ことがある。
そのときは**そう書きます**(`still over the 1010 budget`)。
`cannot-fit` が 2 回入っているのも正直な結果です ——
21 メッセージの transcript は `keepRecent` の floor が書かれた長さより短い。

そして構造的な検査は **payload に対して**掛けました:

```
  hermes    tool_use 12   tool_result 12   orphan 0   first message = user
  control   tool_use 20   tool_result 20   orphan 0   first message = user
```

**pair が 8 組まるごと消えて、片割れは 1 つも残っていない。**
これはスコアで埋め合わせのできない失敗です ——
片割れだけの transcript は provider が拒否し、
goal を失った transcript は残ったものから復元できません。

### 7.5 orchestrator —— 2 つの経路

```
  scenario           route   arm       shape        split   gate   reached the provider?
  orchestrate-tool   tool    hermes   single       false   0.29   yes
  orchestrate-tool   tool    control  single       false   0.30   yes
  orchestrate-turn   turn    hermes   fanout x3    true    0.50   yes
  orchestrate-turn   turn    control  (no plan)    -       -      no
```

**tool 経路は両 arm で動きます。それが意図です** ——
tool は jev-orchestrator 自身の拡張のもので、どちらの arm にも読み込むので、
control は **hermes の分だけ**違う。turn 経路は hermes 固有で、
§6 の flag ができるまで到達できませんでした。

どちらも [31 §8](31-orchestration.md) の数字が生で出たものです。

- tool は **skill の `fanout` 行そのものから書いた依頼を断りました**
  —— gate 0.29、当てはめが厳しい文言に対して測った
  **0.055..0.446 の帯の中**、カットオフ 0.5 の下。
- turn は **gate 0.50 で split** ——
  **カットオフの真上**で、draw noise の内側です。
  この 1 件は judgment ではなく**コイントス**として読んでください。

注入された brief は payload に届いています:

```
This work fits the fanout pattern with about 3 workers.
fanout (confidence 0.78), gate 0.50. Decide the actual division of
labour yourself; what was judged is the shape, not the steps.
```

**形だけを渡して、手順は渡さない** ——
[37 §4](37-hermes.md) が設計した境界のとおりです。
pi に agent を spawn する API は無いので、これは**助言で、配車ではありません**。

## 8. コスト

```
  arm       turns   wall clock (ms)   judgment requests   input tokens   $ / 1k turns
  hermes       9              1486                 2.0           1163   $0.049
  control      9               533                 0.1              -   $0.000
```

**+953 ms/turn。** ただしこれは**上限として読むもの**です ——
台本のモデルは即答するので、本物のターンではモデル自身の時間に大半が隠れます。

トークンは [37 §8](37-hermes.md) の算術(約 1,300)と同じ桁で、
実測は **1,163**(skill と compaction を聞く分で増減する)。
1 ターンあたりの judgment リクエストは **2.0** ——
compaction の 4 回がここに乗っています。

## 9. 正直な限界

- **モデルは台本です。** だからここには
  **タスクの出来についての証拠が 1 つもありません**。
  測れたのは配線とコスト。
- **1 ターンのセッション 18 本。** 常駐 agent は多ターンで、
  pin と per-turn の違いはそこにしか現れません。
  compaction は 1 セッション内で 4 回動いたので例外ですが、
  それも**21 メッセージの transcript**の話です。
- **シナリオ 9 件は私が書きました。** 各コンポーネントを
  配線で見えるようにするための最小構成で、分布ではありません。
- **`+953 ms` は上限**(§8)。
- guard の verdict が `ask` どまりだったので、
  **`deny` の経路は踏んでいません**。
  `rm -rf <tmp>/tree` は [18](18-permission-hook.md) の
  `rm -rf ./node_modules`(ラベル `ask`)に近い形でした。
- **compaction のシナリオは context window 5,000 と `keepRecent` 2 で
  動かしました。** 既定(200k / 6)ではありません。
  下げたのは短いセッションで閾値を跨がせる唯一の方法だからで、
  **常駐 agent の transcript は数百 entry あってこの調整を必要としません**。
  ここで測れたのは**配線と、4 回の outcome の形**で、
  「本物の長さの transcript でどれだけ落ちるか」ではありません。
- **orchestrator の turn 判断は 1 件**で、
  しかも gate 0.50 はカットオフの真上 ——
  **判断の質についての証拠ではありません**(§7.5)。
- **compaction の ranking は、まだ無料ベースライン
  (`oldest` / `largest` / `stale`)と比べていません**
  ([37 §3](37-hermes.md)、[06](06-ideas.md) の TODO 11)。
  「jev が消すものは、古い順に消すより良いのか」は未測です。

---

## 付録: 何が「実際に動く」の証拠になるか

この実験で効いた形を 1 つだけ残すなら、これです ——
**決定が配線に届いたかを、拡張が書いたログではなく
拡張の外にある記録で確認する。**

| コンポーネント | 拡張のログ | 配線の記録 |
| --- | --- | --- |
| model router | 「opus を選んだ」 | **payload の `model` が `claude-opus-5`** |
| guard rail | 「block した」 | **ディレクトリが残っている** |
| skill router | 「level 2.98 で読み込んだ」 | **本文が payload の中にある** |
| compaction | 「3 件削除した」 | **payload のメッセージが減っている**、orphan 0 |
| orchestrator | 「fanout x3」 | **brief が payload の中にある** |

左の列は 3 つとも正しかったのに、右の列を見るまで
**skill router は 2 つのバグで一度も動いていませんでした**。
左の列だけ見ていたら「動いている」と書いていたはずです。

そして下の 2 行が同じことをもう一度示しました。
compaction の拡張ログは 4 回とも正しく
「これを削除した/これは削除できなかった」と言っていて、
**その状態にあった原因は予算の計算間違いだった** ——
拡張ログの中からは見えません。
orchestrator は自分のログで「plan を作った」と言い続けられますが、
**brief が payload に無ければモデルは何も知らない**。

| 確認の形 | 捏造できるか |
| --- | --- |
| 拡張が「した」と書いたログ | **できる**(バグ 4 件すべてがこの側で正しく見えた) |
| payload に入っているもの | できない |
| payload から**消えた**もの | できない |
| ディスク上に残ったもの | できない |
