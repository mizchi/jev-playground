# 38. 実物の pi の中で動かす —— バグ 2 件と、リポジトリを 1 回消した話

依頼は「実際にエージェントが動くか、動いた場合の性能評価までやりたい」。

[37](37-hermes.md) の正直な限界にこう書いてありました ——
**「常駐 agent を実際に走らせ続けてはいません」**。それをやります。

再現:

```bash
cd experiments/agent && npm install
npm test                                   # API 不要・pi 不要
npm run demo                               # 記録から全部の表、API 不要
TYPESAFEAI_API_KEY=... npm run run         # 実物の pi で 12 turn
```

---

## 結論(先に)

**1. 動きます。12 turn すべて exit 0、両 arm とも。**
そして 5 つのうち **3 つは配線で確認できました** ——
model router は payload の `model` を、guard rail はディスク上の効果を、
skill router は provider に届いた本文を。

**2. バグ 2 件。どちらも実際に走らせないと見つかりません。**
`ctx.resources.skills` は**存在しないフィールド**で、
**skill router は一度も skill を見ていなかった**。
そして `deliverAs: "nextTurn"` は選んだ skill を**1 ターン遅れで**届けるので、
それを必要としたターンには**絶対に間に合わない**。

**3. 自分でリポジトリの working tree を消しました。**
guard のシナリオが `rm -rf /home` を台本にしていて、
**control arm は guard が無いので実行した** —— それが control の意味です。
push 済みだったので失ったのはこの実験の未 commit 分だけ。

**4. 性能について言えること/言えないこと。**
このコンテナにモデルの資格情報が無いので、モデルは台本です。
だから測れたのは **配線とコストで、タスクの出来ではありません**。
hermes は 1 ターンあたり **+919 ms / 約 1,100 input tokens / $0.046 per 1k turns**。

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

## 5. 動いたもの —— 配線で確認できた 3 つ

### 5.1 model router

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

### 5.2 guard rail —— ディスク上で

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

### 5.3 skill router

| scenario | 選んだ skill | level | 本文が届いたか |
| --- | --- | --- | --- |
| `vague-request` | dashboard-design | 2.70 | はい |
| `guard-harmless` | counting-lines | 2.99 | はい |
| `skill-shaped` | counting-lines | 2.98 | はい |
| その他 3 件 | (なし) | - | - |

## 6. コスト

```
  arm       turns   wall clock (ms)   judgment requests   input tokens   $ / 1k turns
  hermes       6              1557                 1.5           1103   $0.046
  control      6               638                 0.0              -   $0.000
```

**+919 ms/turn。** ただしこれは**上限として読むもの**です ——
台本のモデルは即答するので、本物のターンではモデル自身の時間に大半が隠れます。

トークンは [37 §8](37-hermes.md) の算術(約 1,300)と同じ桁で、
実測は **1,103**(skill を聞く分が入って増減する)。

## 7. 動かせなかったもの

| | 状態 | なぜ |
| --- | --- | --- |
| memory compaction | **未実行** | 200k の context を埋めるターンが無いので `context` が閾値を跨がない |
| orchestrator | **未実行** | 既定が `advise: tool` で、台本のモデルは tool を呼ばない |

5 つのうち 3 つが配線で確認済み。残り 2 つは配線もテストもあるが
**この harness が届いていない** —— harness についての事実です。

## 8. 正直な限界

- **モデルは台本です。** だからここには
  **タスクの出来についての証拠が 1 つもありません**。
  測れたのは配線とコスト。
- **1 ターンのセッション 12 本。** 常駐 agent は多ターンで、
  compaction も pin と per-turn の違いもそこにしか現れません。
- **シナリオ 6 件は私が書きました。** 各コンポーネントを
  配線で見えるようにするための最小構成で、分布ではありません。
- **`+919 ms` は上限**(§6)。
- guard の verdict が `ask` どまりだったので、
  **`deny` の経路は踏んでいません**。
  `rm -rf <tmp>/tree` は [18](18-permission-hook.md) の
  `rm -rf ./node_modules`(ラベル `ask`)に近い形でした。

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

左の列は 3 つとも正しかったのに、右の列を見るまで
**skill router は 2 つのバグで一度も動いていませんでした**。
左の列だけ見ていたら「動いている」と書いていたはずです。
