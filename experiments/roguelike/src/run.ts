/**
 * Real NetHack, driven by judgment.
 *
 *   npx tsx src/run.ts --replay                       # tables, no API key
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts --perceive
 *   TYPESAFEAI_API_KEY=... npx tsx src/run.ts --play --games 3 --actions 200
 *
 * Two measurements, kept apart:
 *
 *   §1 perception  mechanically-answerable questions about a recorded
 *                  screen. The status-line questions are the control: they
 *                  are ordinary text, so if they are right and the map ones
 *                  are wrong, the failure is two-dimensional layout.
 *   §2 policy      a game, one request per action, against a uniform
 *                  baseline and a breadth-first explorer.
 *
 * `--play` writes games one at a time and flushes after each, because a run
 * is minutes long and a crash three games in should not throw away the ones
 * that finished.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Jev, type Answer } from "../../shared/jev.js";
import { confusion, place, separation, type Sample } from "../../shared/thresholds.js";
import { ROWS, available, heroAt, type Screen } from "./nethack.js";
import { enumerate } from "./actions.js";
import { type GameRow, type Policy, greedyPolicy, playGame, randomPolicy, rngFrom } from "./play.js";
import { type Band, probesFor, stateFor as perceiveState } from "./perceive.js";
import { ARMS, ARM_BLURB, MOVE, type ArmName, questionFor, stateFor } from "./arms.js";
import type { ScreenRow, WalkRecord } from "./walk.js";

const RECORDS = resolve(import.meta.dirname, "../records");

// --------------------------------------------------------------- record types

export interface ProbeRow {
  key: string;
  band: Band;
  /** True/false probes only. */
  truth: boolean;
  /** The noul probability, or the raw `score`. */
  answer: number;
  /**
   * The true level, for the one `score` probe.
   *
   * Kept separately because a `score` answer is NOT an integer: the counting
   * probe came back 1.34, 1.13, 1.08 and so on, and comparing that to a
   * level with `===` scored 0 out of 244 -- which looked like a result about
   * counting and was a result about my comparison. The level is recorded so
   * the score can be analysed as the continuous thing it is.
   */
  level?: number;
  confidence?: number;
}

export interface PerceiveRow {
  game: number;
  turn: number;
  policy: string;
  probes: ProbeRow[];
}

export interface PerceiveRecord {
  model: string;
  screens: PerceiveRow[];
  usage: { input: number; output: number; calls: number; ms: number };
}

export interface PlayRecord {
  model: string;
  games: GameRow[];
  usage: { input: number; output: number; calls: number; ms: number };
}

function readJson<T>(name: string): T | null {
  const path = resolve(RECORDS, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

/** A recorded screen back into the shape the code reads. */
export function rehydrate(row: ScreenRow): Screen {
  const rows = Array.from({ length: ROWS }, (_, i) => (row.rows[i] ?? "").padEnd(80, " ").slice(0, 80));
  return { rows, message: rows[0].trim(), status: `${rows[22].trim()} ${rows[23].trim()}`.trim() };
}

// ------------------------------------------------------------------ §1 perceive

async function perceive(limit: number): Promise<void> {
  const walk = readJson<WalkRecord>("walk.json");
  if (!walk) throw new Error("no records/walk.json; run `npx tsx src/walk.ts` first");
  const jev = new Jev();
  const out: PerceiveRecord = { model: jev.model, screens: [], usage: { input: 0, output: 0, calls: 0, ms: 0 } };
  const screens = walk.screens.slice(0, limit);
  for (const [i, row] of screens.entries()) {
    const screen = rehydrate(row);
    const { nouls, scores } = probesFor(screen);
    if (nouls.length === 0) continue;
    const questions = Object.fromEntries([
      ...nouls.map((p) => [p.key, p.question] as const),
      ...scores.map((p) => [p.key, p.question] as const),
    ]);
    const res = await jev.ask(perceiveState(screen), questions);
    const probes: ProbeRow[] = [];
    for (const p of nouls) {
      const a = res.answers[p.key] as Answer & { noul?: number };
      probes.push({ key: p.key, band: p.band, truth: p.truth, answer: a.noul ?? Number.NaN });
    }
    for (const p of scores) {
      const a = res.answers[p.key];
      if (a.type !== "score") continue;
      probes.push({
        key: p.key,
        band: p.band,
        truth: Math.round(a.score) === p.level,
        answer: a.score,
        level: p.level,
        confidence: a.confidence,
      });
    }
    out.screens.push({ game: row.game, turn: row.turn, policy: row.policy, probes });
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${screens.length} screens`);
  }
  out.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(
    resolve(RECORDS, "perceive.json"),
    `{\n"model": ${JSON.stringify(out.model)},\n"usage": ${JSON.stringify(out.usage)},\n"screens": [\n${out.screens
      .map((s) => JSON.stringify(s))
      .join(",\n")}\n]\n}\n`,
  );
  console.log(`  ${out.screens.length} screens, ${jev.calls} requests -> records/perceive.json`);
}

// --------------------------------------------------------------- §2 the policy

/**
 * The judgment policy: one request, one `choice`, one action.
 *
 * `action: null` is the illegal case -- a `choice` naming something outside
 * its own criteria. It cannot happen, which is the point; docs/03 found the
 * same thing for chess and this re-checks it where the option set changes
 * every turn and is built from a picture rather than from a rules engine.
 * The count is kept anyway, because an unmeasured zero is an assumption.
 */
export function jevPolicy(jev: Jev, arm: ArmName): Policy {
  return async (screen, actions, vitals, recent, seen) => {
    const hero = heroAt(screen) ?? undefined;
    // The three arms that carry visit counts get the memory; `jevintent`
    // deliberately does not, because it is the sentence WITHOUT the memory.
    const memory =
      arm === "jevmemo" || arm === "jevcount" || arm === "jevcountguard" || arm === "jevmemoraw" ? seen : undefined;
    const res = await jev.ask(
      stateFor(screen, vitals, recent, memory),
      questionFor(arm, actions, hero, memory, screen),
    );
    const answer = res.answers[MOVE];
    if (answer.type !== "choice") throw new Error(`expected a choice, got ${answer.type}`);
    return {
      action: actions.find((a) => a.name === answer.choice) ?? null,
      confidence: answer.confidence,
    };
  };
}

async function play(games: number, maxActions: number, arms: ArmName[], withBaselines: boolean): Promise<void> {
  const jev = new Jev();
  const prior = readJson<PlayRecord>("play.json");
  const out: PlayRecord = {
    model: jev.model,
    games: prior && prior.model === jev.model ? prior.games.filter((g) => !arms.includes(g.policy as ArmName)) : [],
    usage: { input: 0, output: 0, calls: 0, ms: 0 },
  };
  const flush = (): void => {
    out.usage = { input: jev.inputTokens, output: jev.outputTokens, calls: jev.calls, ms: jev.totalMs };
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(
      resolve(RECORDS, "play.json"),
      `{\n"model": ${JSON.stringify(out.model)},\n"usage": ${JSON.stringify(out.usage)},\n"games": [\n${out.games
        .map((g) => JSON.stringify(g))
        .join(",\n")}\n]\n}\n`,
    );
  };
  // Each lane builds its policy PER GAME rather than once. The explorer
  // carries a visited set and a committed target, and reusing one instance
  // across games would have game two start out believing it had already
  // walked game one's map.
  const lane: { label: string; fresh: (seed: number) => Policy; prefix: string; offset: number }[] = [];
  if (withBaselines) {
    lane.push({ label: "random", fresh: (seed) => randomPolicy(rngFrom(seed)), prefix: "Rnd", offset: 100 });
    lane.push({ label: "greedy", fresh: () => greedyPolicy(), prefix: "Grd", offset: 200 });
  }
  for (const arm of arms) {
    lane.push({
      label: arm,
      fresh: () => jevPolicy(jev, arm),
      prefix: { jev: "Jev", jevbare: "Bare", jevmemo: "Memo", jevcount: "Cnt", jevcountguard: "CGd", jevintent: "Int", jevmemoraw: "Raw" }[
        arm
      ],
      // A distinct offset per arm so each gets its own seeds and no two arms
      // are compared on the same dungeon by accident.
      offset: { jev: 300, jevbare: 400, jevmemo: 500, jevcount: 600, jevcountguard: 650, jevintent: 700, jevmemoraw: 800 }[arm],
    });
  }
  for (const l of lane) {
    for (let g = 0; g < games; g += 1) {
      const seed = 4000 + l.offset + g;
      const row = await playGame({
        policy: l.fresh(seed),
        label: l.label,
        name: `${l.prefix}${seed}`,
        seed,
        maxActions,
        home: resolve(tmpdir(), `nh-${l.label}-${seed}-${process.pid}`),
      });
      out.games = out.games.filter((x) => !(x.policy === l.label && x.seed === seed)).concat(row);
      console.log(
        `  ${l.label} ${seed}: T:${row.turns} Dlvl ${row.maxDlvl} Xp ${row.xp} ` +
          `refused ${row.refused}/${row.actions} illegal ${row.illegal}${row.died ? " died" : ""}`,
      );
      flush();
    }
  }
  console.log(`  ${jev.calls} requests, ${jev.inputTokens} input tokens -> records/play.json`);
}

// ------------------------------------------------------------------- reporting

const pct = (a: number, b: number): string => (b === 0 ? "   -  " : `${((100 * a) / b).toFixed(0).padStart(4)}%`);

function reportPerceive(rec: PerceiveRecord): void {
  const flat = rec.screens.flatMap((s) => s.probes);
  const keys = [...new Set(flat.map((p) => p.key))];
  console.log(`\n§1 perception -- ${rec.screens.length} real NetHack screens, ${rec.usage.calls} requests\n`);
  // The per-class columns are not decoration. Several of these probes are
  // lopsided on a real corpus -- objects are lying around on nearly every
  // NetHack screen -- and on a lopsided probe plain accuracy is mostly the
  // base rate. "right when it is true" and "right when it is false" cannot
  // both be high for an arm that is just guessing the common answer.
  console.log("  probe                band     n   true   correct   on true   on false    AUC   at best cut");
  const byBand = new Map<Band, { hit: number; n: number; tHit: number; t: number; fHit: number; f: number }>();
  const scoreRows = flat.filter((p) => p.level !== undefined);
  for (const key of keys) {
    const rows = flat.filter((p) => p.key === key && p.level === undefined);
    if (rows.length === 0) continue;
    const band = rows[0].band;
    const right = (p: ProbeRow): boolean => p.truth === p.answer > 0.5;
    const yes = rows.filter((p) => p.truth);
    const no = rows.filter((p) => !p.truth);
    const hit = rows.filter(right).length;
    const samples: Sample[] = rows.map((p) => ({ value: p.answer, positive: p.truth }));
    const sep = separation(samples);
    const usable = sep.pos > 0 && sep.neg > 0;
    // Accuracy at 0.5 and accuracy at the best cut are different questions.
    // `downstairs_visible` reads 43% at 0.5 with an AUC of 0.891: the answers
    // separate the two classes almost perfectly and simply sit on the wrong
    // side of the halfway mark. Reporting only the first would call that
    // "cannot see the staircase" when it is a calibration offset (docs/25).
    const cut = usable ? place(samples, { rule: "youden" }) : null;
    const best = cut && cut.fittable ? confusion(samples, cut.at) : null;
    const acc = byBand.get(band) ?? { hit: 0, n: 0, tHit: 0, t: 0, fHit: 0, f: 0 };
    byBand.set(band, {
      hit: acc.hit + hit,
      n: acc.n + rows.length,
      tHit: acc.tHit + yes.filter(right).length,
      t: acc.t + yes.length,
      fHit: acc.fHit + no.filter(right).length,
      f: acc.f + no.length,
    });
    console.log(
      `  ${key.padEnd(20)} ${band.padEnd(7)} ${String(rows.length).padStart(3)}  ` +
        `${pct(yes.length, rows.length)}   ${pct(hit, rows.length)}    ` +
        `${pct(yes.filter(right).length, yes.length)}     ${pct(no.filter(right).length, no.length)}   ` +
        `${usable ? sep.auc.toFixed(3) : "  -  "}   ` +
        `${best ? `${pct(best.tp + best.tn, best.n)} @ ${cut!.at.toFixed(2)}` : "     -"}`,
    );
  }
  console.log("\n  band                 n   correct   on true   on false");
  for (const band of ["status", "local", "global"] as Band[]) {
    const b = byBand.get(band);
    if (b) {
      console.log(
        `  ${band.padEnd(12)} ${String(b.n).padStart(6)}   ${pct(b.hit, b.n)}    ` +
          `${pct(b.tHit, b.t)}     ${pct(b.fHit, b.f)}`,
      );
    }
  }
  // The one `score` probe, analysed as the continuous thing it is: does the
  // answer MOVE with the true count, never mind whether it lands on the
  // level. If it does not move, counting glyphs across a 21x80 picture is
  // the thing that failed, and that is worth separating from arithmetic.
  if (scoreRows.length > 0) {
    console.log(`\n  the counting probe (a score, so the answer is continuous)\n`);
    console.log("  true monsters      n   mean score   rounds to the right level");
    const levels = [...new Set(scoreRows.map((p) => p.level!))].sort();
    for (const level of levels) {
      const mine = scoreRows.filter((p) => p.level === level);
      const label = level === 3 ? "three or more" : `${["none", "one", "two"][level]}`;
      console.log(
        `  ${label.padEnd(15)} ${String(mine.length).padStart(4)}   ` +
          `${(mine.reduce((a, b) => a + b.answer, 0) / mine.length).toFixed(3).padStart(10)}   ` +
          `${pct(mine.filter((p) => p.truth).length, mine.length)}`,
      );
    }
    const sep = separation(scoreRows.map((p) => ({ value: p.answer, positive: p.level! >= 2 })));
    console.log(
      `\n  AUC of the score against "two or more monsters" = ${sep.auc.toFixed(3)} ` +
        `(${sep.pos} positive, ${sep.neg} negative)`,
    );
  }
  if (rec.usage.calls > 0) {
    console.log(
      `\n  ${rec.usage.calls} requests, ${rec.usage.input} input tokens, ` +
        `$${((rec.usage.input / 1e6) * 0.042).toFixed(4)}, ` +
        `${(rec.usage.ms / rec.usage.calls).toFixed(0)} ms per screen`,
    );
  }
}

function reportPlay(rec: PlayRecord): void {
  console.log(`\n§2 policy -- games of real NetHack, one request per action\n`);
  const policies = [...new Set(rec.games.map((g) => g.policy))];
  // `explored` and `visited` are here because `maxDlvl` is dead at this
  // budget: the down staircase is hundreds of turns away and no policy
  // reaches it, so progress has to be measured as how much of the level got
  // mapped and how much of it the hero actually walked.
  console.log("  policy    games  actions   turns   refused    Xp   mapped  walked   illegal   died");
  for (const p of policies) {
    const gs = rec.games.filter((g) => g.policy === p);
    const sum = (f: (g: GameRow) => number): number => gs.reduce((a, g) => a + f(g), 0);
    const avg = (f: (g: GameRow) => number): number => sum(f) / gs.length;
    console.log(
      `  ${p.padEnd(9)} ${String(gs.length).padStart(5)} ${String(sum((g) => g.actions)).padStart(8)} ` +
        `${avg((g) => g.turns).toFixed(0).padStart(7)}   ` +
        `${pct(sum((g) => g.refused), sum((g) => g.actions))}  ` +
        `${avg((g) => g.xp).toFixed(1).padStart(4)}   ` +
        `${avg((g) => g.explored).toFixed(0).padStart(6)}  ${avg((g) => g.visited).toFixed(0).padStart(6)}   ` +
        `${String(sum((g) => g.illegal)).padStart(7)} ${String(sum((g) => (g.died ? 1 : 0))).padStart(6)}`,
    );
  }
  const deepest = Math.max(...rec.games.map((g) => g.maxDlvl));
  console.log(`\n  deepest dungeon level reached by any policy: ${deepest}`);
  const judged = rec.games.filter((g) => g.steps.some((s) => s.confidence !== undefined));
  if (judged.length > 0) {
    console.log("\n  confidence against whether the game accepted the action");
    for (const arm of ARMS) {
      const steps = judged.filter((g) => g.policy === arm).flatMap((g) => g.steps);
      const samples: Sample[] = steps
        .filter((s) => s.confidence !== undefined)
        .map((s) => ({ value: s.confidence!, positive: !s.refused }));
      if (samples.length === 0) continue;
      const sep = separation(samples);
      console.log(
        `  ${arm.padEnd(9)} n ${String(sep.n).padStart(4)}  accepted ${sep.pos}  refused ${sep.neg}  ` +
          `AUC ${sep.pos > 0 && sep.neg > 0 ? sep.auc.toFixed(3) : "  -  "}`,
      );
    }
  }
  if (rec.usage.calls > 0) {
    const cost = (rec.usage.input / 1e6) * 0.042;
    console.log(
      `\n  ${rec.usage.calls} requests, ${rec.usage.input} input tokens, $${cost.toFixed(4)}, ` +
        `${(rec.usage.ms / Math.max(1, rec.usage.calls)).toFixed(0)} ms per action`,
    );
  }
}

function replay(): void {
  const walk = readJson<WalkRecord>("walk.json");
  const perceived = readJson<PerceiveRecord>("perceive.json");
  const played = readJson<PlayRecord>("play.json");
  if (walk) {
    console.log(`\n§0 the harness -- ${walk.games.length} baseline games, ${walk.screens.length} screens recorded\n`);
    console.log("  arms: " + ARMS.map((a) => `${a} (${ARM_BLURB[a]})`).join(", "));
  }
  if (perceived) reportPerceive(perceived);
  if (played) reportPlay(played);
  if (!perceived && !played) console.log("no records yet; run with --perceive and --play");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  if (argv.includes("--replay") || argv.length === 0) {
    replay();
    return;
  }
  if (!available()) {
    console.error("no NetHack or no tmux: `apt-get install -y nethack-console`");
    process.exit(2);
  }
  if (argv.includes("--perceive")) await perceive(Number(arg("screens", "80")));
  if (argv.includes("--play")) {
    await play(
      Number(arg("games", "3")),
      Number(arg("actions", "200")),
      arg("arms", ARMS.join(",")).split(",") as ArmName[],
      !argv.includes("--no-baselines"),
    );
  }
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
