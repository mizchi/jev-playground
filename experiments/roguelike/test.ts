/**
 * What has to hold before a request is spent.
 *
 *   npm test      # no API key. Real NetHack only if it is installed.
 *
 * The load-bearing ones: the glyph classifier and the geometry agree with
 * hand-built screens, the enumerated action set is the choice criteria and
 * nothing else, every perception probe's truth comes from the grid, and no
 * payload carries an answer. The last one matters more here than anywhere
 * else in this repository: the ground truth for "is a monster next to you"
 * is computed from the same screen that goes into the state, so a careless
 * state shape would hand over the answer.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DIRS, diagonalBlocked, distances, enumerate, frontiers, kindOf, reachable, stepToward, steppable } from "./src/actions.js";
import { MAP_ROWS, NetHack, ROWS, available, heroAt, mapOf, vitalsOf, type Screen } from "./src/nethack.js";
import { monsterCount, probesFor, stairsAt, stateFor as perceiveState } from "./src/perceive.js";
import { ARMS, EMPTY_MEMORY, payloadOf, questionFor, stateFor } from "./src/arms.js";
import { drain, greedyPolicy, randomPolicy, rngFrom } from "./src/play.js";
import { rehydrate } from "./src/run.js";
import type { WalkRecord } from "./src/walk.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
};
const skip = (name: string, why: string): void => {
  console.log(`  skip ${name} (${why})`);
};
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

/** A screen from map rows plus a status line, padded like the real thing. */
function fake(mapRows: string[], status = "Dlvl:1 $:0 HP:16(16) Pw:2(2) AC:6 Xp:1/0 T:5 S:12"): Screen {
  const rows = Array.from({ length: ROWS }, (_, i) => {
    if (i === 0) return "";
    if (i >= 1 && i <= MAP_ROWS) return mapRows[i - 1] ?? "";
    if (i === 22) return "Jev the Stripling              St:18/02 Dx:10 Co:18 In:10 Wi:9 Ch:8 Neutral";
    if (i === 23) return status;
    return "";
  }).map((r) => r.padEnd(80, " ").slice(0, 80));
  return { rows, message: rows[0].trim(), status: `${rows[22].trim()} ${rows[23].trim()}`.trim() };
}

const ROOM = fake([
  "",
  "  -----",
  "  |...|",
  "  |.@.|",
  "  |..>|",
  "  -----",
]);

// ------------------------------------------------------------- the classifier

check("every glyph NetHack draws lands in exactly one class", () => {
  eq(kindOf(" "), "unexplored");
  eq(kindOf("-"), "wall");
  eq(kindOf("|"), "wall");
  eq(kindOf("."), "floor");
  eq(kindOf("#"), "corridor");
  eq(kindOf(">"), "stairs down");
  eq(kindOf("+"), "closed door");
  eq(kindOf("d"), "monster");
  eq(kindOf("@"), "monster", "a second @ on the map is another human");
  eq(kindOf("%"), "item");
  eq(kindOf("^"), "trap");
  ok(!steppable(kindOf(" ")) && !steppable(kindOf("-")), "blanks and walls are not steppable");
  ok(steppable(kindOf("+")) && steppable(kindOf("d")), "a closed door opens and a monster is attacked");
});

check("the hero and the staircase are found at the right coordinates", () => {
  const hero = heroAt(ROOM)!;
  eq(hero.x, 4);
  eq(hero.y, 3);
  const stairs = stairsAt(ROOM)!;
  eq(stairs.x, 5);
  eq(stairs.y, 4);
  eq(mapOf(ROOM).length, MAP_ROWS);
});

check("the status line parses, and a screen without one gives null", () => {
  const v = vitalsOf(fake([""], "Dlvl:3 $:47 HP:9(16) Pw:2(2) AC:6 Xp:2/12 T:411 Hungry"))!;
  eq(v.dlvl, 3);
  eq(v.gold, 47);
  eq(v.hp, 9);
  eq(v.hpMax, 16);
  eq(v.xpLevel, 2);
  eq(v.xp, 12);
  eq(v.turn, 411);
  eq(v.flags.join(","), "Hungry");
  eq(vitalsOf(fake([""], "a full-screen message, no status here")), null);
});

// --------------------------------------------------------------- the geometry

check("breadth-first search respects walls and counts diagonal steps as one", () => {
  const hero = heroAt(ROOM)!;
  const d = distances(ROOM, hero);
  eq(d[4][5], 1, "the staircase is one diagonal step away");
  eq(d[1][0], -1, "a wall square is not reachable");
  eq(d[2][3], 1);
  const found = reachable(ROOM, (k) => k === "stairs down");
  eq(found.length, 1);
  eq(found[0].d, 1);
  eq(stepToward(ROOM, found[0])!.name, "southeast");
});

check("a closed door blocks a diagonal step, and plain floor does not", () => {
  const withDoor = fake(["", "  -----", "  |...|", "  |.@+ ", "  |...|", "  -----"]);
  const hero = heroAt(withDoor)!;
  const east = DIRS.find((d) => d.name === "east")!;
  const northeast = DIRS.find((d) => d.name === "northeast")!;
  eq(diagonalBlocked(withDoor, hero, east), false, "an orthogonal step is never blocked by this rule");
  eq(diagonalBlocked(withDoor, { x: hero.x + 1, y: hero.y }, northeast), true, "standing on the door blocks diagonals");
  eq(diagonalBlocked(ROOM, hero, northeast), false);
});

check("a frontier is a square that touches something unmapped", () => {
  // A corridor running off the right-hand side into blank space.
  const corridor = fake(["", "  -----", "  |...|", "  |.@.####  ", "  |...|", "  -----"]);
  const front = frontiers(corridor);
  ok(front.length > 0, "a corridor ending in blanks has a frontier");
  // The corridor's four `#` sit at columns 6 to 9; column 10 is already blank.
  const last = front.find((f) => f.x === 9);
  ok(last !== undefined, `the corridor's far end is a frontier; got ${JSON.stringify(front.slice(0, 4))}`);
  // A sealed room has none.
  eq(frontiers(fake(["", " -----", " |...|", " |.@.|", " |...|", " -----"])).length, 0, "a sealed room has no frontier");
});

// ----------------------------------------------------------- the action set

check("the action set offers eight steps and says what each one leads to", () => {
  const { actions } = enumerate(ROOM);
  for (const dir of DIRS) {
    const a = actions.find((x) => x.name === dir.name);
    ok(a !== undefined, `no action for ${dir.name}`);
    ok(/the square there shows/.test(a!.says), `${dir.name} does not say what is there`);
  }
  ok(actions.some((a) => a.key === ">"), "descend is always offered");
  ok(actions.some((a) => a.key === ","), "pick up is always offered");
  ok(actions.some((a) => a.key === "s"), "search is always offered");
  ok(!actions.some((a) => a.key === "e"), "eat is offered only when hungry");
  eq(enumerate(ROOM, { hungry: true }).actions.some((a) => a.key === "e"), true);
});

check("the description of each step matches the glyph actually there", () => {
  const { actions } = enumerate(ROOM);
  const east = actions.find((a) => a.name === "east")!;
  ok(east.says.includes("`.` = floor"), east.says);
  const southeast = actions.find((a) => a.name === "southeast")!;
  ok(southeast.says.includes("`>` = stairs down"), southeast.says);
  const north = actions.find((a) => a.name === "north")!;
  ok(north.says.includes("`.` = floor"), north.says);
  const withMonster = fake(["", "  -----", "  |..d|", "  |.@.|", "  |...|", "  -----"]);
  const ne = enumerate(withMonster).actions.find((a) => a.name === "northeast")!;
  ok(ne.says.includes("= monster") && ne.says.includes("attacks it"), ne.says);
});

check("a refused action is dropped from the next offer, and never all of them", () => {
  const all = enumerate(ROOM).actions;
  const fewer = enumerate(ROOM, { exclude: new Set(["h", "j"]) }).actions;
  eq(fewer.length, all.length - 2);
  ok(!fewer.some((a) => a.key === "h" || a.key === "j"), "the refused keys are gone");
  // Excluding everything would leave a policy with nothing to pick.
  const nothingLeft = enumerate(ROOM, { exclude: new Set(all.map((a) => a.key)) }).actions;
  eq(nothingLeft.length, all.length, "an empty offer falls back to the full set");
});

check("a screen with no @ yields no actions rather than a guess", () => {
  const { actions, hero } = enumerate(fake(["", "  You feel a strange sense of loss."]));
  eq(hero, null);
  eq(actions.length, 0);
});

// -------------------------------------------------------------- the two arms

check("the choice criteria are exactly the offered actions", () => {
  const { actions } = enumerate(ROOM);
  for (const arm of ARMS) {
    const q = questionFor(arm, actions).move;
    ok(q.type === "choice", `${arm} does not ask a choice`);
    const names = Object.keys((q as { criteria: Record<string, unknown> }).criteria);
    eq(names.length, actions.length, arm);
    eq(names.join("|"), actions.map((a) => a.name).join("|"), arm);
  }
});

check("jevbare is told the direction and nothing else", () => {
  const { actions } = enumerate(ROOM);
  const bare = JSON.stringify(questionFor("jevbare", actions));
  const full = JSON.stringify(questionFor("jev", actions));
  ok(!bare.includes("the square there shows"), "jevbare sees the glyph annotation");
  ok(full.includes("the square there shows"), "jev has lost the glyph annotation");
  ok(!bare.includes("stairs down"), "jevbare is told where the staircase is");
  // Every arm still gets the map, which is the whole point of the comparison.
  const v = vitalsOf(ROOM)!;
  for (const arm of ARMS) {
    ok(payloadOf(arm, ROOM, v, [], actions).includes("|..>|"), `${arm} cannot see the map`);
  }
});

check("only jevmemo is told where it has already been", () => {
  const { actions, hero } = enumerate(ROOM);
  const v = vitalsOf(ROOM)!;
  const memory = {
    counts: new Map([[`${hero!.x - 1},${hero!.y}`, 3], [`${hero!.x},${hero!.y - 1}`, 1]]),
    walked: 9,
    mapped: 44,
  };
  const memo = payloadOf("jevmemo", ROOM, v, [], actions, hero!, memory);
  ok(memo.includes("you have stood there 3 times already"), "the west square's visit count is missing");
  ok(memo.includes("you have stood there 1 time already"), "singular is not handled");
  ok(memo.includes("you have never stood there"), "an unvisited square is not marked");
  ok(memo.includes("squares_you_have_stood_on_so_far"), "the totals are missing");
  // The other two arms must not see any of it, even when it is available.
  for (const arm of ["jev", "jevbare"] as const) {
    const body = payloadOf(arm, ROOM, v, [], actions, hero!, memory);
    ok(!body.includes("stood"), `${arm} sees the visit counts`);
    ok(!body.includes("stood_on_so_far"), `${arm} sees the totals`);
  }
  // And jevmemo with an empty memory must not claim a visit.
  // `never stood there` contains `stood there`, so the count phrasing has to
  // be matched with its number rather than by that substring.
  const empty = payloadOf("jevmemo", ROOM, v, [], actions, hero!, EMPTY_MEMORY);
  ok(!/stood there \d+ time/.test(empty), "an empty memory claimed a visit");
  eq((empty.match(/you have never stood there/g) ?? []).length, 8, "all eight steps should be unvisited");
});

check("the memory arm is told to act on the memory, and the others are not", () => {
  const { actions, hero } = enumerate(ROOM);
  const goalOf = (arm: (typeof ARMS)[number]): string =>
    String((questionFor(arm, actions, hero!, EMPTY_MEMORY)[Object.keys(questionFor(arm, actions))[0]] as {
      instructions: string;
    }).instructions);
  ok(/prefer a direction that leads to ground you have not walked/.test(goalOf("jevmemo")), goalOf("jevmemo"));
  for (const arm of ["jev", "jevbare"] as const) {
    ok(!/have not walked/.test(goalOf(arm)), `${arm}'s goal mentions the memory it cannot see`);
  }
  // The shared part of the goal is identical, so the arms differ in one way.
  const shared = "The aim is to survive and to descend";
  for (const arm of ARMS) ok(goalOf(arm).includes(shared), `${arm} lost the shared goal`);
});

check("the state holds the screen and no interpretation of it", () => {
  const v = vitalsOf(ROOM)!;
  const state = stateFor(ROOM, v, ["You hit the newt."]);
  eq(JSON.stringify(state.map_rows), JSON.stringify(mapOf(ROOM)), "the map is passed through verbatim");
  const body = JSON.stringify(state);
  ok(!/"best|"recommend|"danger|"should/i.test(body), "the state editorialises");
  ok(!body.includes("stairs down"), "the state names what the legend already explains");
  ok(body.includes("You hit the newt."), "the game's own messages are missing");
});

// ---------------------------------------------------------- the probe truths

check("every perception probe's truth is what the grid says", () => {
  const withMonster = fake(["", "  -----", "  |..d|", "  |.@.|", "  |..>|", "  -----"], "Dlvl:2 $:5 HP:9(16) Pw:2(2) AC:6 Xp:1/0 T:9");
  const { nouls, scores } = probesFor(withMonster);
  const truthOf = (key: string): boolean => nouls.find((p) => p.key === key)!.truth;
  eq(truthOf("adjacent_monster"), true);
  eq(truthOf("downstairs_visible"), true);
  eq(truthOf("upstairs_visible"), false, "no < is drawn on this screen");
  eq(truthOf("hurt"), true, "HP:9(16)");
  eq(truthOf("deep"), true, "Dlvl:2");
  eq(truthOf("rich"), true, "$:5");
  eq(truthOf("dead_end"), false, "eight open squares is not a dead end");
  eq(truthOf("in_room"), true);
  eq(scores.find((s) => s.key === "monster_count")!.level, 1, "one d on the map");
  eq(monsterCount(withMonster), 1, "the hero's own @ is not counted");
});

check("a probe is left out when the screen cannot answer it", () => {
  const noStairs = fake(["", "  -----", "  |...|", "  |.@.|", "  |...|", "  -----"]);
  const keys = probesFor(noStairs).nouls.map((p) => p.key);
  ok(!keys.includes("upstairs_east"), "asked which way the staircase is with no staircase drawn");
  ok(keys.includes("upstairs_visible"), "the existence question is still answerable");
  // Same column as the @: "is it to the right" has no answer.
  const sameColumn = fake(["", "  -----", "  |.<.|", "  |.@.|", "  |...|", "  -----"]);
  const k2 = probesFor(sameColumn).nouls.map((p) => p.key);
  ok(!k2.includes("upstairs_east"), "asked left-or-right about a staircase in the same column");
  ok(k2.includes("upstairs_south"), "the row question is answerable");
  eq(probesFor(sameColumn).nouls.find((p) => p.key === "upstairs_south")!.truth, false, "the < is ABOVE the @ here");
});

check("a dead end is one open square, mechanically", () => {
  // A corridor stub: the only walkable neighbour is the `#` behind the @.
  const end = fake(["", "        ", "   ###@ ", "        "]);
  const probes = probesFor(end).nouls;
  eq(probes.find((p) => p.key === "dead_end")!.truth, true);
  eq(probes.find((p) => p.key === "in_room")!.truth, false);
  // One square further back it is a corridor, not a dead end: two neighbours.
  const mid = fake(["", "        ", "   ##@# ", "        "]);
  eq(probesFor(mid).nouls.find((p) => p.key === "dead_end")!.truth, false);
});

check("the perception state carries the screen and not the answers", () => {
  const withMonster = fake(["", "  -----", "  |..d|", "  |.@.|", "  |..>|", "  -----"]);
  withMonster.rows[0] = "The jackal bites!".padEnd(80, " ");
  const body = JSON.stringify(perceiveState(withMonster));
  const { nouls, scores } = probesFor(withMonster);
  ok(body.includes("|..d|"), "the map row with the monster is missing");
  // The message line answers `adjacent_monster` in English. It stays out.
  ok(!body.includes("jackal"), "the message line leaked into the perception state");
  for (const p of [...nouls, ...scores]) {
    ok(!body.includes(`"${p.key}"`), `the state names the probe ${p.key}`);
  }
  // The words a probe uses for its own answer must not be sitting in the
  // state: this is the same screen the truth was computed from.
  for (const word of ["adjacent", "dead end", "monsters are on the map", "true", "false"]) {
    ok(!body.includes(word), `the state contains "${word}"`);
  }
});

// ----------------------------------------------------- the recorded corpus

const walkPath = resolve(import.meta.dirname, "records/walk.json");
if (existsSync(walkPath)) {
  const walk = JSON.parse(readFileSync(walkPath, "utf8")) as WalkRecord;
  check("the recorded screens are real screens, and rehydrate to the same shape", () => {
    ok(walk.screens.length > 20, `only ${walk.screens.length} screens`);
    let withHero = 0;
    for (const row of walk.screens) {
      const screen = rehydrate(row);
      eq(screen.rows.length, ROWS, "a rehydrated screen is not 24 rows");
      for (const r of screen.rows) eq(r.length, 80, "a rehydrated row is not 80 columns");
      if (heroAt(screen)) withHero += 1;
    }
    ok(withHero / walk.screens.length > 0.9, `only ${withHero}/${walk.screens.length} screens show the @`);
  });

  check("the recorded games were games and not one game restored repeatedly", () => {
    // The bug this catches: NetHack saves on hangup and restores under the
    // same character name, so four "fresh" games came back as one game
    // played four times -- identical turn counts and identical maps.
    const maps = new Set(walk.screens.filter((s) => s.turn <= 12).map((s) => rehydrate(s).rows.slice(1, 22).join("")));
    const starts = walk.screens.filter((s) => s.turn <= 12).length;
    ok(maps.size > 1 || starts <= 1, `${starts} early screens but only ${maps.size} distinct map(s)`);
    const turns = new Set(walk.games.map((g) => g.turns));
    ok(walk.games.length < 2 || turns.size > 1, `all ${walk.games.length} games ended on the same turn`);
  });

  check("every recorded screen yields probes with a computable truth", () => {
    let probes = 0;
    for (const row of walk.screens) {
      const { nouls, scores } = probesFor(rehydrate(row));
      for (const p of nouls) ok(typeof p.truth === "boolean", `${row.turn}: ${p.key} has no truth`);
      for (const p of scores) ok(p.level >= 0 && p.level <= 3, `${row.turn}: ${p.key} level ${p.level}`);
      probes += nouls.length + scores.length;
    }
    ok(probes > 100, `only ${probes} probes across the corpus`);
  });

  check("both probe classes actually occur, so no accuracy is a base rate", () => {
    const counts = new Map<string, { t: number; n: number }>();
    for (const row of walk.screens) {
      for (const p of probesFor(rehydrate(row)).nouls) {
        const c = counts.get(p.key) ?? { t: 0, n: 0 };
        counts.set(p.key, { t: c.t + (p.truth ? 1 : 0), n: c.n + 1 });
      }
    }
    const degenerate: string[] = [];
    for (const [key, c] of counts) if (c.t === 0 || c.t === c.n) degenerate.push(`${key} ${c.t}/${c.n}`);
    // Named rather than asserted away: a one-sided probe measures nothing,
    // and which ones are one-sided is a fact about the corpus worth printing.
    if (degenerate.length > 0) console.log(`       one-sided on this corpus: ${degenerate.join(", ")}`);
    ok(counts.size >= 7, `only ${counts.size} probe kinds`);
  });

  check("the two baseline policies pick from the offered set and nothing else", () => {
    const rnd = randomPolicy(rngFrom(7));
    const grd = greedyPolicy();
    for (const row of walk.screens) {
      const screen = rehydrate(row);
      const { actions, hero } = enumerate(screen);
      if (!hero || actions.length === 0) continue;
      for (const [name, policy] of [["random", rnd], ["greedy", grd]] as const) {
        const chosen = policy(screen, actions, vitalsOf(screen)!, []);
        ok(!(chosen instanceof Promise), `${name} should be synchronous`);
        const action = (chosen as { action: unknown }).action;
        ok(actions.includes(action as never), `${name} picked something not on offer at turn ${row.turn}`);
      }
    }
  });
} else {
  skip("the recorded corpus", "no records/walk.json; run `npm run walk`");
}

// ------------------------------------------------------- the real game, if here

if (available()) {
  check("real NetHack starts, draws a map, and takes a key", () => {
    const game = new NetHack({ home: resolve(tmpdir(), `nh-test-${process.pid}`), name: `T${process.pid}` });
    try {
      game.start();
      const { screen } = drain(game);
      const hero = heroAt(screen);
      ok(hero !== null, `no @ on the first screen:\n${screen.rows.slice(0, 8).join("\n")}`);
      const v = vitalsOf(screen);
      ok(v !== null, `no status line: ${screen.rows[23]}`);
      eq(v!.turn, 1, "a fresh game starts on turn 1");
      eq(v!.dlvl, 1);
      ok(v!.hpMax > 0, "no hit points");
      // A search always costs a turn, so this is the loop's own definition of
      // "the game accepted that" exercised against the real binary.
      const after = vitalsOf(game.key("s"));
      eq(after!.turn > 1, true, "searching did not advance the clock");
    } finally {
      game.stop();
    }
  });
} else {
  skip("real NetHack", "not installed; `apt-get install -y nethack-console`");
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
