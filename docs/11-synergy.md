# 11. チャンピオンのシナジー(AD/AP・前衛)と相互キルの同時処理

[02](02-moba.md) と [10](10-jev-vs-jev.md) のチャンピオンは**全員同じ**だった(攻撃 10・HP 100・
耐性なし)。ここでは (1) [10 §5](10-jev-vs-jev.md#5-正直な限界) で指摘した**相互キルの先手有利を消し**、
(2) チャンピオンに**多様性**(AD/AP・耐性・HP・前衛)を持たせ、
(3) **正しいシナジーを選ぶと勝つのか**を測り、(4) **Jev に編成を選ばせる**。
さらにゲームを**ログに保存して再生**できるようにした(TUI 版に続き **Web 版**も: `web/replay.html`)。

再現:

```bash
moon test --target native -p moba                              # 戦闘の単体テスト(7 件)
moon run --target native cmd/moba -- --arena                   # チーム戦アリーナ(API 不要)
moon run --target native cmd/moba -- --tournament              # フルゲーム総当たり(API 不要)
moon run --target native cmd/moba -- --draft                   # Jev に編成をドラフトさせる(要 API)
moon run --target native cmd/moba -- --a scripted --b scripted \
  --a-comp tank,marksman,mage --b-comp marksman,assassin,marksman --replay g.jsonl
moon run --target native cmd/moba_replay -- --file g.jsonl     # リプレイ再生(TUI)
```

---

## 1. 相互キルの同時処理

[10 §5](10-jev-vs-jev.md#5-正直な限界) で指摘した宿題。旧 `step` は行動を
**champ id 順**(A が 0–2、B が 3–5)に解決していたので、相互に致死ダメージを
出したとき低 id = **A の一撃が先に入り、A だけが生き残る**。[10](10-jev-vs-jev.md) はこれを
「A に有利な人工物」として正直に書いていた。

修正は、combat を**その tick の開始時スナップショットに対して同時解決**する:

1. 生きている全チャンピオンの与ダメージを**開始時の状態に対して**計算し、`Map[target, dmg]` に累積する。
2. 全ダメージを**まとめて**適用してから、死亡を判定する。
3. 死んだ相手への **kill/gold クレジットは「単発最大」の攻撃者**に与える。

`target.alive()` はスナップショットを読むので、**同 tick に倒れるチャンピオンも殴り返せる**
(相互致死なら**両者が一撃を入れて両者が死ぬ**)。単体テストで固定した:

```
mutual lethal kills both sides       # 両者死亡・両者キル 1
a dying champion still deals its blow # 倒れる側の一撃も入る
```

**証拠**: 対称な scripted classic 同士は、修正後は **350–350 の完全な引き分け**になる
(同じ方針 × 同じ編成 × 対称マップ = 鏡写し)。旧 id 順ではここが割れていた。
20 ゲームでの A/B バランス再測定は [10 の追記](10-jev-vs-jev.md#8-追記--同時処理に直して-20-ゲームで測り直す) に置いた。

## 2. チャンピオンに多様性を持たせる

7 アーキタイプ。`classic` だけは旧来の均一チャンピオン(耐性 0・攻撃 10・HP 100)で、
[02](02-moba.md) の挙動を**そのまま再現**するために残してある。

| key | 与ダメージ | attack | HP | armor | MR | 前衛 |
| --- | --- | --- | --- | --- | --- | --- |
| classic | 物理(AD) | 10 | 100 | 0 | 0 | – |
| marksman | 物理(AD) | 12 | 95 | 15 | 15 | – |
| mage | 魔法(AP) | 14 | 85 | 12 | 12 | – |
| assassin | 物理(AD) | 16 | 90 | 15 | 12 | – |
| bruiser | 物理(AD) | 10 | 135 | 35 | 25 | ● |
| tank | 物理(AD) | 6 | 175 | 55 | 45 | ● |
| support | 魔法(AP) | 7 | 105 | 25 | 30 | – |

編成を意味あるものにするレバーは 2 つ。どちらも**チェック可能な機構**として実装した:

- **与ダメージ型 vs 耐性。** 物理は armor、魔法は magic_resist で軽減する
  (`dealt = attack * 100 / (100 + resist)`)。**armor は魔法に無力、MR は物理に無力**なので、
  片方の型しか持たないチームは、相手の対応する耐性が高いだけで価値が落ちる。
  アイテム化が無いぶん耐性が固定なのが、mono-damage を「刺される」形にしている。
- **前衛のピール。** `frontline` のチャンピオンが同じノードに生きている間、
  **後衛(非 frontline)を狙った攻撃は前衛に肩代わりされる**。これが無いとタンクは
  ただの低火力の的で、フォーカスは後衛を消しにいく。単体テストで固定した
  (`a frontliner soaks hits aimed at the backline` / `no frontline means the carry eats the hit`)。

これらは「聞き方」ではなく**メカニクス**だ。フィールド上でシナジーが効くのは、
それを成立させる機構(ピール・耐性ミティゲーション)を実装して初めてで、
最初の実装(機構なし)では後述のとおり glass cannon が全勝していた。

## 3. 正しいシナジーは勝つか — チーム戦アリーナ

まず macro(レーン・farm・タワー)を全部外し、**編成だけ**を変数にする。両チームを 1 ノードに
乗せ、全員が最も柔らかい敵をフォーカスし(前衛ピールが効く)、撤退なしで全滅まで殴り合う。
6 編成の総当たり(両サイド)= 30 戦:

```
rank  comp          前衛  ダメージ  W-L-D    picks
 1    meta          ●     AD+AP    10-0-0   tank, marksman, mage
 2    frontline_ad  ●     mono     8-2-0    bruiser, marksman, assassin
 3    bruiser_mix   ●     AD+AP    6-4-0    bruiser, marksman, support
 4    glass_ad      –     mono     4-6-0    marksman, assassin, marksman
 5    glass_ap      –     mono     2-8-0    mage, mage, support
 6    classic       –     mono     0-10-0   classic, classic, classic
```

**順位が「前衛の有無」で完全に二分している**(上位 3 が前衛あり、下位 3 が前衛なし)。
チーム戦では**前衛が支配的なレバー**だ。そして前衛を持つ 3 つの中では、AP も持つ
`meta`(tank+marksman+mage)が**10–0 で無敗**。前衛編成に AP を足すと `frontline_ad` の
8–2 が `meta` の 10–0 になる —— これが AD/AP の混合が効いている分だ(タイブレーク)。

**答え:チーム戦では正しいシナジー(前衛 + AD/AP)が勝つ。** 主レバーは前衛、混合火力は上乗せ。

## 4. フルゲームだと薄まる — 総当たり

同じ 6 編成を**フルゲーム**(scripted 同士、レーン・farm・タワー・視界の霧あり)で総当たり:

```
rank  comp          前衛  ダメージ  W-L-D   picks
 1    bruiser_mix   ●     AD+AP    8-0-2   bruiser, marksman, support
 2    glass_ap      –     mono     8-2-0   mage, mage, support
 3    glass_ad      –     mono     6-4-0   marksman, assassin, marksman
 4    meta          ●     AD+AP    4-4-2   tank, marksman, mage
 5    frontline_ad  ●     mono     2-8-0   bruiser, marksman, assassin
 6    classic       –     mono     0-10-0  classic, classic, classic
```

順位が崩れる。`bruiser_mix`(正しいシナジー)は**無敗のまま**だが、glass 編成が上位に来て、
`meta` は 4 位まで落ちる。理由はリプレイを見れば分かる: **前衛は 1 ノードでしかピールできない**のに、
scripted の farm/push bot は 3 体をレーンに散らすので、前衛のいないレーンの後衛は素で殴られ、
`meta` の攻撃 6 のタンクは**構造物を割る速さ**で glass 編成に負ける。

つまり「**シナジーが勝つ**」は**戦闘の話**で、その戦闘が試合を決めるかは macro 次第。
アリーナ(§3)はそこを切り分けるための測定で、フルゲーム(§4)は「弱い bot では薄まる」ことの正直な記録。

## 5. Jev は編成を「選べる」か — ドラフト

最後に、Jev に**素の stat だけ**を渡して編成をドラフトさせる。state に入れるのは
アーキタイプの数値(attack/HP/armor/MR/frontline/与ダメージ型)と**中立なルール**
(ピールがある・耐性は対応する型を軽減する)だけ。「前衛が強い」「混合が強い」とは**一切言わない**。
1 リクエストで 6 編成それぞれを `score` させ、`choice` で 1 つドラフトさせる:

```
comp          Jev score  Jev#   arena W-L  arena#
meta          1.97       1      10-0       1
frontline_ad  1.53       2      8-2        2
bruiser_mix   1.46       3      6-4        3
glass_ad      0.24       5      4-6        4
glass_ap      0.46       4      2-8        5
classic       0.09       6      0-10       6

Jev would draft: meta (conf 0.76)   → アリーナ最強の編成を引いた
```

**Jev の順位はアリーナとほぼ一致する。** 上位 3 と最下位は完全一致、真ん中の glass 2 つだけが
入れ替わっている(どちらも弱い側)。そして **Jev は最強編成 `meta` を conf 0.76 で選んだ。**
教えていない「前衛が強い/混合が強い」を、**stat とルールから推論して**いる。

これは [docs 全体の一般則 4](README.md#この探索から見えている一般則)「**state を構造化しろ**」が、
ドラフトという新しい問題形でもそのまま効いた例だ。Jev の推論を強くしたのではなく、
**判断に要る数値を渡し忘れなかった**から選べた。

## 6. ログとリプレイ(TUI と Web)

ゲームは **JSON Lines** で記録する: 先頭に `meta`(マップとロスターを埋め込む — **自己完結**)、
毎 tick の `frame`(全チャンピオンの HP・位置・gold・kill、全構造物、そのtickのイベント)、末尾に `result`。
`cmd/moba --replay` と referee の両方が書ける。

`cmd/moba_replay` が端末で再生する。盤面(2 レーン + ジャングルのグラフに占有マーカー)、
色つき HP バー、キルフィード、Enter で 1 手送り / `--auto` で自動:

```
  A scripted [tank/marksman/mage]   vs   B scripted [marksman/assassin/marksman]
  tick 2   frame 3/61

               a_top twr100   m_top          b_top twr100
                              At Bt

a_base base150 a_jg           m_jg           b_jg           b_base base150
                              Aj Bj

               a_bot twr100   m_bot          b_bot twr100
                              Ab Bb

  At tank      m_top   █████████░ 168/175  physical g=0    k/d 0/0
  Aj marksman  m_jg    ████████░░ 82/95    physical g=0    k/d 0/0
  ...
```

**まず TUI**、というリクエストどおり。ファイルが自己完結(meta にマップとロスターを埋め込む)なので、
**Web 版 `web/replay.html` は同じファイルをそのまま読む** —— 依存ライブラリなしの 1 枚 HTML で、
SVG 盤面(チーム色のチャンピオン + HP リング + 構造物)、両チームのスコアボード、キルフィード、
再生バー(play/pause・ステップ・スクラブ・速度)を出す。`.jsonl` をドラッグ&ドロップするか、
同梱の `web/sample.jsonl` を開いて再生する。ブラウザで `web/replay.html` を開けば動く
(fetch を使う都合上、`web/` を簡易サーバで配信するのが確実)。

```bash
moon run --target native cmd/moba -- --a jev --b scripted \
  --a-comp tank,marksman,mage --b-comp marksman,assassin,marksman --replay web/sample.jsonl
python3 -m http.server -d web 8000   # → http://localhost:8000/replay.html
```

## 7. 正直な限界

- **混合火力のレバーはこのロスターでは弱い。** タンク/ブルーザーは armor も MR も両方高いので
  「耐性が偏った的」になっておらず、mono-AD が刺さりきらない。前衛が支配的になり、AD/AP は
  タイブレークに留まる。armor だけ極端に高い juggernaut を足せば AD/AP の物語はもっと鮮明になる。
- **フルゲームの bot が弱い。** [02](02-moba.md#4-正直な限界) のまま集団で寄らない farm/push bot なので、
  シナジーが出るチーム戦がそもそも起きにくく、§4 は編成の実力を過小評価している。
  集団で寄る bot にすればフルゲームでもシナジーが出るはず。
- **アリーナは撤退も位置取りも無い**純粋なダメージ・レース。実際の MOBA のカイトや射程は無い。
- **ドラフトは 1 リクエスト。** ロスターやルールを変えても Jev がアリーナに追従し続けるかは未検証。
- **決定論なので pairing ごとに 1 ゲーム**(分散なし)。頑健さは総当たりの網羅から来ていて、反復からではない。

## 8. この実験で確定したこと

1. **同時処理で先手有利が消えた。** 対称 scripted classic は 350–350 の引き分けになる(§1)。
2. **シナジーは「聞き方」ではなく「メカニクス」で作る。** 前衛のピールを実装するまで、
   タンクはただの低火力の的で、glass cannon が全勝していた。フィールド上のシナジー効果は、
   それを成立させる機構を入れて初めて測れる(§2–3)。
3. **チーム戦では正しいシナジー(前衛 + AD/AP)が勝つ。ただしフルゲームでは macro が薄める。**
   「シナジーが勝つ」は戦闘の主張で、戦闘が試合を決めるかは別問題(§3–4)。
4. **Jev は素の stat から正しい編成を選べる。** 「前衛/混合が強い」と教えていないのに、
   アリーナとほぼ一致する順位を付け、最強編成を conf 0.76 で引いた。
   **state を構造化して渡す**という一般則が、ドラフトという新しい問題形でも効いた(§5)。

## 9. 次に試すこと

- juggernaut(armor 偏重)を足して AD/AP のタイブレークを主レバーに引き上げる。
- 集団で 1 レーンに寄る強い scripted bot を作り、フルゲームでもシナジーが出るか(§4 の宿題)。
- Jev にドラフト**させて**からそのまま Jev 同士で対戦させ、「選んで勝つ」を一気通貫で測る。
- ~~リプレイの **Web 版**(同じ JSON Lines を読む)。~~ → **§6 で追加(`web/replay.html`)。**
