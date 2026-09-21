# `pi/` —— このリポジトリを Pi エージェントとして動かす部品

[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)(`@earendil-works/pi-coding-agent` 0.85.1)の
拡張として動く部品を 1 箇所に集めたものです。

**判断のコードはここに在りません。** 6 つの拡張は `packages/jev-<name>/src/pi.ts` に在り、
各パッケージは**それ自体が既に Pi パッケージ**です(`pi: { extensions: ["./src/pi.ts"] }`)。
足りていなかったのは**組み立て**で、ここはそれです ——
「このリポジトリを Pi エージェントとして動かす」を 1 コマンドにして、
**唯一の壊し方を踏みにくくした**もの。

```bash
cd pi && npm install         # 6 パッケージをローカルから symlink する。1 回だけ
npm run probe                # どの拡張がどの seam を取るか、実測。API キー不要
npm test                     # 12 件。API キー不要
npm run collide              # 両方入れたら何が 2 回走るか、Pi のランナーで実測
npm run load                 # Pi 自身の resolver に読ませる(こちらは Pi の実物を起動)
npm run load -- packages     # パッケージ README のレシピだけ、6 本とも
```

## 1. 2 つのプロファイルは**排他**です

| | 何が入るか | どちらを選ぶか |
| --- | --- | --- |
| **`pi/components`** | 5 つを**別々の拡張**として | 対話セッション。**部品ごとに切れて**、失敗も 1 部品のもの |
| **`pi/resident`** | **`jev-hermes` 1 つだけ**(同じ 5 つを内包) | 常駐エージェント。**1 ターン 1 リクエスト**、予算 1 つ、status 1 行 |

```bash
pi install ./pi/components   # どちらか一方
pi install ./pi/resident     # 両方入れてはいけません(理由は §2)
```

**`jev-hermes` は guard も自前の `tool_call` で持ちます**(「5 つを 1 拡張で」の 5 つに guard が入る)。
だから `resident` は `components` の**代替**で、追加ではありません。

## 2. 衝突は文章ではなく測ったものです

`npm run probe` の出力そのまま —— **README にこの表を手で書くことは避けています**
([docs/55 §6](../docs/55-wild.md) で、要約から手で書いた表を 1 つ間違えたので)。

### `pi/components` -- the five separate extensions

| extension | seams it registers | commands | flags | decides |
| --- | --- | --- | --- | --- |
| `jev-model-router` | `session_start` `before_agent_start` | `jev-model` | 0 | which model tier this turn needs, and pins it |
| `jev-skill-router` | `session_start` `before_agent_start` | `jev-skills` | 0 | which skills to load for this turn, from a catalogue that never enters context |
| `jev-orchestrator` | `session_start` `before_agent_start` | `jev-orchestrator` | 2 | whether to split this work, and into which topology |
| `jev-guard` | `session_start` `tool_call` | `jev-guard` | 0 | whether this tool call needs permission, and blocks or confirms |
| `jev-compact` | `session_start` `context` `session_before_compact` | `jev-compact` | 0 | which transcript entries are spent, and deletes them from what is SENT |

### `pi/resident` -- jev-hermes alone, which covers the same five

| extension | seams it registers | commands | flags | decides |
| --- | --- | --- | --- | --- |
| `hermes` | `session_start` `before_agent_start` `tool_call` `context` `session_before_compact` | `hermes` | 5 | all five, in one request per turn, under one budget |

**The two profiles collide on 5 of the seams they take** (`before_agent_start`, `context`, `session_before_compact`, `session_start`, `tool_call`), which is why they are separate packages. What each collision costs is not uniform and is not inferable from this table -- `collide.ts` fires them: a command in the gate's `ask` band shows the user two confirmation dialogs, and a blocked one stops at the first gate.

**5 seam のうち 5 つ、つまり全部で衝突します。**

### 2.1 両方入れて実際に撃ちました —— そして予測は 2 箇所外れていました

`npm run collide` が **Pi 自身の `ExtensionRunner`** で 4 つの seam を発火させ、
**3 アーム(components / resident / both)に同じ入力**を与えます。
コマンドは `rm -rf /etc/nginx/sites-enabled`。

| | 拡張 | ask: req | **ask: 確認ダイアログ** | deny: req | deny: block | context: req | context: msgs | turn: req | 要約キャンセル |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `components` | 5 | 1 | **1** | 1 | yes | 1 | 24 → 11 | 1 | yes |
| `resident` | 1 | 1 | **1** | 1 | yes | 1 | 24 → 11 | 1 | yes |
| **`both`** | **6** | **2** | **2** | **1** | yes | **1** | 24 → 11 | **2** | yes |

**Pi は 6 つ全部を載せます** —— load エラー 0、**diagnostic 0**。
重複排除も警告も**一切ありません**(だから防御は構造側にしか置けません)。

| seam | 予測していたこと | 実測 |
| --- | --- | --- |
| `tool_call`(ask) | 確認ダイアログが 2 回 | **成立。1 → 2**(リクエストも 1 → 2) |
| `tool_call`(deny) | block も 2 回 | **不成立。1 回**。`emitToolCall` は最初の `{block:true}` で **return** するので**2 つ目の gate は走りません** |
| `before_agent_start` | hermes の 1 件に**別々の 3 つが 3 件足す** | **1 → 2**。しかも**同じ 4 問**(`tier` `underspecified` `oversized` `effort`)—— 残り 2 つの turn 系部品はこのハーネスでは聞くことが無かった(§5) |
| `context` | **削除が 2 回**、2 つ目は 1 つ目の後のリストを見る | **半分成立。**「後のリストを見る」は正しい(`emitContext` は短絡せず**連鎖**する)が、**削除は 1 回**。2 つ目は残った 11 件を見て `cannot-fit` を記録し、**リクエストも送りません** |
| `session_before_compact` | キャンセル判断が 2 つ | **不成立。**`emit` は最初の `{cancel:true}` で return するので**1 つ**(ただし両アームともキャンセルする) |

> **つまり本当の危険は 1 箇所に絞れます** —— **`ask` に落ちたコマンド**です。
> ユーザは**同じコマンドについて 2 回聞かれ**、1 回目に yes と答えたときだけ 2 回目が来ます
> (no と答えると `{block:true}` になり、そこで短絡する)。
> **block されるコマンドは 1 回**、**削除は 1 回**、**要約キャンセルは 1 回**。
> 「全 seam で 2 倍」は**短絡を数えていなかった私の読み**でした。

ledger の順序にそれが出ます(`npm run collide` が印字):

```
components  jev-guard/decision -> jev-guard/decision -> jev-compact/deletion
resident    hermes/guard -> hermes/guard -> hermes/compaction -> hermes/turn
both        jev-guard/decision -> hermes/guard   <- ask は 2 つ通る
         -> jev-guard/decision                   <- deny は 1 つで止まる
         -> jev-compact/deletion -> hermes/compaction -> hermes/turn
```

**Pi の重複排除は救ってくれません。** 同一性は npm 名・git URL・**解決後の絶対パス**で決まるので
(`pi-coding-agent/docs/packages.md`)、2 つのプロファイルは別物として両方載ります。
だから:

- **別パッケージ**にしてあります(`pi install` は片方を指す)
- **`pi/` 自身は Pi パッケージではありません** —— `pi` キーを持たず、`pi/extensions/` も在りません。
  `pi install ./pi` は**何も読み込みません**。
- **その 2 つを `test.ts` が固定しています**(`pi/package.json` に `pi` キーが生えたら落ちる)。

## 3. 依存は `file:` だけ ——「npm の名前は他人のもの」

これは注意書きではなく**測った事実**です:

| npm の名前 | 実際に入るもの |
| --- | --- |
| `jev-guard@0.3.1` | [leepokai/jev-guard](https://github.com/leepokai/jev-guard) —— **別人の guard** |
| `jev-model-router@1.0.0` | [rajdhakad9826/jev-router](https://github.com/rajdhakad9826/jev-router) —— 別人の router |
| `jev-compact@0.2.0` | [aleksvega/fast-jev-compaction](https://github.com/aleksvega/fast-jev-compaction) —— 別人の compactor |
| `jev-skill-router` / `jev-orchestrator` / `jev-hermes` / `@jev-playground/jev-core` | **404**(このリポジトリのものは未公開) |

**`npm:` の綴りは、このリポジトリのものを入れません** ——
3 つは別人のパッケージが入り、残り 4 つは 404 になります。

> **ここは最初「各パッケージ README にその行が在る」と書いていました。数えたら 2 本でした。**
> `jev-model-router` と `jev-skill-router` の 2 本だけが `npm:` を印字していて、
> `jev-hermes` と `jev-orchestrator` は **`pi -e` のローカルパス**(正しい)、
> `jev-guard` と `jev-compact` は**install 行そのものが無い**状態でした。
> **6 本とも直してあります** —— 2 本は `npm:` を差し替え、4 本には
> **実測したローカルパスのレシピ**を足しました(`npm run load` が 6 本とも確認します)。
> **合計ではなく行を読む、を自分の README で 1 回破った形です。**

だから `pi/*/package.json` の依存は**すべて `file:../../packages/...`** で、
**バージョン範囲を書いたらテストが落ちます**。
`npm install` は**コピーではなく symlink** を張るので、**走るのはこのリポジトリのソース**です:

```
pi/node_modules/jev-guard -> ../../packages/jev-guard
```

entry file は**パッケージの公開 subpath**を re-export します(`src/` に手を伸ばしません)——
外部の利用者が受け取るものと同じ export をこの組み立て自身が通ることになります。

```ts
// pi/components/extensions/jev-guard.ts
export { default } from "jev-guard/pi";
```

## 4. 何がどこで測られたか

| 拡張 | 判断 | 出典 |
| --- | --- | --- |
| `jev-model-router` | どの段のモデルでこのターンを回すか | [36](../docs/36-routers.md) |
| `jev-skill-router` | どの skill を載せるか(カタログは context に入らない) | [29](../docs/29-skill-select.md) [30](../docs/30-skill-pick.md) |
| `jev-orchestrator` | 分割するか、どの topology か | [31](../docs/31-orchestration.md) [53](../docs/53-fanout.md) |
| `jev-guard` | この tool call は許可が要るか | [18](../docs/18-permission-hook.md) [43](../docs/43-finish.md) [55](../docs/55-wild.md) |
| `jev-compact` | どのエントリが使用済みか(**送るもの**から消す) | [39](../docs/39-compact-ranking.md) [45](../docs/45-floor.md) [48](../docs/48-keep.md) |
| `hermes` | 上の 5 つを 1 リクエストで | [37](../docs/37-hermes.md) [38](../docs/38-agent.md) |

この対応は `seams.ts` のデータで、**引用先が存在しなければテストが落ちます**
(実際 1 度落として直しました —— `docs/` を二重に付けていた)。

`jev-guard` を実トラフィックに当てた数字は [55](../docs/55-wild.md) です ——
**741 コマンド中 47 件(6.3%)で発言、レイテンシ中央値 322 ms**。
ただし [55](../docs/55-wild.md) が測ったのは **Claude Code の `PreToolUse`** で、
**Pi の `tool_call` は `ask` を返せません**(`{ block?, reason?, terminate? }` だけ)。
`ask` は拡張の中で `ctx.ui.confirm` か `unattendedAsk` に解決されます ——
`packages/jev-guard/src/pi.ts` の冒頭がその設計です。

## 5. 正直な限界

- **ここは配線で、判断は 1 行も入っていません。** entry file は re-export 6 本、
  `seams.ts` はデータ、`probe.ts`/`load.ts`/`test.ts` は計器です。
  **`pi/` を読んで分かるのは「何がどの seam に座るか」だけ**で、
  それが良い判断かは各 `docs/` の方に在ります。
- **`load.ts` は最初、自分の答えを間違えました。**
  `discoverAndLoadExtensions([profileDir], ...)` を呼んで
  「`pi.extensions: ["./extensions"]` は壊れている」と読み、
  **3 つの docblock に因果まで書きました**。
  package の resolver に訊き直したら**両方の綴りで 5/5 通りました** ——
  壊れていたのは**私の入口**です。
  いまは glob 形を使い(読み込むファイルを名前で言うから)、
  `test.ts` は**綴りではなくキーの存在**を固定し、
  **実際に解決されるかは `npm run load`** が Pi 自身に訊きます。
- **`npm run load` は `npm test` に入れていません。** Pi の実ランタイムを作るので遅く、
  **このディレクトリのせいでない理由で落ち得る**からです。`npm test` は repo だけで完結します。
- **両方同時は測りました(§2.1)。ただし判断は全部私の canned 値です。**
  `globalThis.fetch` を差し替えて、問いの `type` と名前から固定値で答えています ——
  **測ったのは「何個の handler が走り、何回リクエストが飛び、ユーザが何回聞かれ、
  何件のメッセージが残るか」**で、**Jev がこれらのコマンドをどう答えるかは測っていません**。
  カウントが所見で、判定は stub のものです。
- **`before_agent_start` の 1 → 2 は、3 つのうち 1 つしか聞いていない状態の 1 → 2** です。
  リクエストの問い名は 3 アームすべて `tier`/`underspecified`/`oversized`/`effort`
  だけ —— つまり **model router のみ**。skill router は**カタログが空**で聞くことが無く、
  orchestrator は既定で `before_agent_start` ではなく**ツール経路**です
  ([jev-orchestrator の README](../packages/jev-orchestrator/README.md))。
  **実セッションではこの列はもっと増え得ます。**
- **ハーネスの stub が seam の結果を決めている箇所が在ります。**
  `getContextUsage()` は私が与えた数字で、`setModel()` は常に false を返します。
  compactor は**これを整合させるまで 2 度空振り**しました ——
  最初は 190,000 トークン使用と申告して 4,000 トークンの transcript を渡したので、
  hermes は overhead を引いて予算 0 で `cannot-fit`、`jev-compact` は
  overhead を引かないので「もう予算内」で 0 件削除。
  **どちらも与えた数字については正しく、間違っていたのは私の設定**でした。
  さらに compactor の逃げ道 `nothing_spare` を noul の既定 0.9 で答えていたため
  **ランキング前に全削除が拒否**されていました(`nothingSpareAt: 0.8`)。
  いまは transcript から usage を導出し、`nothing_spare` を表に入れてあります。
- **パッケージ README のレシピは直しましたが、「公開する」方は選んでいません。**
  6 本とも**ローカルパスのレシピ**(`npm run load` が 6 本とも Pi の resolver で確認)にしました。
  **公開は選択肢として潰れています** —— `jev-guard` / `jev-model-router` / `jev-compact` の
  名前は既に他人のものなので、**公開するなら別の名前**になり、それは
  このディレクトリの外の判断です。
  同じ間違いが戻らないように、**コードブロックの中に `npm:<このリポジトリの名前>` が在ったら
  テストが落ちます**(散文で「これは間違いだった」と書くのは通ります —— 危険なのは
  コピペできる行だけなので)。
- **`pi list` は個々の拡張を列挙しません。** 入っているかは `npm run load` で確かめてください
  (`pi config` は TUI のみ)。
- **Pi のバージョンは 1 つでしか試していません** —— `@earendil-works/pi-coding-agent` **0.85.1**。
  seam の名前も `ExtensionAPI` も Pi の API です。
