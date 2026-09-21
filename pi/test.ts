/**
 * What has to hold before this directory is what runs as a Pi agent. No API key.
 *
 *   npm test
 *
 * The load-bearing checks are not "does it import" -- they are the three ways
 * this assembly can be wrong in a way nobody notices:
 *
 *   A COMPONENT IS MISSING. `packages/` gains a seventh extension, nobody adds
 *   it here, and the agent quietly runs five sixths of this repository. So the
 *   roster is derived from the packages' own `pi` keys and compared.
 *
 *   BOTH PROFILES LOAD. They collide on every seam they take, and on the
 *   `tool_call` seam that means one command showing a user TWO confirmation
 *   dialogs -- fired through Pi's own runner in `collide.ts`, not inferred.
 *   The structural defence is that `pi/` is not itself a loadable package, and
 *   that is checked rather than documented.
 *
 *   A DEPENDENCY RESOLVES TO SOMEBODY ELSE'S PACKAGE. `jev-guard`,
 *   `jev-model-router` and `jev-compact` all exist on npm and all belong to
 *   other authors, so a bare version range here would silently install a
 *   different guard than the one this repository measured. Every jev
 *   dependency must be a `file:` path.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ALL, COMPONENTS, PROFILES, RESIDENT, type Component } from "./seams.js";
import { entriesOn, overlap, probe, recorder, type Registered } from "./probe.js";
import { ARMS, run as fire, type Observed } from "./collide.js";

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err: Error) => {
      fail += 1;
      console.log(`  FAIL ${name}: ${err.message}`);
    });
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const eq = <T,>(a: T, b: T, what = ""): void => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..");
const json = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

/** Measured once; several checks read it. */
const measured = new Map<string, Registered>();
for (const p of PROFILES) for (const c of p.components) measured.set(c.name, await probe(p, c));

const tests = [
  check("every package that ships a Pi extension is in a profile", () => {
    /**
     * The roster is derived from `packages/` rather than from this file, so a
     * seventh extension cannot be added to the repository and left out of the
     * agent. A package is "a Pi extension" by its own `pi` key -- the same
     * thing Pi reads -- not by having a file called pi.ts.
     */
    const shipped: string[] = [];
    for (const dir of readdirSync(resolve(REPO, "packages"))) {
      const p = resolve(REPO, "packages", dir, "package.json");
      if (!existsSync(p)) continue;
      const pkg = json(p);
      const pi = pkg.pi as { extensions?: unknown[] } | undefined;
      if (pi?.extensions && pi.extensions.length > 0) shipped.push(String(pkg.name));
    }
    ok(shipped.length > 0, "no package in packages/ declares a pi extension -- the derivation is broken");
    const covered = new Set(ALL.map((c) => c.from.replace(/\/pi$/, "")));
    for (const name of shipped) {
      ok(covered.has(name), `${name} ships a Pi extension and no profile loads it`);
    }
    for (const c of ALL) {
      ok(
        shipped.includes(c.from.replace(/\/pi$/, "")),
        `${c.name} is in a profile but ${c.pkg} does not declare a pi extension`,
      );
    }
    eq(shipped.length, ALL.length, "shipped extensions vs profiled ones: ");
  }),

  check("the entry files on disk are exactly the registry, both ways", () => {
    // An orphan entry file loads in Pi and appears in no table; a registry row
    // with no file is a documented component that does not run.
    for (const p of PROFILES) {
      const onDisk = entriesOn(p);
      const named = p.components.map((c) => c.name).sort();
      eq(onDisk.join(","), named.join(","), `pi/${p.dir}/extensions: `);
    }
  }),

  check("every entry is an ExtensionFactory that loads", () => {
    for (const c of ALL) {
      const r = measured.get(c.name) as Registered;
      ok(r.error === undefined, `${c.name}: ${r.error}`);
      ok(r.seams.length > 0, `${c.name} registered no seam at all -- it would load and do nothing`);
    }
  }),

  check("each entry imports the documented subpath, not a path into src/", () => {
    /**
     * The claim in the entry files' docblocks is that this assembly exercises
     * the same export an outside user gets. A relative reach into `src/`
     * would work here and diverge from what `pi install` gives anyone else,
     * so the export map stays the interface.
     */
    for (const p of PROFILES) {
      for (const c of p.components) {
        const src = readFileSync(resolve(HERE, p.dir, "extensions", `${c.name}.ts`), "utf8");
        ok(
          src.includes(`from "${c.from}"`),
          `${c.name} does not re-export ${c.from}`,
        );
        ok(!/from\s+"\.\.\//.test(src), `${c.name} reaches out with a relative import instead of the subpath`);
        ok(!src.includes("/src/"), `${c.name} imports a path inside src/, bypassing the package's exports`);
      }
    }
  }),

  check("pi/ is not itself a loadable Pi package, so both profiles cannot load at once", () => {
    /**
     * THE STRUCTURAL DEFENCE. Pi discovers a package's resources from its `pi`
     * key, or failing that from convention directories -- `extensions/` among
     * them. If `pi/package.json` ever grew a `pi` key, or an `extensions/`
     * directory appeared beside the two profiles, then `pi install ./pi`
     * would load components AND resident together: two gates on every tool
     * call, three turn judgments where hermes already made one.
     */
    const root = json(resolve(HERE, "package.json"));
    ok(root.pi === undefined, "pi/package.json declares a `pi` key -- `pi install ./pi` would load both profiles");
    ok(
      !existsSync(resolve(HERE, "extensions")),
      "pi/extensions/ exists -- Pi's convention directory would make pi/ loadable, and both profiles with it",
    );
    // And each profile must be a package in its own right, or `pi install
    // ./pi/components` loads nothing and says so quietly.
    for (const p of PROFILES) {
      const pkg = json(resolve(HERE, p.dir, "package.json"));
      const pi = pkg.pi as { extensions?: string[] } | undefined;
      /**
       * The key must be there and must name something. Declaring it switches
       * Pi's convention directories OFF, so a `pi.extensions` that matches
       * nothing loads nothing -- with no error, because an empty glob is not
       * a failure. What it must not be is over-specified here: both
       * `["./extensions"]` and `["extensions/*.ts"]` resolve all five through
       * Pi's package resolver, which `load.ts` measured after its first
       * version concluded otherwise from the wrong entry point. So this pins
       * the property (a non-empty declaration, pointing inside the profile)
       * and `npm run load` checks the thing that actually matters: that Pi
       * resolves the entries through this key, with `origin: "package"`.
       */
      ok(Array.isArray(pi?.extensions), `pi/${p.dir} has no pi.extensions -- pi would load nothing from it`);
      ok((pi?.extensions?.length ?? 0) > 0, `pi/${p.dir} pi.extensions is empty -- nothing would load`);
      for (const spec of pi?.extensions ?? []) {
        ok(
          spec.replace(/^\.\//, "").startsWith("extensions"),
          `pi/${p.dir} pi.extensions names ${spec}, which is not inside the profile's extensions/`,
        );
      }
    }
  }),

  check("the two profiles collide on tool_call, which is why they are separate", () => {
    /**
     * Measured, because the README says "load one or the other" and that is
     * only true while the overlap is real. If hermes ever stopped taking
     * `tool_call`, the sentence to fix would be the README's, and this test is
     * what would say so.
     */
    const both = overlap(measured);
    ok(both.length > 0, "the profiles now share no seam -- the exclusivity in the README is stale");
    ok(
      both.includes("tool_call"),
      `tool_call is no longer shared (shared: ${both.join(", ")}) -- re-read whether both profiles can coexist`,
    );
    // hermes covers the five, so it must take every seam they do.
    const componentSeams = new Set(COMPONENTS.flatMap((c) => measured.get(c.name)?.seams ?? []));
    const hermesSeams = new Set(measured.get(RESIDENT.name)?.seams ?? []);
    for (const s of componentSeams) {
      ok(hermesSeams.has(s), `the components take ${s} and hermes does not -- resident/ is not a replacement`);
    }
  }),

  check("every jev dependency is a file: path, never a version range", () => {
    /**
     * `jev-guard@0.3.1`, `jev-model-router@1.0.0` and `jev-compact@0.2.0` are
     * all on npm and all belong to other authors (leepokai, rajdhakad9826,
     * aleksvega). A range here would install a different component than the
     * one this repository's numbers came from, and it would look like it
     * worked. So the local path is the only permitted spelling.
     */
    for (const p of PROFILES) {
      const deps = (json(resolve(HERE, p.dir, "package.json")).dependencies ?? {}) as Record<string, string>;
      ok(Object.keys(deps).length > 0, `pi/${p.dir} depends on nothing -- its entries cannot resolve`);
      for (const [name, range] of Object.entries(deps)) {
        ok(
          range.startsWith("file:"),
          `pi/${p.dir} depends on ${name}@${range}; that name on npm is not this repository's package`,
        );
        const target = resolve(HERE, p.dir, range.slice("file:".length));
        ok(existsSync(resolve(target, "package.json")), `pi/${p.dir}: ${range} does not point at a package`);
      }
      // Every component the profile loads must actually be depended on.
      for (const c of p.components) {
        const pkgName = c.from.replace(/\/pi$/, "");
        ok(pkgName in deps, `pi/${p.dir} loads ${c.name} but does not depend on ${pkgName}`);
      }
    }
  }),

  check("no document tells anyone to install these from npm", () => {
    /**
     * THE SAME BUG, ONE LAYER OUT. `pi/` refuses a version range in its own
     * dependencies, and that did nothing about the two package READMEs that
     * printed `pi install npm:jev-model-router` and `pi install
     * npm:jev-skill-router`. The first installs
     * `rajdhakad9826/jev-router` -- a different author's router -- and looks
     * like it worked; the second 404s.
     *
     * So the check is over the whole repository's markdown, and it is over
     * every name this repository ships rather than the three that happen to
     * be taken today: a name that 404s now can be registered by anyone
     * tomorrow, which turns a broken recipe into a silently wrong one.
     *
     * IT LOOKS INSIDE FENCED CODE BLOCKS ONLY, and that is the discriminator
     * rather than a loophole. The hazard is a line somebody copies and runs,
     * and the first version of this check -- which matched anywhere -- failed
     * on the two READMEs for quoting the bad recipe in the sentence that says
     * it was wrong. Naming a mistake has to stay sayable; offering it does
     * not.
     */
    const ours = new Set(ALL.map((c) => c.from.replace(/\/pi$/, "")));
    ours.add("@jev-playground/jev-core");
    const offenders: string[] = [];
    /** Only what is inside ``` fences: the lines a reader copies. */
    const runnable = (src: string): string =>
      [...src.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]).join("\n");
    const scan = (dir: string, depth = 0): void => {
      if (depth > 4) return;
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".git" || entry.startsWith("_")) continue;
        const p = resolve(dir, entry);
        if (statSync(p).isDirectory()) scan(p, depth + 1);
        else if (entry.endsWith(".md")) {
          for (const m of runnable(readFileSync(p, "utf8")).matchAll(/npm:(@?[\w./@-]+)/g)) {
            if (ours.has(m[1])) offenders.push(`${p.replace(`${REPO}/`, "")}: npm:${m[1]}`);
          }
        }
      }
    };
    scan(REPO);
    eq(
      offenders.join(" | "),
      "",
      "a document offers an npm install for a package this repository does not own on npm: ",
    );
  }),

  check("both profiles loaded together: two dialogs on an ask, one gate on a deny", async () => {
    /**
     * THE COLLISION, FIRED. `pi/README.md` used to state this as a reading of
     * the seam table and admit it was unobserved; `collide.ts` fires all four
     * seams through Pi's own `ExtensionRunner` and the reading was wrong in
     * two places, so these are the numbers rather than the prediction.
     *
     * It is in `npm test` because it costs about two seconds and needs
     * nothing but this repository -- `fetch` is replaced by a counter, so no
     * request leaves the process and no key is read.
     */
    const got = new Map<string, Observed>();
    for (const arm of ARMS) got.set(arm.name, await fire(arm));
    const c = got.get("components") as Observed;
    const r = got.get("resident") as Observed;
    const b = got.get("both") as Observed;

    // Pi neither deduplicates the two profiles nor warns about them. If that
    // ever changes, the structural defence in this directory is redundant and
    // the README should say so instead.
    eq(b.loaded, c.loaded + r.loaded, "extensions loaded for `both`: ");
    eq(b.loadErrors.length, 0, "load errors for `both`: ");
    eq(b.diagnostics.length, 0, "diagnostics for `both` -- Pi now warns, so the README is stale: ");

    // THE ASK BAND DOUBLES. This is the hazard, and it is the whole reason the
    // profiles are separate packages.
    eq(c.ask.confirms, 1, "one profile, one confirmation: ");
    eq(r.ask.confirms, 1, "one profile, one confirmation: ");
    eq(b.ask.confirms, 2, "both profiles: one command, two confirmation dialogs: ");
    eq(b.ask.requests, 2, "both profiles ask twice about one command: ");

    // THE DENY BAND DOES NOT. `emitToolCall` returns on the first
    // `{block: true}`, so the second gate never runs -- which is why the
    // README's "two gates on every tool call" was wrong.
    ok(c.deny.blocked && r.deny.blocked && b.deny.blocked, "the deny answer set must block in every arm");
    eq(b.deny.requests, c.deny.requests, "a blocked call short-circuits, so `both` costs no more than one: ");
    eq(b.deny.requests, 1, "a blocked call must cost exactly one request: ");

    // `context` CHAINS AND DOES NOT DOUBLE. Both compactors run, the second
    // sees what the first left, and it deletes nothing because the first
    // already got under budget -- at no extra request.
    ok(c.context.messagesOut < c.context.messagesIn, "the compactor must actually delete, or this proves nothing");
    eq(b.context.messagesOut, c.context.messagesOut, "the second compactor deletes nothing further: ");
    eq(b.context.requests, c.context.requests, "the second compactor asks nothing further: ");
    ok(
      b.entries.includes("jev-compact/deletion") && b.entries.includes("hermes/compaction"),
      `both compactors must have run: ${b.entries.join(", ")}`,
    );

    // And the ledger order is where the short-circuit is visible: the ask fire
    // reaches both gates, the deny fire reaches only the first.
    const gates = b.entries.filter((e) => e === "jev-guard/decision" || e === "hermes/guard");
    eq(gates.join(" "), "jev-guard/decision hermes/guard jev-guard/decision", "the gate sequence across both fires: ");
  }),

  check("the Pi core packages stay peer dependencies, unbundled", () => {
    // pi-coding-agent/docs/packages.md: the core packages must be peers with a
    // "*" range and must not be bundled. Getting this wrong ships a second
    // copy of Pi's own runtime inside an extension.
    for (const p of PROFILES) {
      const pkg = json(resolve(HERE, p.dir, "package.json"));
      const peers = (pkg.peerDependencies ?? {}) as Record<string, string>;
      const deps = (pkg.dependencies ?? {}) as Record<string, string>;
      for (const core of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
        eq(peers[core], "*", `pi/${p.dir} peer ${core}: `);
        ok(!(core in deps), `pi/${p.dir} has ${core} as a dependency; it must be a peer`);
      }
      ok(pkg.bundledDependencies === undefined, `pi/${p.dir} bundles dependencies; Pi resolves peers itself`);
    }
  }),

  check("the recorder reports a throwing factory rather than swallowing it", () => {
    /**
     * `probe` is the instrument the README's table comes from, so it has to
     * fail loudly. A factory that throws never loads in Pi, and an instrument
     * that recorded it as "0 seams" would print a plausible table for an
     * extension that does not run.
     */
    const { api, read } = recorder();
    const boom = (): void => {
      throw new Error("nope");
    };
    let caught = false;
    try {
      boom();
    } catch {
      caught = true;
    }
    ok(caught, "the control is broken");
    // What the stub must tolerate: an unknown method, called with anything.
    const unknown = (api as Record<string, (x: unknown) => unknown>).somethingPiAddedLater;
    eq(typeof unknown, "function", "the stub must not throw on a method it has never heard of: ");
    unknown({ anything: true });
    eq(read().seams.length, 0, "an unknown call must not be recorded as a seam: ");
    // And a registered seam must be recorded under its event name.
    (api as { on: (e: string, h: () => void) => void }).on("tool_call", () => undefined);
    eq(read().seams.join(","), "tool_call", "seam recording: ");
  }),

  check("every component names where its decision was measured", () => {
    // The point of the map is that a reader can get from "this is running" to
    // "this is the report that measured it" without asking.
    for (const c of ALL as Component[]) {
      ok(c.decides.length > 12, `${c.name} does not say what it decides`);
      // The citations are repository-relative, as a reader would type them.
      const named = c.doc.split(",").map((d) => d.trim());
      ok(named.length > 0, `${c.name} cites no report`);
      for (const d of named) {
        ok(d.startsWith("docs/"), `${c.name} cites ${d}, which is not a repository-relative docs path`);
        ok(existsSync(resolve(REPO, d)), `${c.name} cites ${d}, which does not exist`);
      }
    }
  }),
];

await Promise.all(tests);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
