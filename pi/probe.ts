/**
 * WHAT EACH EXTENSION ACTUALLY REGISTERS, MEASURED BY LOADING IT.
 *
 *   tsx probe.ts            the table, and the overlap between the profiles
 *   tsx probe.ts --md       the same, as the markdown README.md quotes
 *
 * No API key, no network, no Pi process. Every one of the six factories is
 * `(pi: ExtensionAPI) => void` that only registers handlers, so handing it a
 * recording stub and reading back the calls is the whole measurement.
 *
 * WHY THIS EXISTS RATHER THAN A TABLE IN THE README. The one thing a reader
 * needs from `pi/` is which seam each component sits on, because that is what
 * decides whether two of them collide. A hand-written table of that is a
 * hand-written measurement, and this programme has now been bitten by one
 * often enough to stop typing them (docs/55 §6: five fence denials described
 * from a summary, one of them in the wrong class). So the README's table is
 * printed by this file.
 *
 * IT LOADS THE ENTRY FILES, NOT THE PACKAGES. The entry files are what Pi
 * discovers, so that is what gets loaded here -- a re-export that pointed at
 * the wrong package would pass a test that imported the package directly and
 * fail in Pi.
 *
 * WHAT IT CANNOT TELL YOU: whether Pi finds those files at all. That depends
 * on each profile's `pi` key and is measured by `load.ts` against Pi's own
 * resolver, because a `pi.extensions` matching nothing loads nothing without
 * reporting an error.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ALL, PROFILES, type Component, type Profile } from "./seams.js";

/** Everything a factory can register, as the stub sees it. */
export interface Registered {
  seams: string[];
  commands: string[];
  flags: string[];
  tools: string[];
  shortcuts: string[];
  /** Set when the factory threw. A factory that throws never loads in Pi. */
  error?: string;
}

/**
 * A recording `ExtensionAPI`.
 *
 * A Proxy rather than a hand-written object because `ExtensionAPI` has some
 * fifty methods and only six of them matter here: a stub that implements the
 * six and is missing the rest would turn an unrelated call into a TypeError
 * and get reported as "the factory threw". Anything not named below returns
 * undefined and is recorded nowhere, which is the honest default -- this
 * measures what was REGISTERED, not everything that was touched.
 */
export function recorder(): { api: unknown; read: () => Registered } {
  const got: Registered = { seams: [], commands: [], flags: [], tools: [], shortcuts: [] };
  const api = new Proxy(
    {},
    {
      get(_target, prop) {
        switch (prop) {
          case "on":
            return (event: string) => void got.seams.push(event);
          case "registerCommand":
            return (name: string) => void got.commands.push(name);
          case "registerFlag":
            return (name: string) => void got.flags.push(name);
          case "registerTool":
            return (tool: { name?: string }) => void got.tools.push(tool?.name ?? "(unnamed)");
          case "registerShortcut":
            return (key: string) => void got.shortcuts.push(key);
          // A factory may read a flag it just registered to compute a default.
          // Returning undefined is what Pi does before any flag is passed.
          case "getFlag":
            return () => undefined;
          case "getThinkingLevel":
            return () => "off";
          case "getActiveTools":
          case "getAllTools":
          case "getCommands":
            return () => [];
          default:
            return () => undefined;
        }
      },
    },
  );
  return { api, read: () => got };
}

/** Load one entry file and record what it registers. */
export async function probe(profile: Profile, c: Component): Promise<Registered> {
  const entry = resolve(import.meta.dirname, profile.dir, "extensions", `${c.name}.ts`);
  const { api, read } = recorder();
  try {
    const mod = (await import(entry)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      return { ...read(), error: `default export is ${typeof mod.default}, not a function` };
    }
    (mod.default as (pi: unknown) => void)(api);
  } catch (err) {
    return { ...read(), error: String(err).slice(0, 200) };
  }
  return read();
}

/** Every entry file Pi would discover under a profile, from disk. */
export function entriesOn(profile: Profile): string[] {
  const dir = resolve(import.meta.dirname, profile.dir, "extensions");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .map((f) => f.replace(/\.(ts|js)$/, ""))
    .sort();
}

/**
 * The seams both profiles take.
 *
 * This is the conflict, as a number rather than a warning: every seam in here
 * would run twice if both profiles were loaded, and `tool_call` running twice
 * means two permission gates on one call.
 */
export function overlap(measured: Map<string, Registered>): string[] {
  const seamsOf = (p: Profile): Set<string> =>
    new Set(p.components.flatMap((c) => measured.get(c.name)?.seams ?? []));
  const [a, b] = PROFILES.map(seamsOf);
  return [...a].filter((s) => b.has(s)).sort();
}

async function main(): Promise<void> {
  const md = process.argv.includes("--md");
  const measured = new Map<string, Registered>();
  for (const p of PROFILES) for (const c of p.components) measured.set(c.name, await probe(p, c));

  for (const p of PROFILES) {
    console.log(md ? `\n### \`pi/${p.dir}\` -- ${p.what}\n` : `\n${p.dir}: ${p.what}`);
    if (md) {
      console.log("| extension | seams it registers | commands | flags | decides |");
      console.log("| --- | --- | --- | --- | --- |");
    }
    for (const c of p.components) {
      const r = measured.get(c.name) as Registered;
      const cell = (xs: string[]): string => (xs.length > 0 ? xs.map((x) => `\`${x}\``).join(" ") : "--");
      if (md) {
        console.log(
          `| \`${c.name}\` | ${cell(r.seams)} | ${cell(r.commands)} | ${r.flags.length} | ${c.decides} |`,
        );
      } else {
        console.log(
          `  ${r.error ? "FAIL" : "ok  "} ${c.name.padEnd(18)} ${r.seams.length} seams ` +
            `${r.commands.length} cmd ${r.flags.length} flag${r.error ? `  ${r.error}` : ""}`,
        );
        if (!r.error) console.log(`       ${r.seams.join(", ")}`);
      }
    }
  }

  const both = overlap(measured);
  const broken = [...measured].filter(([, r]) => r.error);
  if (md) {
    console.log(
      `\n**The two profiles collide on ${both.length} of the seams they take** ` +
        `(${both.map((s) => `\`${s}\``).join(", ")}), which is why they are separate packages: ` +
        "`tool_call` twice is two permission gates on one call.\n",
    );
  } else {
    console.log(`\n  both profiles take: ${both.join(", ")} (${both.length} seams -- the collision)`);
    console.log(`  ${ALL.length} extensions probed, ${broken.length} failed to load\n`);
  }
  process.exit(broken.length === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("probe.ts")) await main();
