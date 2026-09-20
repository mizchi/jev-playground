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
npm test                     # 10 件。API キー不要
npm run load                 # Pi 自身の resolver に読ませる(こちらは Pi の実物を起動)
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

**The two profiles collide on 5 of the seams they take** (`before_agent_start`, `context`, `session_before_compact`, `session_start`, `tool_call`), which is why they are separate packages: `tool_call` twice is two permission gates on one call.

**5 seam のうち 5 つ、つまり全部で衝突します。** 両方入れると:

| seam | 両方入れたときに起きること |
| --- | --- |
| `tool_call` | **1 コマンドに permission gate が 2 つ**。確認ダイアログが 2 回、block も 2 回 |
| `before_agent_start` | hermes が**1 リクエストに束ねた**のに、別々の 3 つが**さらに 3 リクエスト** |
| `context` | **削除が 2 回**。2 つ目は 1 つ目が削った後のリストを見る |
| `session_before_compact` | 要約のキャンセル判断が 2 つ |

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

**つまり各パッケージ README の `pi install npm:jev-model-router` は、このリポジトリのものを入れません。**
3 つは別人のパッケージが入り、残り 4 つは 404 になります(§5)。

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
- **両方のプロファイルを同時に入れた状態は測っていません。**
  上の表は「そうなったら何が 2 回走るか」を seam から**読んだもの**で、
  2 つ入れて確認したものではありません。
  防いでいるのは構造(別パッケージ・`pi/` 自身は非パッケージ)とテストです。
- **`pi install npm:...` を直していません。** 6 つのパッケージ README にはその行が在り、
  §3 のとおり**3 つは別人のパッケージを入れます**。
  直し方は「公開する」か「行を消す」かで、**どちらもこのディレクトリの外の判断**なので触っていません。
- **`pi list` は個々の拡張を列挙しません。** 入っているかは `npm run load` で確かめてください
  (`pi config` は TUI のみ)。
- **Pi のバージョンは 1 つでしか試していません** —— `@earendil-works/pi-coding-agent` **0.85.1**。
  seam の名前も `ExtensionAPI` も Pi の API です。
