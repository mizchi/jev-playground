/**
 * What is on the screen, and what can be done about it.
 *
 * Jev cannot emit a string, so a policy over NetHack has to be a policy over
 * an enumerated set -- the same shape as [docs/03's chess](../../../docs/03-chess.md),
 * where the legal moves were the `choice` criteria and an illegal move was
 * therefore unrepresentable. The difference is that chess.js told me the
 * legal moves and here nothing does: the set has to be read off an 80x24
 * picture, by code, with the ambiguities that a player also lives with.
 *
 * The ambiguity worth naming up front: an OPEN DOOR draws as `-` or `|`,
 * exactly like a wall. Nothing on the screen distinguishes them, so the
 * classifier calls both `wall`. That is not a shortcut, it is the game's own
 * information problem, and it applies identically to every arm.
 */
import { MAP_ROWS, type Screen, glyphAt, heroAt } from "./nethack.js";

export const DIRS = [
  { key: "h", name: "west", dx: -1, dy: 0 },
  { key: "j", name: "south", dx: 0, dy: 1 },
  { key: "k", name: "north", dx: 0, dy: -1 },
  { key: "l", name: "east", dx: 1, dy: 0 },
  { key: "y", name: "northwest", dx: -1, dy: -1 },
  { key: "u", name: "northeast", dx: 1, dy: -1 },
  { key: "b", name: "southwest", dx: -1, dy: 1 },
  { key: "n", name: "southeast", dx: 1, dy: 1 },
] as const;
export type Dir = (typeof DIRS)[number];

export type Kind =
  | "unexplored"
  | "wall"
  | "floor"
  | "corridor"
  | "closed door"
  | "stairs down"
  | "stairs up"
  | "monster"
  | "item"
  | "trap"
  | "furniture"
  | "boulder";

const MONSTER = /^[a-zA-Z&';:~]$/;
const ITEM = /^[)\[!?/="(*%$]$/;

/**
 * One glyph, one classification -- and no peeking.
 *
 * `#` is a corridor and also a sink and also a tree; `+` is a closed door and
 * also a spellbook; a letter is a monster and `@` is the hero. Each of those
 * collisions is in the real game, so each stays.
 */
export function kindOf(g: string): Kind {
  if (g === " ") return "unexplored";
  if (g === "-" || g === "|") return "wall";
  if (g === ".") return "floor";
  if (g === "#") return "corridor";
  if (g === ">") return "stairs down";
  if (g === "<") return "stairs up";
  if (g === "+") return "closed door";
  if (g === "^") return "trap";
  if (g === "_" || g === "{" || g === "\\" || g === "}") return "furniture";
  if (g === "`") return "boulder";
  if (g === "@") return "monster";
  if (MONSTER.test(g)) return "monster";
  if (ITEM.test(g)) return "item";
  return "floor";
}

/** Can a step land there at all? Walls and unexplored rock cannot. */
export function steppable(kind: Kind): boolean {
  return kind !== "wall" && kind !== "unexplored";
}

/**
 * NetHack forbids moving diagonally into or out of a door square.
 *
 * Left out, a policy looks worse than it is: the move is chosen, the game
 * refuses it, and the turn is scored as a mistake that the rules made
 * unavoidable. Encoded here, it is the enumerator's job, like castling
 * through check.
 *
 * `+` is the only door this can see. The rule spares DOORLESS doorways, and
 * those draw as `.`; an OPEN door does block diagonals but draws as `-` or
 * `|`, which the classifier already calls a wall, so no step is offered into
 * one anyway. The two gaps cancel, which is luck rather than design, and
 * worth knowing before this function gets reused.
 */
export function diagonalBlocked(screen: Screen, from: { x: number; y: number }, dir: Dir): boolean {
  if (dir.dx === 0 || dir.dy === 0) return false;
  return (
    kindOf(glyphAt(screen, from.x, from.y)) === "closed door" ||
    kindOf(glyphAt(screen, from.x + dir.dx, from.y + dir.dy)) === "closed door"
  );
}

export interface Action {
  /** The keystroke. */
  key: string;
  /** What the choice criteria call it. */
  name: string;
  /** The mechanical description handed to every arm, verbatim. */
  says: string;
  dir?: Dir;
}

export interface Enumerated {
  actions: Action[];
  hero: { x: number; y: number } | null;
  /** The glyph the hero is standing on, if code can tell. It usually cannot. */
  standingOn: Kind | null;
}

/**
 * The action set for one screen.
 *
 * Eight steps, plus the commands that the screen says are worth having. The
 * eight steps are always offered even when they run into a wall -- because
 * "walked into a wall" is one of the numbers this experiment is for, and
 * deleting the option would delete the measurement. What each step would
 * land on is stated, so nobody is choosing blind.
 */
export function enumerate(screen: Screen, opts: { hungry?: boolean; exclude?: ReadonlySet<string> } = {}): Enumerated {
  const hero = heroAt(screen);
  const actions: Action[] = [];
  if (!hero) return { actions, hero, standingOn: null };
  for (const dir of DIRS) {
    const g = glyphAt(screen, hero.x + dir.dx, hero.y + dir.dy);
    const kind = kindOf(g);
    const bits = [`step ${dir.name}`, `the square there shows \`${g === " " ? "(blank)" : g}\` = ${kind}`];
    if (kind === "monster") bits.push("stepping into a monster attacks it");
    if (diagonalBlocked(screen, hero, dir)) bits.push("a doorway is involved, and NetHack refuses diagonal moves through one");
    actions.push({ key: dir.key, name: dir.name, says: bits.join("; "), dir });
  }
  actions.push({
    key: ">",
    name: "descend",
    says: "go down the staircase. Only works while standing on `>`, which the `@` hides",
  });
  actions.push({
    key: ",",
    name: "pick up",
    says: "pick up what is on this square. Only works if something is here, which the `@` hides",
  });
  actions.push({
    key: "s",
    name: "search",
    says: "search the adjacent squares for a hidden door or passage; costs a turn and usually finds nothing",
  });
  if (opts.hungry) {
    actions.push({ key: "e", name: "eat", says: "eat a food item from the pack" });
  }
  // Anything the game has already refused from this exact square, since the
  // last time the clock moved, is dropped. This is not a hint: the refusal
  // already happened and the player saw it. Without it a policy that cannot
  // see WHY a move was refused -- the hidden doorway under the `@` being the
  // usual reason -- picks the same move forever, which is what the greedy
  // baseline did for two hundred and fifty actions straight.
  const left = opts.exclude ? actions.filter((a) => !opts.exclude!.has(a.key)) : actions;
  return { actions: left.length > 0 ? left : actions, hero, standingOn: null };
}

// ------------------------------------------------------------- the geometry

export interface Grid {
  kinds: Kind[][];
}

export function gridOf(screen: Screen): Grid {
  const kinds: Kind[][] = [];
  for (let y = 0; y < MAP_ROWS; y += 1) {
    const row: Kind[] = [];
    for (let x = 0; x < 80; x += 1) row.push(kindOf(glyphAt(screen, x, y)));
    kinds.push(row);
  }
  return { kinds };
}

/**
 * Breadth-first from the hero over the squares a step can land on.
 *
 * Used for the ground truth in the perception questions and for the greedy
 * baseline's route, so it has to obey the same rules a step does -- the
 * diagonal-doorway one included.
 */
export function distances(screen: Screen, from: { x: number; y: number }): number[][] {
  const grid = gridOf(screen);
  const dist = Array.from({ length: MAP_ROWS }, () => Array.from({ length: 80 }, () => -1));
  dist[from.y][from.x] = 0;
  const queue: { x: number; y: number }[] = [from];
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    for (const dir of DIRS) {
      const nx = cur.x + dir.dx;
      const ny = cur.y + dir.dy;
      if (nx < 0 || nx >= 80 || ny < 0 || ny >= MAP_ROWS) continue;
      if (dist[ny][nx] !== -1) continue;
      if (!steppable(grid.kinds[ny][nx])) continue;
      if (diagonalBlocked(screen, cur, dir)) continue;
      dist[ny][nx] = dist[cur.y][cur.x] + 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return dist;
}

/** Every square of a given kind, nearest first. */
export function reachable(screen: Screen, want: (k: Kind, g: string) => boolean): { x: number; y: number; d: number }[] {
  const hero = heroAt(screen);
  if (!hero) return [];
  const dist = distances(screen, hero);
  const grid = gridOf(screen);
  const out: { x: number; y: number; d: number }[] = [];
  for (let y = 0; y < MAP_ROWS; y += 1) {
    for (let x = 0; x < 80; x += 1) {
      if (dist[y][x] < 0) continue;
      if (want(grid.kinds[y][x], glyphAt(screen, x, y))) out.push({ x, y, d: dist[y][x] });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * A frontier square: steppable, touching something unexplored, and not one
 * the caller has already stood on.
 *
 * The `exclude` set is not an optimisation. A blank square beyond the
 * OUTSIDE CORNER of a room is unexplored and will stay unexplored forever --
 * it is solid rock -- so the floor square next to it is a frontier that can
 * never be consumed. Two such squares side by side make a trap: walk to one,
 * arrive, it is still a frontier, so pick the other, and the explorer spends
 * four hundred turns going `west east west east` one square from where it
 * started.
 *
 * NetHack shows a player all eight squares around them, so a square that has
 * been STOOD ON has had its blanks resolved: whatever is still blank next to
 * it is rock. Excluding visited squares is therefore not a heuristic, it is
 * the same inference a player makes.
 */
export function frontiers(
  screen: Screen,
  opts: { exclude?: ReadonlySet<string> } = {},
): { x: number; y: number; d: number }[] {
  const grid = gridOf(screen);
  return reachable(screen, (k) => k !== "wall" && k !== "unexplored").filter(({ x, y }) => {
    if (opts.exclude?.has(`${x},${y}`)) return false;
    if (grid.kinds[y][x] === "closed door") return true;
    for (const dir of DIRS) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      if (nx < 0 || nx >= 80 || ny < 0 || ny >= MAP_ROWS) continue;
      if (grid.kinds[ny][nx] === "unexplored") return true;
    }
    return false;
  });
}

/** The first step of a shortest route to a target, as a direction. */
export function stepToward(screen: Screen, target: { x: number; y: number }): Dir | null {
  const hero = heroAt(screen);
  if (!hero) return null;
  // Distances FROM the target, then walk downhill from the hero.
  const dist = distances(screen, target);
  if (dist[hero.y][hero.x] < 0) return null;
  let best: Dir | null = null;
  let bestD = dist[hero.y][hero.x];
  for (const dir of DIRS) {
    const nx = hero.x + dir.dx;
    const ny = hero.y + dir.dy;
    if (nx < 0 || nx >= 80 || ny < 0 || ny >= MAP_ROWS) continue;
    if (dist[ny][nx] < 0 || dist[ny][nx] >= bestD) continue;
    if (diagonalBlocked(screen, hero, dir)) continue;
    bestD = dist[ny][nx];
    best = dir;
  }
  return best;
}
