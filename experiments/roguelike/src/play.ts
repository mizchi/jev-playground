/**
 * One turn of NetHack, and the two baselines a policy has to beat.
 *
 * The important mechanical definition is REFUSED. NetHack charges no game
 * time for an action it will not perform -- walking into a wall, `>` off the
 * stairs, `,` on an empty square all leave `T:` where it was. So "the game
 * refused this" is exactly "the turn counter did not move", read off the
 * status line, with no string matching and no list of refusal messages to
 * keep in sync with the game. Every action this harness offers costs a turn
 * when it is accepted, which is what makes the test sound.
 */
import { type Screen, type Vitals, NetHack, heroAt, mapOf, vitalsOf } from "./nethack.js";
import { type Action, type Dir, DIRS, distances, enumerate, frontiers, reachable, stepToward } from "./actions.js";

export interface Step {
  key: string;
  name: string;
  /** The turn counter before and after. Equal means the game refused it. */
  turnBefore: number;
  turnAfter: number;
  refused: boolean;
  message: string;
  died: boolean;
  vitals: Vitals | null;
}

const MORE = /--More--/;
const MENU = /\((?:end|\d+ of \d+)\)\s*$/m;

/**
 * Clear whatever the game is asking before the next action.
 *
 * Every branch here is a REFUSAL of something optional. The harness never
 * answers a question in a way that advances the game: `--More--` is
 * acknowledged, a yes/no is declined, a menu and a direction prompt are
 * escaped. Anything that actually happens in a game has to come from a
 * chosen action, or the harness would be playing too.
 */
export function drain(game: NetHack, opts: { eatLetter?: boolean } = {}): { screen: Screen; messages: string[] } {
  const messages: string[] = [];
  let screen = game.settle();
  for (let i = 0; i < 24; i += 1) {
    if (game.processGone) return { screen, messages };
    const msg = screen.rows[0].trim();
    if (msg) messages.push(msg.replace(MORE, "").trim());
    if (MORE.test(msg)) {
      screen = game.key(" ");
      continue;
    }
    // Choosing food is the one prompt with a real answer, because `eat` is a
    // real action and refusing it would make hunger unsurvivable. The letter
    // comes from the prompt's own offer list.
    const food = /want to eat\?\s*\[([a-zA-Z]+)/.exec(msg);
    if (food && opts.eatLetter) {
      screen = game.key(food[1][0]);
      continue;
    }
    if (/\[ynq|\[yn\b|\[ynaq/.test(msg)) {
      screen = game.key(/\[yn\b/.test(msg) ? "n" : "q");
      continue;
    }
    if (/In what direction|^What do you want|^Pick up what|^Things that are here/i.test(msg) || MENU.test(screen.rows.join("\n"))) {
      screen = game.key("\x1b");
      continue;
    }
    break;
  }
  return { screen, messages };
}

export function act(game: NetHack, action: Action): Step {
  const before = vitalsOf(game.screen());
  const turnBefore = before?.turn ?? 0;
  game.key(action.key);
  const { screen, messages } = drain(game, { eatLetter: action.key === "e" });
  const gone = game.processGone;
  const after = vitalsOf(screen);
  const turnAfter = after?.turn ?? turnBefore;
  const message = messages.filter(Boolean).join(" | ");
  return {
    key: action.key,
    name: action.name,
    turnBefore,
    turnAfter,
    refused: !gone && turnAfter === turnBefore,
    message,
    died: gone || /You die|Do you want your possessions|Goodbye |DYWYPI/i.test(message),
    vitals: after,
  };
}

// -------------------------------------------------------------- the loop

export interface StepRow {
  turn: number;
  key: string;
  name: string;
  /** How many actions were on offer when this one was picked. */
  offered: number;
  refused: boolean;
  hp: number;
  dlvl: number;
  xp: number;
  /** Set by the judgment arm; absent for the baselines. */
  confidence?: number;
  /**
   * Where the `@` was when this action was chosen.
   *
   * Recorded because it was NOT, and docs/06's homework (b) asked whether the
   * refusals cluster at the map's edge -- a question this loop had the answer
   * to all along (`probe.hero` is computed every step, for the visit counts)
   * and threw away. `src/refusals.ts` answers what the old records can still
   * answer; the positional half needed this field and a re-run.
   */
  x?: number;
  y?: number;
}

export interface GameRow {
  policy: string;
  seed: number;
  /** Game turns reached, which is not the number of actions: refusals are free. */
  turns: number;
  actions: number;
  refused: number;
  maxDlvl: number;
  xp: number;
  score: number;
  hp: number;
  gold: number;
  died: boolean;
  /** Choices that named something outside the offered set. Structurally zero. */
  illegal: number;
  /**
   * Map cells that are no longer blank at the end, and distinct squares the
   * hero stood on.
   *
   * These exist because `maxDlvl` turned out to be a dead metric at any
   * affordable budget: NetHack's down staircase is typically several hundred
   * turns of exploration away, so every policy ends the run on Dlvl 1 and
   * the comparison would rest on nothing. Coverage is progress that is
   * visible after two hundred actions, and it is read off the screen with no
   * interpretation -- a cell is blank or it is not.
   */
  explored: number;
  visited: number;
  steps: StepRow[];
}

export interface Choice {
  /** Null when the chooser named something outside the offered set. */
  action: Action | null;
  confidence?: number;
}

/**
 * Sync for the baselines, a promise for the arm that asks over the network.
 *
 * One signature rather than two loops. A second copy of the loop for the
 * async arm would have drifted -- the refusal memory, the hunger flag and
 * the stopping rule all live in it, and a difference in any of those between
 * the baseline and the judgment arm would not be visible in the numbers, it
 * would BE the numbers.
 */
export interface Seen {
  /** "x,y" -> how many times the hero has stood there. */
  counts: ReadonlyMap<string, number>;
  walked: number;
  mapped: number;
}

export type Policy = (
  screen: Screen,
  actions: Action[],
  vitals: Vitals,
  recent: string[],
  seen: Seen,
) => Choice | Promise<Choice>;

/**
 * One game, whoever is choosing.
 *
 * The baselines and the judgment arms share this function on purpose: the
 * refusal memory, the prompt draining, the hunger handling and the stopping
 * rule are then provably the same for all of them, and the only difference
 * between two arms is the `policy` argument.
 */
export async function playGame(opts: {
  policy: Policy;
  name: string;
  label: string;
  seed: number;
  maxActions: number;
  home: string;
  onScreen?: (screen: Screen, turn: number) => void;
  onStep?: (step: Step, row: StepRow) => void;
}): Promise<GameRow> {
  const game = new NetHack({ home: opts.home, name: opts.name });
  const row: GameRow = {
    policy: opts.label,
    seed: opts.seed,
    turns: 0,
    actions: 0,
    refused: 0,
    maxDlvl: 1,
    xp: 0,
    score: 0,
    hp: 0,
    gold: 0,
    died: false,
    illegal: 0,
    explored: 0,
    visited: 0,
    steps: [],
  };
  const counts = new Map<string, number>();
  try {
    game.start();
    let { screen } = drain(game);
    let refusedHere = new Set<string>();
    let where = "";
    const recent: string[] = [];
    for (let i = 0; i < opts.maxActions; i += 1) {
      const vitals = vitalsOf(screen);
      if (!vitals || game.processGone) break;
      const hungry = vitals.flags.some((f) => /Hungry|Weak|Fainting/.test(f));
      const probe = enumerate(screen, { hungry });
      if (!probe.hero) {
        // No `@` anywhere: a full-screen message the drain did not clear.
        screen = game.key("\x1b");
        continue;
      }
      const spot = `${probe.hero.x},${probe.hero.y}`;
      counts.set(spot, (counts.get(spot) ?? 0) + 1);
      // Taken as the run goes rather than at the end: a death replaces the
      // map with a tombstone, and the last screen of a game is then the one
      // screen that cannot answer how much of the level was mapped.
      row.explored = Math.max(row.explored, exploredCells(screen));
      const here = `${probe.hero.x},${probe.hero.y},${vitals.turn}`;
      if (here !== where) {
        refusedHere = new Set();
        where = here;
      }
      const { actions } = enumerate(screen, { hungry, exclude: refusedHere });
      if (opts.onScreen) opts.onScreen(screen, vitals.turn);
      const chosen = await opts.policy(screen, actions, vitals, recent, {
        counts,
        walked: counts.size,
        mapped: row.explored,
      });
      if (!chosen.action) {
        // Named something outside the offered set. A `choice` cannot do this;
        // it is counted rather than assumed away.
        row.illegal += 1;
        continue;
      }
      const step = act(game, chosen.action);
      row.actions += 1;
      if (step.message) recent.push(step.message);
      if (step.refused) {
        row.refused += 1;
        refusedHere.add(step.key);
      }
      const stepRow: StepRow = {
        turn: step.turnAfter,
        key: step.key,
        name: step.name,
        offered: actions.length,
        refused: step.refused,
        hp: step.vitals?.hp ?? 0,
        dlvl: step.vitals?.dlvl ?? 0,
        xp: step.vitals?.xp ?? 0,
        x: probe.hero.x,
        y: probe.hero.y,
        ...(chosen.confidence === undefined ? {} : { confidence: chosen.confidence }),
      };
      row.steps.push(stepRow);
      if (opts.onStep) opts.onStep(step, stepRow);
      if (step.vitals) {
        row.turns = step.vitals.turn;
        row.maxDlvl = Math.max(row.maxDlvl, step.vitals.dlvl);
        row.xp = step.vitals.xp;
        row.score = step.vitals.score;
        row.hp = step.vitals.hp;
        row.gold = step.vitals.gold;
      }
      if (step.died) {
        row.died = true;
        break;
      }
      screen = game.screen();
    }
    row.visited = counts.size;
  } finally {
    game.stop();
  }
  return row;
}

/** Map cells that have been drawn as something. No interpretation. */
export function exploredCells(screen: Screen): number {
  let n = 0;
  for (const row of mapOf(screen)) for (const ch of row) if (ch !== " ") n += 1;
  return n;
}

// --------------------------------------------------------------- baselines

/** A deterministic 32-bit generator, so a baseline game replays exactly. */
export function rngFrom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/** Uniform over the same set the judgment arm is offered. Nothing else. */
export function randomPolicy(rng: () => number): Policy {
  return (_screen, actions) => ({ action: actions[Math.floor(rng() * actions.length)] });
}

/**
 * A real explorer: fight what is next to you, take the stairs when you find
 * them, otherwise walk to the nearest square that touches unexplored ground.
 *
 * Written to be a STRONG baseline rather than a straw one, because "Jev can
 * play NetHack" means nothing against a bot that walks into walls. It uses
 * the same breadth-first search over the same classified grid the enumerator
 * uses, so the only difference between this and the judgment arm is who
 * picks.
 */
export function greedyPolicy(): Policy {
  // The committed target is what makes this an explorer rather than a
  // pendulum. Recomputing "the nearest frontier" every step and walking one
  // square toward it looks right and is not: one step changes which frontier
  // is nearest, so the bot walks back. It spent five hundred turns going
  // `east west east west` inside the first room, never finding the
  // staircase, and the trace is the only reason that was visible -- the
  // summary line said five hundred turns and nothing refused, which reads
  // like a bot doing fine.
  let target: { x: number; y: number } | null = null;
  let age = 0;
  // Squares the bot has stood on. A blank still next to one of them is rock,
  // not somewhere to go -- see `frontiers`.
  const visited = new Set<string>();
  const triedDescend = new Set<string>();
  return (screen, actions) => {
    const pick = (a: Action | undefined): Choice => ({ action: a ?? actions[actions.length - 1] });
    const byKey = (k: string): Action | undefined => actions.find((a) => a.key === k);
    const dirAction = (dir: Dir): Action | undefined => actions.find((a) => a.dir?.key === dir.key);
    const hero = heroAt(screen);
    if (!hero) return pick(byKey("s"));
    visited.add(`${hero.x},${hero.y}`);
    // 1. Something adjacent. A Valkyrie wins most of these. The pet is drawn
    //    exactly like a wild animal, so this attacks it too -- NetHack then
    //    asks, the harness declines, and the refusal memory drops the move.
    const adjacent = DIRS.map(dirAction).filter(
      (a): a is Action => a !== undefined && / = monster/.test(a.says) && !/refuses diagonal/.test(a.says),
    );
    if (adjacent.length > 0) {
      target = null;
      return pick(adjacent[0]);
    }
    // 2. Reachable stairs outrank exploring. Distance zero means the `@` is
    //    standing on them, which the screen never says outright, so `>` gets
    //    pressed on faith.
    const stairs = reachable(screen, (k) => k === "stairs down");
    if (stairs.length > 0) {
      if (stairs[0].d === 0) return pick(byKey(">") ?? byKey("s"));
      target = stairs[0];
      age = 0;
    }
    const dist = distances(screen, hero);
    const stale = (t: { x: number; y: number }): boolean => dist[t.y][t.x] <= 0 || age > 80;
    if (target && stale(target)) target = null;
    if (!target) {
      age = 0;
      target = frontiers(screen, { exclude: visited }).find((f) => f.d > 0) ?? null;
    }
    if (target) {
      age += 1;
      const dir = stepToward(screen, target);
      if (dir && dirAction(dir)) return pick(dirAction(dir));
      target = null;
    }
    // 3. Nothing to fight and nowhere left to walk: either we are standing on
    //    the staircase without knowing it, or there is a hidden passage.
    //    `>` is worth ONE try per square -- the refusal memory forgets it as
    //    soon as a search advances the clock, and without this the bot
    //    alternated `descend search descend search` for eighty actions.
    const spot = `${hero.x},${hero.y}`;
    if (stairs.length === 0 && byKey(">") && !triedDescend.has(spot)) {
      triedDescend.add(spot);
      return pick(byKey(">"));
    }
    return pick(byKey("s"));
  };
}
