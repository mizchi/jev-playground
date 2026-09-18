# 06. 次に効きそうなこと(提案)

00〜05 の実測から見えた順に並べた提案。**効果の見込み**と**なぜそう思うか**を、
既に測った数字に紐付けて書いてあります。

---

## A. confidence でエスカレーションする二層構成 ★検証済み → [07](07-escalation.md)

> **追記: 実際に測ったら「最有望」は外れだった。**
> チェスでは confidence が品質を順序付ける(ρ = -0.47)が、
> 分布が低い側に潰れているので**安い運用点が存在しない**(下位 5% を回してもランダムと同等)。
> シェルコマンド判定では第二段のほうが弱く、confidence も誤りを予測しなかった。
> 詳細と、必要条件 3 つの整理は [07](07-escalation.md)。以下は提案時点の記述。

[03](03-chess.md#3-confidence-が難しさを測っている) で、confidence が
**局面の難しさではなく判断の難しさ**を測っていることが見えました。
序盤の展開手は 0.14〜0.31、駒の取り合いは 0.81〜0.93。
[02](02-moba.md#confidence-が判断の質を区別している) でも同じで、
建物攻撃 0.68〜0.84 に対し殴り合いは 0.27〜0.52。

つまり **「Jev が迷った局面だけ高いモデルか探索に回す」** が素直に書けます。

```
jev で判断 → conf >= 0.7 ならそのまま採用(数百 ms、$0.00005)
           → conf <  0.7 のときだけ Opus か αβ 探索(数秒、$0.01)
```

測るべきは**コストと品質のトレードオフ曲線**: 閾値を 0 から 1 に動かしたとき、
エスカレーション率と勝率(あるいは正解率)がどう動くか。
チェスなら Stockfish を入れて centipawn loss で測れる。

これが効けば「System One / System Two の役割分担」を数字で示せるので、
この探索全体の中で一番価値が高いと思います。

## B. 閾値フィットを `lib` の部品にする

[04](04-agent-built-prompts.md#2-原因は設計ではなく閾値だった) の結論そのまま。
`score` の期待値とラベルから閾値を引くヘルパを `lib` か `report` に置く:

```moonbit
/// ラベル付きサンプルから、順序のある判定の切れ目を引く。
pub fn fit_thresholds(
  values : Array[Double],
  labels : Array[Int],
  n_classes : Int,
) -> Array[Double]
```

これがあると [01](01-shell-risk.md)・[02](02-moba.md)・[04](04-agent-built-prompts.md) が
同じ形で校正できます。実測では閾値を合わせ直すだけで **10〜22 → 21〜22 に収束**しました。
**設計より校正のほうが効く**ので、部品にする価値がある。

## C. Claude Code の permission hook として実装する

[01](01-shell-risk.md) は「エージェントの実行許可ゲート」として作ったので、
そのまま `PreToolUse` hook にできます。Bash コマンドを state に、
`permission` の score を閾値で読んで allow / ask / deny を返す。

- レイテンシ 250 ms は hook として実用範囲(体感に乗らない)
- コストは 1 コマンド $0.00002 程度
- [01 の 2 節](01-shell-risk.md#2-同じコマンドでも文脈で判断が変わる)のとおり、
  hook は cwd・ブランチ・保護設定を**持っている側**なので、構造化 state の利点が最大に出る

`.claude/settings.json` の hook から叩く小さなバイナリを `cmd/` に置けば完結します。
**この探索の中で唯一、明日から自分が使えるもの**。

## D. state の ablation ツール

[05](05-browser-chaos.md#2-効いたのは質問ではなく-state-だった) で、
**質問は一字も変えずに state だけ 4 回作り直して**ようやく通りました。
つまり作業の中身は state 設計で、そこには測る道具がありません。

state のフィールドを 1 つずつ落として同じコーパスを流し、正解率の差を出すツール:

```
field                     accuracy without it
screen_text               23/24 -> 14/24   ← 効いている
states_seen               23/24 -> 22/24
recent_actions            23/24 -> 23/24   ← 落としてよい
```

トークンを払う価値のあるフィールドだけ残せるので、**コストと精度の両方に効く**。
どの実験にも使えるので、B と並んで部品化する価値があります。

## E. リポジトリ丸ごとの map-reduce トリアージ

launch post が挙げている「map-reducing over big data」を、手元のリポジトリでやる。
1 ファイル(または 1 関数)を state に、複数軸を 1 リクエストで:

- `is_dead_code` / `is_security_sensitive` / `needs_tests` / `is_generated`
- `complexity`(score)/ `owner_team`(choice)

[fan-out の実測](00-api-notes.md#speculative-fan-out)どおり、軸を増やすコストは質問文だけ。
入力 $0.042/MTok なので、**数千ファイルのリポジトリでも数十セント**で回ります。
`chaosbringer` の `heatmap.ts` / `clusters.ts` のような集計と相性が良さそう。

正解ラベルは `git log`(実際に消えたファイル = dead code だった)から作れるので、
**評価が自動で用意できる**のが良い点です。

## F. chaosbringer 側の本筋対応

[05 の 4 節](05-browser-chaos.md#4-chaosbringer-側への指摘-driver-の候補一覧が-1-ページ-1-回しか作られない)
で見つけた、driver ループが候補一覧を 1 ページ 1 回しか作らない件。

1. 候補収集をステップごとにやり直す(SPA 対応)。`aiDriver` にも効く
2. その上で `compositeDriver([jevDriver, weightedRandomDriver])` を測る。
   [幅はランダム・深さは Jev](05-browser-chaos.md#1-結果) だったので、
   併用が両取りになるはず(状態数 8.3 と フロー深度 5 を同時に取れるか)
3. 候補が 255 を超えるページでの方針(重み上位 255 に絞る?)

## G. Jev を LLM-as-judge に置く

launch post の "score, judge, verify, guardrail"。CI で毎 diff に対して走らせる:

- `is_breaking_change` / `needs_migration_note` / `touches_security` (noul)
- `review_priority`(score、順序あり)
- `owning_team`(choice)

速度(200 ms)と価格が効くので、**全 PR・全ファイルに回せる**のが普通の LLM judge と違う点。
[00](00-api-notes.md#closed-world) の逃げ道の選択肢は必須(範囲外の diff が来る)。

## H. 役割分担を先に決める二段構え(MOBA の続き)

[02 の 6 節](02-moba.md#6-次に試すこと)に書いた話。今は 3 体の行動を独立に聞いているので、
**3 体が同時に「自分が足止めする」と答える**可能性が構造的にあります。

1 問目で `choice`「誰が足止めするか」を決め、2 問目以降で各自の行動を聞く二段構え
(同じリクエスト内では依存関係を作れないので 2 往復)と、
今の 1 往復を比べる。**並列評価に依存関係を持ち込むときの一般形**なので、
MOBA 以外にも効く知見になりそうです。

## I. リアルタイム UI のデモ

レイテンシが 125〜250 ms なので、**人の操作に対して 1 フレーム内で応答する**使い方ができます。
[この探索では全部バッチ](README.md)なので、UX 側の価値は未検証。

例: 入力中のテキストに対して「この文は攻撃的か」「この操作は取り消しにくいか」を
リアルタイムに出して UI を変える。GIF が作れるのはこのリポジトリの得意分野
([gomoku.gif](../gomoku.gif) の実時間再生)なので、見せ方まで揃っています。

---

## 優先順位

| | 提案 | 効果の見込み | 手間 |
| --- | --- | --- | --- |
| — | ~~A. confidence エスカレーション~~ | **検証済み。狙った経済性は出なかった → [07](07-escalation.md)** | — |
| 2 | **C. permission hook** | 大(実用) | 小 |
| 3 | **B. 閾値フィット部品** | 中(全実験に効く) | 小 |
| 4 | **D. state ablation** | 中(全実験に効く) | 小 |
| 5 | F. chaosbringer 本筋 | 中 | 中 |
| 6 | E. repo トリアージ | 中(評価が自動で作れる) | 中 |
| 7 | H. 二段構え | 中(一般形) | 中 |
| 8 | G. LLM judge | 小〜中 | 小 |
| 9 | I. リアルタイム UI | 未知 | 中 |

**B と D は小さくて全部に効く**ので先に入れると後が楽になります。
A は検証して外れだったので([07](07-escalation.md))、残りの先頭は **C(permission hook)**。
