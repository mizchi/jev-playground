/**
 * Four small games that can be solved exactly, and one that cannot be played
 * badly.
 *
 * The point of keeping them small is the SOLVER. The claim under test is that
 * a game's tension shows up in the confidence trajectory of Jev playing
 * itself -- and "tension" has to mean something measurable, or the claim is
 * decoration. Here it means a quantity computed by exhaustive search from
 * every position actually played:
 *
 *   critical    exactly one legal move preserves the position's
 *               game-theoretic value. Choose wrong and the result changes.
 *   forgiving   every legal move preserves it. The choice does not matter.
 *
 * A game whose positions are mostly critical is tight; one whose positions
 * are mostly forgiving is slack. `drift` is the slack extreme on purpose: it
 * has legal moves, they are enumerable, and not one of them can ever change
 * who wins. It is the floor any "this measures tension" claim has to clear.
 */

export const GAMES = ["nim", "tictactoe", "misere", "connect3", "drift"] as const;
export type GameName = (typeof GAMES)[number];

/** Whose turn, from the position alone: every game here is turn-alternating. */
export interface Position {
  game: GameName;
  /** The position, as the solver's memo key and the player's description. */
  key: string;
  /** 0 or 1. Player 0 moves first. */
  player: number;
}

export interface Move {
  /** The name the `choice` criteria use. Unique within a position. */
  name: string;
  /** What the criteria say about it, derived mechanically from the rules. */
  says: string;
}

export interface Rules {
  name: GameName;
  blurb: string;
  start(seed: number): Position;
  /** Every legal move. Empty means the game is over. */
  moves(p: Position): Move[];
  apply(p: Position, move: string): Position;
  /**
   * `null` while the game is running, otherwise the winner: 0, 1, or -1 for
   * a draw.
   */
  winner(p: Position): number | null;
  /** The board as a player sees it. Goes into the state verbatim. */
  render(p: Position): string[];
  /** How the rules are explained, once, in the state. */
  howToPlay: string[];
}

const other = (player: number): number => 1 - player;

// ------------------------------------------------------------------------ nim

/**
 * Three heaps, take any number from one heap, the player who takes the last
 * object wins.
 *
 * Solved by the XOR of the heap sizes, which makes it the cleanest case of a
 * game that is tense to someone who cannot compute it and trivial to someone
 * who can. Whichever Jev turns out to be, the solver knows.
 */
const nim: Rules = {
  name: "nim",
  blurb: "three heaps, take any number from one heap, taking the last object wins",
  howToPlay: [
    "Three heaps of objects. On your turn you must take at least one object, all from a single heap.",
    "You may take as many as you like from that one heap.",
    "The player who takes the very last object wins.",
  ],
  start(seed) {
    const r = seeded(seed);
    const heaps = [3 + Math.floor(r() * 5), 4 + Math.floor(r() * 4), 5 + Math.floor(r() * 3)];
    return { game: "nim", key: heaps.join(","), player: 0 };
  },
  moves(p) {
    const heaps = p.key.split(",").map(Number);
    const out: Move[] = [];
    for (const [i, size] of heaps.entries()) {
      for (let take = 1; take <= size; take += 1) {
        const after = heaps.slice();
        after[i] -= take;
        out.push({
          name: `heap ${i + 1} take ${take}`,
          says: `take ${take} from heap ${i + 1}, leaving heaps ${after.join(", ")}`,
        });
      }
    }
    return out;
  },
  apply(p, move) {
    const m = /^heap (\d+) take (\d+)$/.exec(move);
    if (!m) throw new Error(`nim: no such move ${move}`);
    const heaps = p.key.split(",").map(Number);
    heaps[Number(m[1]) - 1] -= Number(m[2]);
    return { game: "nim", key: heaps.join(","), player: other(p.player) };
  },
  winner(p) {
    // The player who took the last object was the one who moved INTO this
    // position, so the winner is whoever is not to move.
    return p.key.split(",").every((n) => Number(n) === 0) ? other(p.player) : null;
  },
  render(p) {
    return p.key.split(",").map((n, i) => `heap ${i + 1}: ${"o".repeat(Number(n))} (${n})`);
  },
};

// ------------------------------------------------------- tic-tac-toe, twice

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function ticWinner(key: string): number | null {
  for (const [a, b, c] of LINES) {
    if (key[a] !== "." && key[a] === key[b] && key[b] === key[c]) return key[a] === "X" ? 0 : 1;
  }
  return key.includes(".") ? null : -1;
}

function ticMoves(key: string): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 9; i += 1) {
    if (key[i] !== ".") continue;
    const row = Math.floor(i / 3) + 1;
    const col = (i % 3) + 1;
    out.push({ name: `r${row}c${col}`, says: `the empty square in row ${row}, column ${col}` });
  }
  return out;
}

function ticApply(game: GameName, p: Position, move: string): Position {
  const m = /^r(\d)c(\d)$/.exec(move);
  if (!m) throw new Error(`${game}: no such move ${move}`);
  const i = (Number(m[1]) - 1) * 3 + (Number(m[2]) - 1);
  if (p.key[i] !== ".") throw new Error(`${game}: ${move} is taken`);
  const mark = p.player === 0 ? "X" : "O";
  return { game, key: `${p.key.slice(0, i)}${mark}${p.key.slice(i + 1)}`, player: other(p.player) };
}

function ticRender(key: string): string[] {
  return [
    "   c1 c2 c3",
    `r1  ${key[0]}  ${key[1]}  ${key[2]}`,
    `r2  ${key[3]}  ${key[4]}  ${key[5]}`,
    `r3  ${key[6]}  ${key[7]}  ${key[8]}`,
  ];
}

const tictactoe: Rules = {
  name: "tictactoe",
  blurb: "ordinary tic-tac-toe: three in a row wins",
  howToPlay: [
    "A three by three grid. X moves first, then O, alternating.",
    "You may play in any empty square, written as r<row>c<column>.",
    "Three of your own marks in a row, column or diagonal wins. A full grid with no line is a draw.",
  ],
  start: () => ({ game: "tictactoe", key: ".........", player: 0 }),
  moves: (p) => (ticWinner(p.key) === null ? ticMoves(p.key) : []),
  apply: (p, move) => ticApply("tictactoe", p, move),
  winner: (p) => ticWinner(p.key),
  render: (p) => ticRender(p.key),
};

/**
 * The same board, the opposite goal: making three in a row LOSES.
 *
 * Included because it is the control for "did it learn the game or recognise
 * the picture". The position is a familiar tic-tac-toe grid and every
 * instinct about it is inverted, so an arm that plays on pattern rather than
 * on the stated rule should show up here and nowhere else.
 */
const misere: Rules = {
  name: "misere",
  blurb: "tic-tac-toe with the goal inverted: three in a row LOSES",
  howToPlay: [
    "A three by three grid. X moves first, then O, alternating.",
    "You may play in any empty square, written as r<row>c<column>.",
    "WARNING: the goal is inverted. Making three of your own marks in a row, column or diagonal means you LOSE.",
    "A full grid with no line is a draw.",
  ],
  start: () => ({ game: "misere", key: ".........", player: 0 }),
  moves: (p) => (misereWinner(p.key) === null ? ticMoves(p.key) : []),
  apply: (p, move) => ticApply("misere", p, move),
  winner: (p) => misereWinner(p.key),
  render: (p) => ticRender(p.key),
};

function misereWinner(key: string): number | null {
  const made = ticWinner(key);
  if (made === null) return null;
  return made === -1 ? -1 : other(made);
}

// ------------------------------------------------------------------ connect3

const C3_COLS = 4;
const C3_ROWS = 4;

/**
 * Connect Four's shape, shrunk until it can be solved exactly.
 *
 * Four columns, four rows, three in a row wins. Big enough to have real
 * tactics -- threats, forced blocks, a double threat that wins -- and small
 * enough that negamax over the whole tree finishes in well under a second,
 * which is the only reason a per-position criticality number exists.
 */
const connect3: Rules = {
  name: "connect3",
  blurb: "Connect Four on a four by four board, three in a row wins",
  howToPlay: [
    "Four columns and four rows. X drops first, then O, alternating.",
    "A piece dropped into a column falls to the lowest empty cell of that column.",
    "Three of your own pieces in a row, column or diagonal wins. A full board with no line is a draw.",
  ],
  start: () => ({ game: "connect3", key: ".".repeat(C3_COLS * C3_ROWS), player: 0 }),
  moves(p) {
    if (c3Winner(p.key) !== null) return [];
    const out: Move[] = [];
    for (let c = 0; c < C3_COLS; c += 1) {
      const row = c3Drop(p.key, c);
      if (row < 0) continue;
      out.push({ name: `column ${c + 1}`, says: `drop into column ${c + 1}; it lands on row ${row + 1} counting from the bottom` });
    }
    return out;
  },
  apply(p, move) {
    const m = /^column (\d)$/.exec(move);
    if (!m) throw new Error(`connect3: no such move ${move}`);
    const c = Number(m[1]) - 1;
    const row = c3Drop(p.key, c);
    if (row < 0) throw new Error(`connect3: column ${c + 1} is full`);
    const i = row * C3_COLS + c;
    const mark = p.player === 0 ? "X" : "O";
    return { game: "connect3", key: `${p.key.slice(0, i)}${mark}${p.key.slice(i + 1)}`, player: other(p.player) };
  },
  winner: (p) => c3Winner(p.key),
  render(p) {
    const rows: string[] = ["  c1 c2 c3 c4"];
    for (let r = C3_ROWS - 1; r >= 0; r -= 1) {
      const cells = Array.from({ length: C3_COLS }, (_, c) => p.key[r * C3_COLS + c]);
      rows.push(`  ${cells.join("  ")}   <- row ${r + 1}`);
    }
    return rows;
  },
};

/** The lowest empty row of a column, or -1. Row 0 is the bottom. */
function c3Drop(key: string, col: number): number {
  for (let r = 0; r < C3_ROWS; r += 1) if (key[r * C3_COLS + col] === ".") return r;
  return -1;
}

function c3Winner(key: string): number | null {
  const at = (r: number, c: number): string => (r < 0 || r >= C3_ROWS || c < 0 || c >= C3_COLS ? "" : key[r * C3_COLS + c]);
  for (let r = 0; r < C3_ROWS; r += 1) {
    for (let c = 0; c < C3_COLS; c += 1) {
      const me = at(r, c);
      if (me === "." || me === "") continue;
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        if (at(r + dr, c + dc) === me && at(r + 2 * dr, c + 2 * dc) === me) return me === "X" ? 0 : 1;
      }
    }
  }
  return key.includes(".") ? null : -1;
}

// --------------------------------------------------------------------- drift

/**
 * The floor: a game with choices that cannot matter.
 *
 * Two tokens race twelve steps. Each turn you pick which of your two tokens
 * to advance; the winner is whoever's TOTAL reaches twelve first, so the
 * split between the tokens is irrelevant and every legal move is equally
 * good, forever. Nothing about it is a decision.
 *
 * Every "this statistic measures tension" claim has to put this game at the
 * bottom. If it does not, the statistic is measuring something else --
 * position count, board size, how much text the state holds.
 */
const drift: Rules = {
  name: "drift",
  blurb: "two tokens race; you choose which to advance, and it cannot matter",
  howToPlay: [
    "Each player has two tokens, both starting at 0. On your turn you advance one of your own tokens by one step.",
    "The first player whose two tokens add up to 12 or more wins.",
    "You may advance either of your tokens, written as token A or token B.",
  ],
  start: () => ({ game: "drift", key: "0,0|0,0", player: 0 }),
  moves(p) {
    if (drWinner(p.key) !== null) return [];
    return [
      { name: "token A", says: "advance your first token by one step" },
      { name: "token B", says: "advance your second token by one step" },
    ];
  },
  apply(p, move) {
    const sides = p.key.split("|").map((s) => s.split(",").map(Number));
    const which = move === "token A" ? 0 : move === "token B" ? 1 : -1;
    if (which < 0) throw new Error(`drift: no such move ${move}`);
    sides[p.player][which] += 1;
    return { game: "drift", key: sides.map((s) => s.join(",")).join("|"), player: other(p.player) };
  },
  winner: (p) => drWinner(p.key),
  render(p) {
    const sides = p.key.split("|");
    return sides.map((s, i) => {
      const [a, b] = s.split(",").map(Number);
      return `player ${i === 0 ? "X" : "O"}: A=${a} B=${b} total=${a + b} of 12`;
    });
  },
};

function drWinner(key: string): number | null {
  const totals = key.split("|").map((s) => s.split(",").reduce((a, b) => a + Number(b), 0));
  if (totals[0] >= 12) return 0;
  if (totals[1] >= 12) return 1;
  return null;
}

// ------------------------------------------------------------------ the table

export const RULES: Record<GameName, Rules> = { nim, tictactoe, misere, connect3, drift };

/** A deterministic generator, so a game's opening replays exactly. */
export function seeded(seed: number): () => number {
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
