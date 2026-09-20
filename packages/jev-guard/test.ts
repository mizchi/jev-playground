/**
 * What has to hold before this gate sits in front of an agent. No API key.
 *
 *   npm test
 *
 * The load-bearing checks are the three docs/18 §1 properties, because they
 * are the ones an outage or a bad day exercises and a corpus does not:
 * failure falls through, the gate narrows rather than widens, and a free
 * verdict makes no request. Plus the composition itself, replayed over the
 * recorded answers from docs/18's own findings so the ported numbers are the
 * ported numbers.
 */
import { readFileSync } from "node:fs";
import { Jev, type Answer } from "@jev-playground/jev-core";
import {
  ALLOW,
  ASK,
  DEFAULT_GUARD_CONFIG,
  DENY,
  atomicRule,
  bandOf,
  guard,
  permissionGate,
  resolve,
  stateFor,
  triage,
  verdictOf,
} from "./src/guard.js";

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

/** A recorded answer set, in the wire shape. */
function answers(over: Record<string, number> = {}): Record<string, Answer> {
  const base: Record<string, number> = {
    destructive: 0,
    irreversible: 0,
    outside_project: 0,
    exfiltrates: 0,
    obfuscated: 0,
    privileged: 0,
    affects_others: 0,
    ...over,
  };
  const out: Record<string, Answer> = {};
  for (const k of ["destructive", "irreversible", "outside_project", "exfiltrates", "obfuscated", "privileged", "affects_others"]) {
    out[k] = { type: "noul", noul: base[k] };
  }
  out.blast_radius = {
    type: "score",
    score: over.blast_radius ?? 0,
    confidence: 0.9,
    legend: {},
    probabilities: {},
  };
  if (over.permission !== undefined || over.permission_absent === undefined) {
    out.permission = {
      type: "score",
      score: over.permission ?? 0,
      confidence: over.permission_confidence ?? 0.9,
      legend: {},
      probabilities: {},
    };
  }
  return out;
}

const tests: Promise<void>[] = [];

// -------------------------------------------------- the three properties

tests.push(
  check("every failure path yields no verdict, not allow and not deny", async () => {
    // docs/18 §1(2) and the only part of this file that is about an outage.
    // `allow` would silently approve; `deny` would brick the agent.
    const cwd = process.cwd();
    const cases: [string, () => Promise<{ verdict: unknown; action: string }>][] = [
      [
        "no API key",
        () =>
          guard(
            { toolName: "bash", input: { command: "rm -rf /" }, cwd },
            // An empty key is what a missing env var looks like to the client.
            { config: {}, jev: undefined },
          ),
      ],
      [
        "unreachable endpoint",
        () =>
          guard(
            { toolName: "bash", input: { command: "rm -rf /" }, cwd },
            {
              jev: new Jev({
                apiKey: "x",
                baseUrl: "http://127.0.0.1:1",
                retries: 0,
                timeoutMs: 200,
              }),
            },
          ),
      ],
      [
        "a reply with no ordered score",
        () =>
          guard(
            { toolName: "bash", input: { command: "rm -rf /" }, cwd },
            {
              jev: new Jev({
                apiKey: "x",
                retries: 0,
                fetchImpl: (async () =>
                  new Response(
                    JSON.stringify({
                      model: "jev-latest",
                      answers: answers({ permission_absent: 1, destructive: 1, irreversible: 1 }),
                      usage: { input_tokens: 1, output_tokens: 0 },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  )) as unknown as typeof fetch,
              }),
            },
          ),
      ],
      [
        "a 500",
        () =>
          guard(
            { toolName: "bash", input: { command: "rm -rf /" }, cwd },
            {
              jev: new Jev({
                apiKey: "x",
                retries: 0,
                fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
              }),
            },
          ),
      ],
    ];
    const noKey = { ...process.env };
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFEAI_API_KEY;
    try {
      for (const [name, run] of cases) {
        const r = await run();
        eq(r.verdict, null, `${name}: `);
        eq(r.action, "pass", `${name}: `);
      }
    } finally {
      Object.assign(process.env, noKey);
    }
  }),
);

tests.push(
  check("it narrows and does not widen: a safe verdict emits nothing", () => {
    // docs/18 §1(1). `allow` would override the rules the user configured,
    // and `allowSafe` is the opt-in.
    eq(resolve(ALLOW, DEFAULT_GUARD_CONFIG), "pass");
    eq(resolve(null, DEFAULT_GUARD_CONFIG), "pass");
    eq(resolve(DENY, DEFAULT_GUARD_CONFIG), "block");
  }),
);

tests.push(
  check("an ask resolves to confirm when watched and to block when not", () => {
    // The one place this package is stricter than docs/18's hook, and the
    // reason it is a package rather than a copy: a resident agent has no
    // human to hand an `ask` to.
    eq(resolve(ASK, { ...DEFAULT_GUARD_CONFIG, attended: true }), "confirm");
    eq(resolve(ASK, { ...DEFAULT_GUARD_CONFIG, attended: false }), "block");
    eq(resolve(ASK, { ...DEFAULT_GUARD_CONFIG, attended: false, unattendedAsk: "allow" }), "pass");
  }),
);

tests.push(
  check("a read-only tool is free: no request, no verdict", async () => {
    // A client that would throw if it were used at all.
    const exploding = new Jev({
      apiKey: "x",
      retries: 0,
      fetchImpl: (() => {
        throw new Error("the gate asked about a read-only tool");
      }) as unknown as typeof fetch,
    });
    for (const tool of ["read", "grep", "find", "ls"]) {
      const r = await guard({ toolName: tool, input: { path: "/etc/passwd" }, cwd: process.cwd() }, { jev: exploding });
      ok(r.free, `${tool} was not free`);
      eq(r.verdict, null, `${tool}: `);
    }
  }),
);

// -------------------------------------------------- the composition

tests.push(
  check("the ordered score alone reads at the cutoffs", () => {
    eq(permissionGate(answers({ permission: 0.4 })), ALLOW);
    eq(permissionGate(answers({ permission: 0.5 })), ASK);
    eq(permissionGate(answers({ permission: 1.49 })), ASK);
    eq(permissionGate(answers({ permission: 1.5 })), DENY);
    // The cutoffs are data, so a caller can tighten without touching a question.
    eq(permissionGate(answers({ permission: 0.4 }), { ask: 0.3, deny: 1.5 }), ASK);
  }),
);

tests.push(
  check("the predicates alone are the weaker reading and still fire", () => {
    eq(atomicRule(answers()), ALLOW);
    eq(atomicRule(answers({ exfiltrates: 0.6 })), DENY);
    eq(atomicRule(answers({ obfuscated: 0.8 })), DENY);
    eq(atomicRule(answers({ blast_radius: 2.5 })), DENY);
    // Destructive alone is not enough: it needs irreversible or outside.
    eq(atomicRule(answers({ destructive: 0.9 })), ALLOW);
    eq(atomicRule(answers({ destructive: 0.9, irreversible: 0.6 })), ASK);
    eq(atomicRule(answers({ destructive: 0.9, outside_project: 0.6 })), ASK);
  }),
);

tests.push(
  check("the verdict is the conservative side of both readings", () => {
    // docs/18 §2: 90.3% score-only, 61.1% predicates-only, 94.4% both.
    // Either reading must be able to raise the other.
    eq(verdictOf(answers({ permission: 0.2, exfiltrates: 0.9 })), DENY, "the predicates could not raise the score: ");
    eq(verdictOf(answers({ permission: 1.9 })), DENY, "the score could not stand alone: ");
    eq(verdictOf(answers({ permission: 1.6, blast_radius: 0 })), DENY, "the predicates lowered the score: ");
    eq(verdictOf(answers({ permission: 0.1 })), ALLOW);
  }),
);

tests.push(
  check("docs/18's own recorded near-miss reads the same here as it did there", () => {
    // `rm -rf ./node_modules`: permission 0.43/2 (conf 0.35), blast 0.98/3,
    // destructive 0.96. docs/18 reported the gate rating this `allow` and
    // deferring, against an `ask` label, and argued the LABEL was the
    // conservative one. Replaying it is how the port is checked: if this
    // line ever changes, the composition changed.
    const recorded = answers({ permission: 0.43, permission_confidence: 0.35, blast_radius: 0.98, destructive: 0.96 });
    eq(verdictOf(recorded), ALLOW);
    eq(resolve(verdictOf(recorded), DEFAULT_GUARD_CONFIG), "pass");
  }),
);

tests.push(
  check("a legitimate outbound push is not exfiltration", () => {
    // The hole docs/18 found in the wild: docs/01's wording made every
    // `git push` an exfiltration, because its 24 commands had no legitimate
    // outbound transfer in them. The wording lives in battery.ts; what this
    // checks is that the REASON for it is still written next to it, since a
    // future tidy-up that "simplifies" the criteria back would reopen it.
    const text = readFileSync(new URL("./src/battery.ts", import.meta.url), "utf8");
    ok(
      text.includes("this project's own remote or registry"),
      "the exfiltrates criterion lost the clause that lets an ordinary push through",
    );
    ok(text.includes("git push"), "the reason the criterion is worded this way is no longer recorded next to it");
  }),
);

// -------------------------------------------------- the payload

tests.push(
  check("the state carries the context that makes the same command differ", () => {
    // docs/01's biggest lever. Without cwd/branch, `rm -rf $PATH` is one
    // string and the gate has nothing to tell two cases apart with.
    const state = stateFor(
      { toolName: "bash", input: { command: "git push --force" }, cwd: process.cwd() },
      DEFAULT_GUARD_CONFIG,
    );
    eq(state.command, "git push --force");
    ok(typeof state.cwd === "string", "no cwd in the state");
    ok("on_protected_branch" in state, "no protected-branch fact in the state");
    ok(Array.isArray(state.protected_branches), "the protected branch list did not ride along");
  }),
);

tests.push(
  check("no label, no verdict and no threshold leaks into the payload", () => {
    // The repo-wide rule: a request must not carry the answer. Here the
    // answer would be a cutoff or a verdict name.
    const body = JSON.stringify(
      stateFor({ toolName: "bash", input: { command: "rm -rf /" }, cwd: process.cwd() }, DEFAULT_GUARD_CONFIG),
    );
    for (const word of ["allow", "deny", "verdict", "threshold", "0.5", "1.5"]) {
      ok(!body.includes(word), `the state leaks "${word}"`);
    }
  }),
);

tests.push(
  check("a non-shell tool is asked about but labelled uncalibrated", () => {
    // docs/18 §1: a gate should not be applied to tools it was never
    // calibrated on. This package does apply it, and the band is how it
    // stays honest about that.
    eq(bandOf({ toolName: "write", input: { path: "a" } }), "uncalibrated");
    eq(bandOf({ toolName: "bash", input: { command: "ls" } }), "shell");
    eq(bandOf({ toolName: "read", input: { path: "a" } }), "read-only");
    // A "bash" tool with no command is not the measured surface either.
    eq(bandOf({ toolName: "bash", input: {} }), "uncalibrated");
    eq(triage({ toolName: "write", input: {} }, { ...DEFAULT_GUARD_CONFIG, scope: "shell" }).ask, false);
    eq(triage({ toolName: "write", input: {} }, { ...DEFAULT_GUARD_CONFIG, scope: "writes" }).ask, true);
  }),
);

await Promise.all(tests);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
