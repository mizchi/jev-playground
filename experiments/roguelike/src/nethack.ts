/**
 * Real NetHack 3.6.7, driven from TypeScript.
 *
 * The game wants a terminal; `tmux` is one. A detached 80x24 tmux session
 * runs the real `/usr/games/nethack` binary, `send-keys` is the keyboard and
 * `capture-pane -p` hands back the screen as twenty-four lines of plain
 * text. No terminal emulator of my own, no patched NetHack, no native
 * module -- which matters, because a hand-rolled ANSI parser would put my
 * bugs inside the thing being measured.
 *
 * Everything here is mechanical. No judgment is involved in reading a
 * screen, enumerating what is legal on it, or deciding that a key did
 * nothing: those are the measurements, so they cannot come from the thing
 * being measured.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const BIN = process.env.NETHACK_BIN ?? "/usr/games/nethack";
export const TMUX = process.env.TMUX_BIN ?? "tmux";
/** Debian NetHack keeps saves and level locks here, shared across runs. */
export const VARDIR = process.env.NETHACK_VAR ?? "/var/games/nethack";

/** NetHack's tty layout: one message row, twenty-one map rows, two status rows. */
export const COLS = 80;
export const ROWS = 24;
export const MAP_TOP = 1;
export const MAP_ROWS = 21;

/** A screen, as twenty-four rows of exactly eighty characters. */
export interface Screen {
  rows: string[];
  /** Rows 0 (and 1, when a message wrapped) -- NetHack's message window. */
  message: string;
  /** Rows 22 and 23, joined. */
  status: string;
}

export interface Vitals {
  dlvl: number;
  hp: number;
  hpMax: number;
  gold: number;
  ac: number;
  xpLevel: number;
  xp: number;
  turn: number;
  score: number;
  /** `Hungry`, `Weak`, `Confused`, ... as NetHack prints them. */
  flags: string[];
}

/**
 * The option file.
 *
 * Naming all four of role, race, gender and alignment is what skips the
 * character-creation dialogue entirely -- with any one of them missing the
 * game stops on "Shall I pick ... for you?" and the harness would have to
 * answer a question that is not part of playing. `!color` is not cosmetic
 * either: it keeps `capture-pane` output free of SGR sequences, so a screen
 * is the characters and nothing else.
 */
export function nethackrc(name: string): string {
  return NETHACKRC.replace("OPTIONS=name:Jev", `OPTIONS=name:${name}`);
}

export const NETHACKRC = [
  "OPTIONS=name:Jev",
  "OPTIONS=role:Valkyrie,race:human,gender:female,align:neutral",
  "OPTIONS=!color,!DECgraphics,!IBMgraphics",
  // Gold only. With autopickup off entirely the `$:` field never left zero,
  // which quietly turned one perception probe into a constant -- it had no
  // true case on any screen in the corpus, so a policy of always answering
  // "no gold" would have scored 100% on it. Everything else still needs the
  // `,` action, so picking things up stays a decision.
  "OPTIONS=autopickup,pickup_types:$",
  "OPTIONS=number_pad:0",
  "OPTIONS=time,showexp,showscore",
  "OPTIONS=!legacy,!news,!verbose",
  "OPTIONS=disclose:ni na nv ng nc",
  "OPTIONS=runmode:teleport",
  "OPTIONS=!sparkle,!timed_delay",
  "",
].join("\n");

function tmux(args: string[]): string {
  // stderr is piped rather than inherited so that the expected "can't find
  // session" from a pre-emptive kill does not land in a run's output.
  return execFileSync(TMUX, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** `capture-pane` strips trailing blanks; a screen is a grid, so pad it back. */
function pad(line: string): string {
  const flat = line.replace(/\t/g, " ");
  return flat.length >= COLS ? flat.slice(0, COLS) : flat + " ".repeat(COLS - flat.length);
}

export function available(): boolean {
  if (!existsSync(BIN)) return false;
  try {
    tmux(["-V"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the saves and level locks a previous game left behind.
 *
 * This is not housekeeping, it is the difference between a game and a
 * continuation. Killing the terminal sends NetHack a hangup, NetHack saves,
 * and the next run under the same character name RESTORES that save -- so
 * four "fresh" baseline games all reported the same turn count and the same
 * dungeon level, because they were one game played four times. The numbers
 * looked plausible, which is the only reason it took a per-action trace to
 * notice.
 *
 * The level locks are shared per user rather than per character, so games
 * have to run one at a time. Nothing here parallelises.
 */
export function resetSave(name: string): void {
  if (!existsSync(VARDIR)) return;
  for (const f of readdirSync(resolve(VARDIR, "save"))) {
    if (f.includes(name)) rmSync(resolve(VARDIR, "save", f), { force: true });
  }
  for (const f of readdirSync(VARDIR)) {
    if (/lock\.\d+$/.test(f)) rmSync(resolve(VARDIR, f), { force: true });
  }
}

export class NetHack {
  readonly session: string;
  readonly home: string;
  readonly name: string;
  #dead = false;
  #keys = 0;

  constructor(opts: { session?: string; home: string; name?: string }) {
    this.session = opts.session ?? `nh-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.home = opts.home;
    this.name = opts.name ?? "Jev";
  }

  get keysSent(): number {
    return this.#keys;
  }

  start(): Screen {
    mkdirSync(this.home, { recursive: true });
    resetSave(this.name);
    const rc = resolve(this.home, "nethackrc");
    writeFileSync(rc, nethackrc(this.name));
    try {
      tmux(["kill-session", "-t", this.session]);
    } catch {
      /* not running */
    }
    tmux([
      "new-session",
      "-d",
      "-s",
      this.session,
      "-x",
      String(COLS),
      "-y",
      String(ROWS),
      `cd ${this.home} && HOME=${this.home} NETHACKOPTIONS=${rc} ${BIN}`,
    ]);
    return this.settle();
  }

  stop(): void {
    try {
      tmux(["kill-session", "-t", this.session]);
    } catch {
      /* already gone */
    }
  }

  screen(): Screen {
    let raw: string;
    try {
      raw = tmux(["capture-pane", "-t", this.session, "-p"]);
    } catch {
      this.#dead = true;
      return { rows: Array.from({ length: ROWS }, () => " ".repeat(COLS)), message: "", status: "" };
    }
    const lines = raw.replace(/\n$/, "").split("\n").map(pad);
    while (lines.length < ROWS) lines.push(" ".repeat(COLS));
    const rows = lines.slice(0, ROWS);
    return {
      rows,
      message: `${rows[0].trim()} ${rows[ROWS - 1].startsWith("Dlvl") ? "" : ""}`.trim(),
      status: `${rows[22].trim()} ${rows[23].trim()}`.trim(),
    };
  }

  /**
   * Send one key and wait for the screen to stop changing.
   *
   * "Stop changing" is two identical captures in a row, not a fixed sleep:
   * a fixed sleep is either slow or a race, and a race here shows up as the
   * harness reading a half-drawn map and calling the move a no-op.
   */
  key(k: string, opts: { settleMs?: number } = {}): Screen {
    if (this.#dead) return this.screen();
    this.#keys += 1;
    const named: Record<string, string> = { "\x1b": "Escape", "\r": "Enter", " ": "Space" };
    if (named[k]) tmux(["send-keys", "-t", this.session, named[k]]);
    else tmux(["send-keys", "-t", this.session, "-l", k]);
    return this.settle(opts.settleMs);
  }

  settle(settleMs = 60): Screen {
    let prev = this.screen();
    const deadline = Date.now() + 4_000;
    for (;;) {
      const waited = waitSync(settleMs);
      if (waited < 0) break;
      const next = this.screen();
      if (next.rows.join("\n") === prev.rows.join("\n")) return next;
      prev = next;
      if (Date.now() > deadline) return next;
    }
    return prev;
  }

  get processGone(): boolean {
    if (this.#dead) return true;
    try {
      const out = tmux(["list-sessions", "-F", "#{session_name}"]);
      return !out.split("\n").includes(this.session);
    } catch {
      return true;
    }
  }
}

/** A sleep that blocks, because every caller here is synchronous. */
function waitSync(ms: number): number {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
  return ms;
}

// --------------------------------------------------------------- reading it

export function vitalsOf(screen: Screen): Vitals | null {
  const line = screen.rows[23];
  const num = (re: RegExp, dflt = 0): number => {
    const m = re.exec(line);
    return m ? Number(m[1]) : dflt;
  };
  if (!/Dlvl:|Home|Dungeon/.test(line)) return null;
  const hp = /HP:(\d+)\((\d+)\)/.exec(line);
  const xp = /Xp:(\d+)\/(\d+)/.exec(line);
  const known = ["Hungry", "Weak", "Fainting", "Satiated", "Confused", "Stunned", "Blind", "Ill", "FoodPois", "Burdened", "Stressed", "Hallu"];
  return {
    dlvl: num(/Dlvl:(\d+)/, 1),
    hp: hp ? Number(hp[1]) : 0,
    hpMax: hp ? Number(hp[2]) : 0,
    gold: num(/\$:(\d+)/),
    ac: num(/AC:(-?\d+)/, 10),
    xpLevel: xp ? Number(xp[1]) : 1,
    xp: xp ? Number(xp[2]) : 0,
    turn: num(/T:(\d+)/),
    score: num(/S:(\d+)/),
    flags: known.filter((f) => line.includes(f)),
  };
}

/** Where the `@` is, in map coordinates. */
export function heroAt(screen: Screen): { x: number; y: number } | null {
  for (let y = 0; y < MAP_ROWS; y += 1) {
    const x = screen.rows[MAP_TOP + y].indexOf("@");
    if (x >= 0) return { x, y };
  }
  return null;
}

export function glyphAt(screen: Screen, x: number, y: number): string {
  if (x < 0 || x >= COLS || y < 0 || y >= MAP_ROWS) return " ";
  return screen.rows[MAP_TOP + y][x];
}

/** The map alone, as twenty-one lines -- what a player looks at. */
export function mapOf(screen: Screen): string[] {
  return screen.rows.slice(MAP_TOP, MAP_TOP + MAP_ROWS);
}
