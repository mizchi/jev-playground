/**
 * Which selector each skill's answer should come from.
 *
 * This is the part of docs/29 that is a tool rather than a measurement, and
 * the property that makes it one is that it takes no project: a skill's route
 * is decidable from the catalog when the tool is built.
 *
 *   policy    a T0 row. The catalog says "always want, whatever the project
 *             is", so the answer is a constant and nothing needs asking.
 *   grep      a T1 row whose sections all declare FILE signals. A
 *             `wrangler.toml` in the tree settles it; the free baseline is
 *             the right selector and it costs nothing.
 *   judgment  everything else: a T2 row, or a T1 row in a section whose
 *             signals are an activity rather than a filename. Only the
 *             request text decides those, and §7 measures that the judgment
 *             ranks them four times better than the overlap does.
 *
 * `deciderFor` is the same split seen from the LABEL's side, per project,
 * and is used only for reporting -- it is what §7 groups the positives by.
 */
import type { Snapshot } from "./catalog.js";
import type { Project } from "./projects.js";

export type Route = "policy" | "grep" | "judgment";

/** What decides a label, from the label's side. Reporting only. */
export type Decider = "policy" | "files" | "ask";

/**
 * A section's signals are file-shaped when they name a path or a filename.
 *
 * Mechanical: a backticked token containing a dot or a slash. That is true of
 * "`wrangler.toml`, Cloudflare account, Workers / Pages deploy" and false of
 * "user asks for a security review of a web application repository", which is
 * the distinction that matters.
 */
export function fileShapedSections(snapshot: Snapshot): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const row of snapshot.rows) {
    if (out.has(row.section)) continue;
    out.set(row.section, /`[^`]*[./][^`]*`/.test(row.signals));
  }
  return out;
}

export function routeFor(snapshot: Snapshot, fileShaped: Map<string, boolean>, skill: string): Route {
  const rows = snapshot.rows.filter((r) => r.skill === skill);
  if (rows.some((r) => r.tier === "T0")) return "policy";
  const t1 = rows.filter((r) => r.tier === "T1");
  if (t1.length > 0 && t1.every((r) => fileShaped.get(r.section))) return "grep";
  return "judgment";
}

export function deciderFor(
  snapshot: Snapshot,
  fileShaped: Map<string, boolean>,
  project: Project,
  skill: string,
): Decider | null {
  const rows = snapshot.rows.filter((r) => r.skill === skill);
  if (rows.some((r) => r.tier === "T0")) return "policy";
  for (const r of rows) {
    if (r.tier === "T1" && project.signals.includes(r.section)) {
      return fileShaped.get(r.section) ? "files" : "ask";
    }
    if (r.tier === "T1" && project.asked.includes(r.section)) return "ask";
    if (r.tier === "T2" && project.asked.includes(r.section)) return "ask";
  }
  return null;
}
