/**
 * DOES PI ITSELF LOAD THIS? Asked of Pi's own resource loader, not of a stub.
 *
 *   tsx load.ts              the six packages on their own, then both profiles
 *   tsx load.ts components   just that profile
 *   tsx load.ts packages     just the per-package recipe the READMEs print
 *
 * No API key and no agent session. `DefaultResourceLoader` is what Pi's
 * startup constructs, and pointing it at a throwaway `agentDir` whose
 * `settings.json` lists a profile is exactly what `pi install <path>` leaves
 * behind. What comes back carries `origin: "package"`, which is the proof
 * that Pi read the profile's `pi.extensions` and not some convention
 * directory that happened to be lying around.
 *
 * WHY THIS IS A SEPARATE FILE FROM `probe.ts`. The probe measures what a
 * factory registers when WE call it; it cannot tell whether Pi would ever
 * find the factory. That is a different question and it needs Pi's own
 * resolver to answer, because the `pi` key is load-bearing and quiet when
 * wrong: point `pi.extensions` at a glob that matches nothing and the loader
 * returns zero extensions and zero errors. Declaring the key also switches
 * the convention directories off, so `extensions/` being right there does not
 * rescue it. A stub would report five healthy extensions for a package Pi
 * loads nothing from.
 *
 * THE FIRST VERSION OF THIS FILE GOT ITS OWN ANSWER WRONG, which is worth
 * recording because it is the failure mode of every harness in this
 * repository. It called `discoverAndLoadExtensions([profileDir], ...)`, which
 * is the loader for a path that IS an extension, not for a package: with
 * `pi.extensions: ["./extensions"]` it reported `Cannot find module
 * .../extensions` for all five. I read that as "the directory spelling is
 * broken" and wrote the glob form plus a confident causal story into three
 * docblocks. Asking the package resolver instead: BOTH spellings load all
 * five. The failure was my entry point, not the spelling. The glob stays
 * because it names the files it loads, and `test.ts` now pins the key's
 * presence rather than its exact text.
 *
 * It is kept out of `npm test` because it instantiates Pi's real runtime: it
 * is slower, and it can fail for reasons that belong to Pi rather than to
 * this directory. `npm test` stays a check that needs nothing but the repo.
 */
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ALL, PROFILES, type Profile } from "./seams.js";

export interface Loaded {
  /** Entry basenames, as Pi resolved them from the package. */
  found: string[];
  /** Entries Pi resolved from somewhere other than the package's `pi` key. */
  notFromPackage: string[];
  /** Whatever Pi reported as a failure, verbatim. */
  errors: string[];
}

interface PiExtension {
  path?: string;
  sourceInfo?: { origin?: string; source?: string };
}

/**
 * Hand Pi one profile directory the way `pi install <path>` does.
 *
 * The `agentDir` is a fresh temporary directory every call, so this never
 * reads or writes the caller's own `~/.pi`: a verification that edits the
 * machine it runs on is not a verification.
 */
export async function loadProfile(p: Profile): Promise<Loaded> {
  return loadPath(resolve(import.meta.dirname, p.dir));
}

/**
 * Hand Pi any directory the way `pi install <path>` does, and report what it
 * resolved.
 *
 * Split out from `loadProfile` so the recipe the PACKAGE READMEs print can be
 * checked too: `pi install ./packages/jev-guard` is a local-path install of a
 * package whose own `pi` key names one extension, which is a different code
 * path from a profile that names five.
 */
export async function loadPath(dir: string): Promise<Loaded> {
  const agentDir = mkdtempSync(resolve(tmpdir(), "jev-pi-load-"));
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(resolve(agentDir, "settings.json"), `${JSON.stringify({ packages: [dir] })}\n`);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir } as never);
  await (loader as unknown as { reload: () => Promise<void> }).reload();
  const result = loader.getExtensions() as unknown as {
    extensions?: PiExtension[];
    errors?: { path?: string; error?: string }[];
  };
  const found: string[] = [];
  const notFromPackage: string[] = [];
  for (const e of result.extensions ?? []) {
    const name = (e.path ?? "").split("/").pop()?.replace(/\.(ts|js)$/, "") ?? "(unnamed)";
    found.push(name);
    if (e.sourceInfo?.origin !== "package") notFromPackage.push(`${name} (${e.sourceInfo?.origin ?? "?"})`);
  }
  return {
    found: found.sort(),
    notFromPackage,
    errors: (result.errors ?? []).map((e) => `${e.path ?? "?"}: ${String(e.error).slice(0, 200)}`),
  };
}

/**
 * Every workspace package, installed on its own.
 *
 * This is the recipe the package READMEs print, and it needs its own check
 * because two of them used to print `pi install npm:<name>` instead -- which
 * resolves, on npm, to a DIFFERENT author's package for `jev-guard`,
 * `jev-model-router` and `jev-compact`, and to a 404 for the rest. A recipe
 * that installs somebody else's code looks exactly like one that works.
 */
async function packages(): Promise<number> {
  let bad = 0;
  for (const c of ALL) {
    const dir = resolve(import.meta.dirname, "..", c.pkg);
    const { found, notFromPackage, errors } = await loadPath(dir);
    // A package's own `pi` key names one extension: its `src/pi.ts`.
    const good = found.length === 1 && errors.length === 0 && notFromPackage.length === 0;
    if (!good) bad += 1;
    console.log(
      `${good ? "ok  " : "FAIL"} ${c.pkg.padEnd(30)} ${found.join(", ") || "(nothing)"}` +
        `${notFromPackage.length > 0 ? ` NOT VIA THE PI KEY: ${notFromPackage.join(", ")}` : ""}`,
    );
    for (const e of errors) console.log(`       error: ${e}`);
  }
  return bad;
}

async function main(): Promise<void> {
  const only = process.argv[2];
  let bad = 0;
  if (only === undefined || only === "packages") {
    console.log("\n`pi install ./packages/<name>` -- one package at a time, the README recipe\n");
    bad += await packages();
  }
  for (const p of PROFILES) {
    if (only !== undefined && only !== p.dir) continue;
    const { found, notFromPackage, errors } = await loadProfile(p);
    const want = p.components.map((c) => c.name).sort();
    const same = found.join(",") === want.join(",");
    const good = same && errors.length === 0 && notFromPackage.length === 0;
    if (!good) bad += 1;
    console.log(`\n${good ? "ok  " : "FAIL"} pi/${p.dir}: Pi loaded ${found.length} of ${want.length}`);
    console.log(`     found: ${found.join(", ") || "(nothing)"}`);
    if (!same) console.log(`     want:  ${want.join(", ")}`);
    for (const n of notFromPackage) console.log(`     not via the pi key: ${n}`);
    for (const e of errors) console.log(`     error: ${e}`);
  }
  console.log("");
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("load.ts")) await main();
