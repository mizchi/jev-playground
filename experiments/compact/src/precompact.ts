/**
 * Does rewriting the summariser's instructions keep more facts? [TODO §1.3]
 *
 *   tsx src/precompact.ts --seams     what the two compaction hooks can do
 *   tsx src/precompact.ts             the A/B, recorded
 *   tsx src/precompact.ts --show      re-read the record, no key needed
 *
 * READ THIS FIRST: THIS IS NOT AN EVALUATION OF A JEV COMPONENT. docs/43 §0
 * established that `jev-compact` cannot be wired into this host at all -- its
 * design is "delete, never summarise" (docs/39) and the host's compaction seam
 * hands a summariser instructions. So the thing measured here is **the host's
 * own summariser**, and the only jev-shaped question is whether a cheap
 * judgment could usefully sit in front of it. TODO §1.3 says to write that
 * down, so it is written down here and in the report's own header.
 *
 * WHAT THE SEAMS TURNED OUT TO BE, read off the installed binary rather than
 * assumed, and it is more than TODO §1.3 expected:
 *
 *   PreCompact    { trigger: "manual"|"auto", custom_instructions: string|null }
 *   PostCompact   { trigger: "manual"|"auto", compact_summary: string }
 *
 * **`PostCompact` hands over the summary itself.** TODO §1.3 planned to infer
 * fact survival from downstream behaviour; it can be scored directly instead,
 * against `records/corpus.json`'s planted facts, with the same window check
 * docs/42 §1.2 used (imported, not reimplemented -- see `judge`).
 *
 * AND ON THE WAY OUT, ONLY ONE OF THEM CAN CHANGE ANYTHING. TODO §1.5's first
 * candidate was to splice measured values back into the finished summary
 * through `PostCompact`, and asked for a wire check before anything was built.
 * Read off the same binary, the two executors return different shapes:
 *
 *   PreCompact   -> { newCustomInstructions: <the hook's stdout> }
 *   PostCompact  -> { userDisplayMessage: "PostCompact [cmd] completed: ..." }
 *
 * So `PostCompact` is an OBSERVER: its stdout becomes a line shown to the
 * person, and the summary it was handed is already committed. **The splice is
 * impossible**, and the only channel into the summary is `PreCompact`'s stdout
 * becoming the instructions -- which is what the `oracle` arm below uses, and
 * why "pass the values in the instructions" is the only surviving candidate
 * rather than the second-best one.
 *
 * And compaction can be driven headlessly, which was the other thing in doubt:
 * `claude -p "/compact" --resume <session-id>` fires both hooks with
 * `trigger: "manual"`. That "manual" is a real limit and §3 says so: the
 * compaction that matters in production is the automatic kind, which needs
 * 100k+ tokens of context to fire (`--autocompact` will not go below that).
 *
 * HOW THE CONVERSATION GETS THERE. The corpus's transcripts are 57-63 entries
 * of user/assistant/tool. Replaying them as real turns would cost O(n^2)
 * tokens, so they are written straight into the host's session JSONL, which is
 * the format `--resume` reads. That is a harness writing the input to the thing
 * under test, which in this programme has gone wrong three times in one day
 * (docs/44 §4.5b), so `--seams` verifies at the wire that the summariser
 * actually READ the synthesized conversation before any number is believed.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { judge, type Transcript } from "../../versus/src/compaction.js";

const HERE = import.meta.dirname;
const RECORDS = resolve(HERE, "../records");
const PATH = resolve(RECORDS, "precompact.json");
const MODEL = "claude-haiku-4-5-20251001";

/**
 * The instructions the `instructed` arm hands the summariser.
 *
 * Deliberately about SHAPE, not about this corpus. It names no package, no
 * number and no file, so it cannot be a lookup table for the facts it is
 * scored on -- which is the way this arm could most easily cheat. docs/24 §2's
 * rule: the selector is code, the predicate is one sentence.
 */
export const KEEP_FACTS =
  "When you summarise, preserve every concrete measured value verbatim next to " +
  "the thing it measures: counts, file paths, identifiers, versions, exit codes " +
  "and command output. Prefer dropping narrative to dropping a number. If a " +
  "tool printed a figure that answers the user's question, quote it.";

/**
 * The `oracle` arm's instructions: THIS transcript's measured values, verbatim.
 *
 * TODO §1.5 asks whether a cheap judgment in front of the summariser -- "does
 * this entry contain a measured value?" -- would be worth building, and lists
 * "pass the values in `custom_instructions`" as candidate 2 while noting it is
 * "**ほぼ同語反復**" (nearly tautological): hand over the facts, see whether the
 * facts survive.
 *
 * THE TAUTOLOGY IS THE POINT, because it makes this an UPPER BOUND rather than
 * a result. Whatever a classifier could ever supply, it cannot beat being
 * handed the exact answer strings. So:
 *
 *   oracle does not beat `plain`  ->  the seam does not control the output, and
 *                                     no classifier in front of it can help.
 *                                     The design is dead without building it.
 *   oracle reaches the ceiling    ->  the design is viable, and the remaining
 *                                     question is jev's accuracy at picking the
 *                                     strings -- which needs a fact corpus
 *                                     bigger than nine (§1.5 candidate 3).
 *
 * This arm is NOT a jev measurement and must never be quoted as one. It is the
 * measurement that says whether a jev measurement here is worth taking, which
 * is docs/24 §2's order (cheap probe before expensive sweep) applied to a
 * design instead of to an arm -- the same move that saved docs/44 §1.3 an hour.
 */
export function oracleInstructions(t: Transcript): string {
  const list = t.facts.map((f) => `"${f.text}"`).join(", ");
  return (
    "Your summary must contain these exact strings verbatim, each next to what it " +
    `measures: ${list}. They are the measured values this conversation established; ` +
    "reproduce them character for character rather than paraphrasing or rounding them."
  );
}

export interface Arm {
  name: string;
  /** Passed after `/compact`. Empty means the host's default summariser prompt. */
  instructions: string;
  /**
   * Per-transcript instructions, when the arm's text depends on the corpus
   * entry. Overrides `instructions` for that run. Only `oracle` uses it, and
   * `--seams` prints what actually reached the host either way.
   */
  build?: (t: Transcript) => string;
}

export const ARMS: Arm[] = [
  { name: "plain", instructions: "" },
  { name: "instructed", instructions: KEEP_FACTS },
  /**
   * `plain` A SECOND TIME, under a different name. The control against itself.
   *
   * Added after the first full sweep came back 7/9 for both arms with one
   * transcript better and one worse -- a 1-vs-1 flip on 8 transcripts, which
   * could be the instructions doing two small opposite things or could be the
   * summariser being a draw. Those are different findings and a caveat cannot
   * separate them.
   *
   * So this arm asks the question that docs/44 §1.3 got for free and this one
   * has to pay for: **how much does the same request move between draws?** If
   * `plain` disagrees with itself as much as it disagrees with `instructed`,
   * the arm comparison is not measurable at this n and the honest output is to
   * say so with a number.
   */
  { name: "plainagain", instructions: "" },
  /** The upper bound. See `oracleInstructions`. [TODO §1.5] */
  { name: "oracle", instructions: "", build: oracleInstructions },
];

export interface Row {
  transcript: string;
  arm: string;
  kept: number;
  invented: number;
  absent: number;
  checkable: number;
  facts: number;
  /** Characters of summary the host produced. */
  summaryChars: number;
  /** Tokens the conversation held before compaction, from the corpus. */
  tokensBefore: number;
  ms: number;
  /** What the PreCompact hook saw, so the arm is verified rather than assumed. */
  sawInstructions: string | null;
  summary: string;
  error?: string;
}

export interface Record_ {
  note: string;
  rows: Row[];
}

// ---------------------------------------------------------------- the seam

/** Where the host keeps a project's sessions. Mirrors its own encoding. */
function sessionDir(cwd: string): string {
  return resolve(homedir(), ".claude/projects", cwd.replace(/\//g, "-"));
}

/**
 * Write a corpus transcript into the host's session format.
 *
 * The `tool` entries become a `tool_use` / `tool_result` pair, because that is
 * what they were: a summariser that sees tool output as prose is being shown a
 * different conversation. `--seams` checks whether this worked.
 */
function seed(t: Transcript, cwd: string, sessionId: string): string {
  const dir = sessionDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  let parent: string | null = null;
  const at = (i: number): string => new Date(Date.now() - (t.entries.length - i) * 1000).toISOString();
  let pendingToolUse: string | null = null;

  for (const [i, e] of t.entries.entries()) {
    const uuid = randomUUID();
    if (e.role === "user") {
      lines.push(
        JSON.stringify({
          parentUuid: parent,
          isSidechain: false,
          type: "user",
          message: { role: "user", content: e.text },
          uuid,
          timestamp: at(i),
          cwd,
          sessionId,
          version: "1.0.0",
          userType: "external",
        }),
      );
    } else if (e.role === "assistant") {
      // An assistant turn that is about to be followed by a tool result has to
      // CARRY the tool_use, or the result below has nothing to attach to and
      // the host reads a dangling block.
      const next = t.entries[i + 1];
      const willCall = next?.role === "tool";
      const toolId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      if (willCall) pendingToolUse = toolId;
      lines.push(
        JSON.stringify({
          parentUuid: parent,
          isSidechain: false,
          type: "assistant",
          message: {
            role: "assistant",
            model: MODEL,
            content: willCall
              ? [
                  { type: "text", text: e.text },
                  { type: "tool_use", id: toolId, name: "Bash", input: { command: e.label ?? "command" } },
                ]
              : [{ type: "text", text: e.text }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          uuid,
          timestamp: at(i),
          cwd,
          sessionId,
          version: "1.0.0",
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          parentUuid: parent,
          isSidechain: false,
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: pendingToolUse ?? `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                content: e.text,
              },
            ],
          },
          uuid,
          timestamp: at(i),
          cwd,
          sessionId,
          version: "1.0.0",
          toolUseResult: { stdout: e.text, stderr: "", interrupted: false },
        }),
      );
      pendingToolUse = null;
    }
    parent = uuid;
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** The hook pair, written into the sandbox so the host loads them. */
function installHooks(cwd: string, logPath: string): void {
  const hook = resolve(cwd, "capture.mjs");
  writeFileSync(
    hook,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, readFileSync } from "node:fs";',
      "let e = {};",
      'try { e = JSON.parse(readFileSync(0, "utf8")); } catch {}',
      "appendFileSync(process.env.PC_LOG, `${JSON.stringify({",
      "  event: e.hook_event_name,",
      "  trigger: e.trigger ?? null,",
      "  custom_instructions: e.custom_instructions ?? null,",
      "  compact_summary: typeof e.compact_summary === 'string' ? e.compact_summary : null,",
      "})}\\n`);",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  mkdirSync(resolve(cwd, ".claude"), { recursive: true });
  const one = [{ matcher: "*", hooks: [{ type: "command", command: `node ${hook}`, timeout: 25 }] }];
  writeFileSync(
    resolve(cwd, ".claude/settings.json"),
    `${JSON.stringify({ hooks: { PreCompact: one, PostCompact: one } }, null, 2)}\n`,
  );
}

interface Captured {
  sawInstructions: string | null;
  summary: string;
  ms: number;
  error?: string;
}

/** Seed a conversation, compact it, and capture what the host produced. */
function compact(t: Transcript, arm: Arm, root: string): Captured {
  const cwd = resolve(root, `${t.id}-${arm.name}`);
  mkdirSync(cwd, { recursive: true });
  const logPath = resolve(cwd, "hooks.jsonl");
  writeFileSync(logPath, "");
  installHooks(cwd, logPath);
  const sessionId = randomUUID();
  const transcript = seed(t, cwd, sessionId);
  const instructions = arm.build ? arm.build(t) : arm.instructions;
  const started = Date.now();
  const out = spawnSync(
    "claude",
    ["-p", instructions ? `/compact ${instructions}` : "/compact", "--resume", sessionId, "--model", MODEL],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PC_LOG: logPath },
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ms = Date.now() - started;
  const seen = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as { event?: string; custom_instructions?: string; compact_summary?: string }];
          } catch {
            return [];
          }
        })
    : [];
  const pre = seen.find((x) => x.event === "PreCompact");
  const post = seen.find((x) => x.event === "PostCompact");
  rmSync(transcript, { force: true });
  return {
    sawInstructions: pre?.custom_instructions ?? null,
    summary: post?.compact_summary ?? "",
    ms,
    ...(post
      ? {}
      : { error: `no PostCompact: ${(out.stderr ?? "").slice(0, 200) || (out.stdout ?? "").slice(0, 200)}` }),
  };
}

// ------------------------------------------------------------------- report

const NOTE =
  "Does rewriting the summariser's instructions keep more of the conversation's " +
  "facts. THE HOST'S SUMMARISER is the thing measured, not a jev component: " +
  "jev-compact deletes rather than summarises and cannot be wired here at all " +
  "(docs/43 §0). Facts and transcripts from records/corpus.json; the window " +
  "check is docs/42 §1.2's `judge`, imported rather than reimplemented.";

function transcripts(): Transcript[] {
  return (JSON.parse(readFileSync(resolve(RECORDS, "corpus.json"), "utf8")) as { transcripts: Transcript[] })
    .transcripts;
}

const pct = (x: number, n: number): string => (n === 0 ? "—" : `${((100 * x) / n).toFixed(0)}%`);

/**
 * Exact two-sided sign test on the discordant pairs.
 *
 * Here to keep a saturated arm honest: `oracle` lands on 9/9, which reads as
 * decisive until the pair count is next to it. Three discordant pairs cannot
 * produce a two-sided p below 0.25, so the arm's value is that it saturates,
 * not that it separates.
 */
function signTest(less: number, more: number): number {
  const n = less + more;
  if (n === 0) return 1;
  const choose = (k: number): number => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  };
  let tail = 0;
  for (let i = 0; i <= Math.min(less, more); i++) tail += choose(i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

function show(rec: Record_): void {
  console.log("\n# Does rewriting the summariser's instructions keep more facts?\n");
  console.log(
    "**This measures THE HOST'S SUMMARISER, not a jev component.** `jev-compact` deletes rather than\n" +
      "summarises, so it cannot be wired into this seam at all (docs/43 §0) -- TODO §1.3 asked for this\n" +
      "measurement anyway, and asked that the distinction be stated rather than blurred. Stated.\n",
  );
  const byArm = (name: string): Row[] => rec.rows.filter((r) => r.arm === name && !r.error);
  console.log("| arm | instructions reached the host | facts kept | invented | absent | median summary | median ms |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  const med = (xs: number[]): number =>
    xs.length === 0 ? Number.NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const arm of ARMS) {
    const g = byArm(arm.name);
    if (g.length === 0) continue;
    const kept = g.reduce((n, r) => n + r.kept, 0);
    const facts = g.reduce((n, r) => n + r.facts, 0);
    const saw = g.filter((r) => (r.sawInstructions ?? "").length > 0).length;
    console.log(
      `| \`${arm.name}\` | ${arm.instructions || arm.build ? `**${saw}/${g.length}**` : `n/a (none sent)`} | ` +
        `**${pct(kept, facts)}** (${kept}/${facts}) | ${g.reduce((n, r) => n + r.invented, 0)} | ` +
        `${g.reduce((n, r) => n + r.absent, 0)} | ${med(g.map((r) => r.summaryChars))} chars | ` +
        `${med(g.map((r) => r.ms))} |`,
    );
  }

  // PAIRED, because n is 8 transcripts and an unpaired difference of one fact
  // reads as twelve points.
  const paired = transcripts()
    .map((t) => {
      const a = rec.rows.find((r) => r.transcript === t.id && r.arm === "plain" && !r.error);
      const b = rec.rows.find((r) => r.transcript === t.id && r.arm === "instructed" && !r.error);
      return a && b ? { id: t.id, plain: a, instructed: b } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (paired.length > 0) {
    console.log("\n## Per transcript, paired\n");
    console.log("| transcript | tokens before | facts | `plain` kept | `instructed` kept |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const p of paired) {
      const same = p.plain.kept === p.instructed.kept;
      console.log(
        `| \`${p.id}\` | ${p.plain.tokensBefore.toLocaleString()} | ${p.plain.facts} | ` +
          `${p.plain.kept}${same ? "" : p.instructed.kept > p.plain.kept ? "" : " **←**"} | ` +
          `${p.instructed.kept}${same ? "" : p.instructed.kept > p.plain.kept ? " **←**" : ""} |`,
      );
    }
    const up = paired.filter((p) => p.instructed.kept > p.plain.kept).length;
    const down = paired.filter((p) => p.instructed.kept < p.plain.kept).length;
    console.log(
      `\n**${up} transcript${up === 1 ? "" : "s"} better with the instructions, ${down} worse, ` +
        `${paired.length - up - down} the same.** ` +
        (up + down === 0
          ? "**No discordant pair at all**, so this corpus cannot separate the two -- 8 transcripts with " +
            "1-2 facts each is 9 facts in total, and a measure that moves in whole facts cannot resolve " +
            "less than a ninth."
          : `Paired, ${up} vs ${down} of ${paired.length}. With ${paired.length} transcripts this is a ` +
            "direction, not a result."),
    );
  }

  // THE DRAW, MEASURED, so the null above can be read. `plainagain` is `plain`
  // with the same (absent) instructions, so any per-transcript disagreement
  // between them is the summariser's own variation and nothing else.
  const self = transcripts()
    .map((t) => {
      const a = rec.rows.find((r) => r.transcript === t.id && r.arm === "plain" && !r.error);
      const b = rec.rows.find((r) => r.transcript === t.id && r.arm === "plainagain" && !r.error);
      return a && b ? { id: t.id, a, b } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (self.length > 0) {
    const moved = self.filter((p) => p.a.kept !== p.b.kept);
    const armPairs = transcripts()
      .map((t) => {
        const a = rec.rows.find((r) => r.transcript === t.id && r.arm === "plain" && !r.error);
        const b = rec.rows.find((r) => r.transcript === t.id && r.arm === "instructed" && !r.error);
        return a && b && a.kept !== b.kept ? t.id : null;
      })
      .filter(Boolean);
    console.log(
      `\n## How much does the same request move? (\`plainagain\` is \`plain\` again)\n\n` +
        `**\`plain\` disagrees with ITSELF on ${moved.length} of ${self.length} transcripts** ` +
        `(${moved.map((p) => `\`${p.id}\` ${p.a.kept}->${p.b.kept}`).join(", ") || "none"}), against ` +
        `${armPairs.length} where it disagrees with \`instructed\`.\n\n` +
        (moved.length >= armPairs.length
          ? "**So the arm comparison is not measurable at this n.** The summariser moves between draws by at " +
            "least as much as the instructions move it, on 8 transcripts carrying 9 facts. That is not a " +
            "caveat about the null result above -- it is the reason the null result cannot be interpreted, " +
            "and it took one extra arm to say it with a number instead of a hedge."
          : "The instructions move more than the draw does, so the per-transcript column above is worth " +
            "reading. It is still 8 transcripts.") +
      "\n",
    );
  }

  // ---------------------------------------------------- TODO §1.5's oracle
  const oracleRows = byArm("oracle");
  if (oracleRows.length > 0) {
    const plainRows = byArm("plain");
    const againRows = byArm("plainagain");
    const sum = (rs: Row[], k: "kept" | "facts" | "invented"): number => rs.reduce((n, r) => n + r[k], 0);
    console.log("\n## Is a judgment in front of the summariser worth building? [TODO §1.5]\n");
    console.log(
      "**This section's arm is an UPPER BOUND, not a jev result.** `oracle` hands the summariser this " +
        "transcript's measured values as exact strings and tells it to reproduce them character for " +
        "character. No classifier can do better than being given the answer, so if the ceiling is not " +
        "above the floor there is nothing to build -- and the design is refuted without writing the " +
        "component. TODO §1.5 called this candidate \"nearly tautological\"; the tautology is what makes " +
        "it a bound.\n",
    );
    console.log("| arm | what reached the summariser | facts kept | invented |");
    console.log("| --- | --- | --- | --- |");
    for (const [name, rs] of [
      ["plain", plainRows],
      ["plainagain", againRows],
      ["instructed", byArm("instructed")],
      ["oracle", oracleRows],
    ] as const) {
      if (rs.length === 0) continue;
      const what =
        name === "oracle"
          ? "**the exact strings**"
          : name === "instructed"
            ? "a general rule"
            : "nothing (host default)";
      console.log(
        `| \`${name}\` | ${what} | **${pct(sum(rs, "kept"), sum(rs, "facts"))}** ` +
          `(${sum(rs, "kept")}/${sum(rs, "facts")}) | ${sum(rs, "invented")} |`,
      );
    }
    const op = transcripts()
      .map((t) => {
        const a = plainRows.find((r) => r.transcript === t.id);
        const b = oracleRows.find((r) => r.transcript === t.id);
        return a && b ? { id: t.id, plain: a, oracle: b } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const up = op.filter((x) => x.oracle.kept > x.plain.kept).length;
    const down = op.filter((x) => x.oracle.kept < x.plain.kept).length;
    const drawMoved = transcripts().filter((t) => {
      const a = plainRows.find((r) => r.transcript === t.id);
      const b = againRows.find((r) => r.transcript === t.id);
      return a && b && a.kept !== b.kept;
    }).length;
    const ceiling = sum(oracleRows, "kept") === sum(oracleRows, "facts");
    // THE EXACT SIGN TEST GOES NEXT TO THE CEILING, not underneath it. A
    // saturated arm invites being read as a strong result; on three discordant
    // pairs the test cannot clear 0.05 no matter which way they fall, and
    // saying so here is cheaper than a reader discovering it.
    const discordant = up + down;
    const signP = signTest(up, down);
    console.log(
      `\nPaired against \`plain\` on ${op.length} transcripts: **${up} better, ${down} worse, ` +
        `${op.length - up - down} the same**, against a measured draw of ${drawMoved}/${againRows.length} ` +
        `from \`plainagain\`. Exact sign test on the ${discordant} discordant pair` +
        `${discordant === 1 ? "" : "s"}: **p = ${signP.toFixed(3)}** -- which cannot reach 0.05 at this n ` +
        `whichever way they fall, so read the next paragraph as a mechanism result and not as a ` +
        `separation.\n`,
    );
    if (ceiling) {
      console.log(
        `> **The oracle reaches the ceiling: ${sum(oracleRows, "kept")}/${sum(oracleRows, "facts")} facts, ` +
          `${sum(oracleRows, "invented")} invented**, recovering every fact \`plain\` dropped. So the seam ` +
          "does control the output -- **a specific list of strings gets obeyed where §2's general rule did " +
          "not**, and that difference is the finding: `custom_instructions` is not a suggestion channel " +
          "when what it carries is literal. **And it is the only channel there is** -- TODO §1.5's first " +
          "candidate was to splice the values into the finished summary via `PostCompact`, and the hook " +
          "executors say that cannot work: `PreCompact` returns `newCustomInstructions` built from the " +
          "hook's stdout, while `PostCompact` returns only `userDisplayMessage`, a line shown to the " +
          "person after the summary is already committed. **One read of the binary retired candidate 1 " +
          "for nothing**, which is the same move that found this seam in the first place. " +
          "**The design is viable, and what is unmeasured is now " +
          "precisely jev's accuracy at picking the strings**, which needs the bigger fact corpus " +
          "TODO §1.5 named as candidate 3. The honest state of §1.5: **mechanism confirmed at the " +
          "ceiling, component unmeasured, and the ceiling is what a classifier would be competing " +
          "against rather than something it could exceed.**\n",
      );
    } else if (up > down && up > drawMoved) {
      console.log(
        `> **The oracle beats \`plain\` by more than the draw** (${up} transcripts against a draw of ` +
          `${drawMoved}), without reaching the ceiling. So the seam has partial control: handing over the ` +
          `exact strings helps and is still not sufficient. **A classifier could capture at most this ` +
          `much** -- ${pct(sum(oracleRows, "kept"), sum(oracleRows, "facts"))} against ` +
          `${pct(sum(plainRows, "kept"), sum(plainRows, "facts"))} -- so the question becomes whether that ` +
          `gap is worth a component, on a corpus of ${sum(oracleRows, "facts")} facts.\n`,
      );
    } else {
      console.log(
        `> **The oracle does not clear the draw** (${up} better, ${down} worse, against a draw of ` +
          `${drawMoved}/${againRows.length}). **This refutes the design rather than the component:** the ` +
          "summariser was handed the exact answer strings and told to copy them, and fact survival did not " +
          "move outside its own variation. A classifier in front of this seam cannot supply anything " +
          "stronger than the answer itself, so **there is nothing worth building here** -- and that is " +
          "settled for the price of eight compactions instead of a component plus a labelled corpus.\n",
      );
    }
    const missed = oracleRows.filter((r) => r.kept < r.facts);
    if (missed.length > 0) {
      console.log("| transcript | facts | oracle kept | `plain` kept | the string it was handed |");
      console.log("| --- | --- | --- | --- | --- |");
      for (const r of missed) {
        const t = transcripts().find((x) => x.id === r.transcript);
        const pl = plainRows.find((x) => x.transcript === r.transcript);
        console.log(
          `| \`${r.transcript}\` | ${r.facts} | **${r.kept}** | ${pl?.kept ?? "—"} | ` +
            `${(t?.facts ?? []).map((f) => `\`${f.text}\``).join(", ")} |`,
        );
      }
      console.log(
        `\n**${missed.length} transcript${missed.length === 1 ? "" : "s"} dropped a value it was handed ` +
          "verbatim with an instruction to copy it.** That is the strongest available evidence about the " +
          "seam: `custom_instructions` reaches the summariser (the column above proves it), and the " +
          "summariser still decides what the summary is about.\n",
      );
    }
  }

  const failed = rec.rows.filter((r) => r.error);
  if (failed.length > 0) {
    console.log(
      `\n**${failed.length} of ${rec.rows.length} runs produced no summary at all** and are excluded above: ` +
        `${[...new Set(failed.map((r) => `${r.arm}/${r.transcript}`))].slice(0, 6).join(", ")}.`,
    );
  }
  // THE COMPARISON THAT GIVES THIS A SCALE, computed from docs/42's own record
  // rather than quoted: same corpus, same facts, same `judge`. Without it a
  // "kept 9/9" here reads as trivially easy, and docs/42 measured two model
  // arms LOSING facts on exactly these nine.
  const versus = resolve(HERE, "../../versus/records/compaction.json");
  if (existsSync(versus)) {
    const rows = (JSON.parse(readFileSync(versus, "utf8")) as { rows: { arm: string; kept: number; facts: number }[] })
      .rows;
    const arms = [...new Set(rows.map((r) => r.arm))];
    console.log("\n## Against docs/42 §1.2, on the same nine facts and the same judge\n");
    console.log("| arm | what it does | facts kept |");
    console.log("| --- | --- | --- |");
    const WHAT: Record<string, string> = {
      jev: "jev-compact: DELETES entries, never rewrites",
      "haiku-select": "a model picks which entries to keep",
      "sonnet-select": "a model picks which entries to keep",
      "haiku-summarise": "a model rewrites under a token budget",
      "sonnet-summarise": "a model rewrites under a token budget",
    };
    for (const a of arms) {
      const g = rows.filter((r) => r.arm === a);
      const kept = g.reduce((n, r) => n + r.kept, 0);
      const facts = g.reduce((n, r) => n + r.facts, 0);
      console.log(`| \`${a}\` | ${WHAT[a] ?? "—"} | ${kept}/${facts} (${pct(kept, facts)}) |`);
    }
    for (const arm of ARMS) {
      const g = byArm(arm.name);
      if (g.length === 0) continue;
      const kept = g.reduce((n, r) => n + r.kept, 0);
      const facts = g.reduce((n, r) => n + r.facts, 0);
      console.log(
        `| **\`${arm.name}\`** (here) | **the HOST's compaction summariser**` +
          `${arm.instructions ? ", instructions rewritten" : ""} | **${kept}/${facts} (${pct(kept, facts)})** |`,
      );
    }
    const sum = rows.filter((r) => r.arm.endsWith("summarise"));
    const sumKept = sum.reduce((n, r) => n + r.kept, 0);
    const sumFacts = sum.reduce((n, r) => n + r.facts, 0);
    const here = byArm("plain");
    const hereKept = here.reduce((n, r) => n + r.kept, 0);
    const hereFacts = here.reduce((n, r) => n + r.facts, 0);
    if (hereFacts > 0 && sumFacts > 0) {
      const better = hereKept / hereFacts > sumKept / sumFacts;
      const medChars = med(here.map((r) => r.summaryChars));
      // BOTH BRANCHES GET THEIR OWN EXPLANATION. The first version of this
      // paragraph branched on the verb and then gave one reason for both --
      // and the reason it gave was written for the branch that did not
      // happen, so the sentence would have read "the host's summariser does
      // not beat them, and the likely reason is that it has no budget, which
      // means the headroom is not there to buy". That is self-contradictory:
      // being beaten IS the headroom. Seventh time in this programme a
      // conclusion has survived its own table changing under it.
      console.log(
        better
          ? `\n**The host's summariser beats the model arms that rewrite** (${pct(hereKept, hereFacts)} against ` +
              `${pct(sumKept, sumFacts)} pooled), and the likely reason is structural rather than clever: ` +
              "docs/42's `summarise` arms were compressing to a TOKEN BUDGET and the host's is not -- its " +
              `summaries here run ${medChars.toLocaleString()} characters. **So the headroom the instructions ` +
              "were supposed to buy mostly is not there to buy**, and §2 should be read with that in front of it."
          : `\n**The host's own compaction summariser keeps FEWER facts than any arm docs/42 measured** ` +
              `(${pct(hereKept, hereFacts)} against ${pct(sumKept, sumFacts)} pooled for the rewriting arms, ` +
              "and against 100% for all three that preserve bytes). That is the opposite of what the setup " +
              "predicts: docs/42's `summarise` arms were compressing to a quarter of the transcript, and the " +
              `host's is under no budget at all -- ${medChars.toLocaleString()} characters of summary for a ` +
              "transcript of 9,000 to 27,000 tokens.\n\n" +
              "**So the loss is not compression pressure. It is what the summariser chooses to be about.** " +
              "Reading the summaries, they are narrative -- what was attempted, in what order, what the user " +
              "then asked for -- and a measured value survives when it happens to be load-bearing for that " +
              "story. **Which is exactly the headroom the instructions were supposed to buy**, and §2 says how " +
              "much of it they actually bought.",
      );
    }
  }

  console.log(
    "\n## What this cannot say\n\n" +
      "- **`trigger: \"manual\"`.** This drives compaction with `/compact`, and the compaction that matters\n" +
      "  in production is the AUTOMATIC kind. The host will not auto-compact below 100k tokens\n" +
      "  (`--autocompact` refuses smaller windows) and the corpus's transcripts are 9-27k, so the\n" +
      "  automatic path is out of reach here. The hook event distinguishes them, so a future run can tell.\n" +
      "- **The conversation was written by the harness**, into the host's session JSONL, because replaying\n" +
      "  57 turns per transcript costs O(n^2) tokens. `--seams` verifies the summariser read it; that check\n" +
      "  exists because this programme has had three harnesses lie to a judgment in one day (docs/44 §4.5b).\n" +
      "- **9 facts across 8 transcripts.** A measure that moves in whole facts cannot resolve a ninth, so\n" +
      "  a null result here is a statement about the corpus at least as much as about the instructions.\n" +
      "- **Not a jev measurement.** Said at the top and repeated here because it is the thing most likely\n" +
      "  to be misread: the summariser is the host's, and `jev-compact` has no seam to sit in.\n",
  );
}

/**
 * THE WIRE CHECK, and nothing below should be believed without it.
 *
 * Two things have to be true for any number here to mean anything, and both
 * are things a harness can get wrong silently:
 *
 *   1. the summariser READ the synthesized conversation -- not "a session
 *      existed", but the content reached the model. Checked by requiring the
 *      summary to contain material only the seeded tool results could supply.
 *   2. the instructions REACHED the host, which the `PreCompact` event reports
 *      directly.
 *
 * Failing 1 looks exactly like a working experiment whose every arm scores the
 * same, which is the shape docs/38 §2's two-report bug had.
 */
function seams(): void {
  const t = transcripts()[0];
  const root = resolve("/tmp", `jev-precompact-seams-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    console.log("\n# Can this experiment measure anything? (the wire check)\n");
    console.log(`Seeding \`${t.id}\` -- ${t.entries.length} entries, ${t.tokens.toLocaleString()} tokens -- into the`);
    console.log("host's own session format, then compacting it.\n");
    const rows: string[] = [];
    for (const arm of ARMS) {
      const got = compact(t, arm, root);
      // Material only the seeded TOOL OUTPUT could have supplied -- and the
      // `role === "tool"` is the whole point. The first version matched on the
      // label alone, which finds the ASSISTANT turn ("I'll ls packages.") and
      // so searched a sentence with no identifiers in it: the check reported
      // 0/0 on a seed that demonstrably worked. A wire check that cannot fail
      // is worse than none, and one that cannot PASS is worse still.
      const toolText = t.entries.find((e) => e.role === "tool" && e.label === "ls packages")?.text ?? "";
      const needles = [...new Set(toolText.match(/jev-[a-z-]+/g) ?? [])];
      if (needles.length === 0) throw new Error("no identifiers to look for -- the check would be vacuous");
      const found = needles.filter((n) => got.summary.includes(n));
      // REPORT WHAT THE HOOK SAW, not what the arm intended to send. The first
      // version keyed this off `arm.instructions`, which is empty for `oracle`
      // (its text comes from `build`), so the table printed "none sent" on the
      // same line where the log printed 241 characters. Two columns of the same
      // output disagreeing is the cheapest possible version of the bug this
      // whole check exists to catch.
      const sawChars = (got.sawInstructions ?? "").length;
      rows.push(
        `| \`${arm.name}\` | ${sawChars > 0 ? `**${sawChars} chars**` : "none sent"} | ` +
          `${got.summary.length} | **${found.length}/${needles.length}** | ${got.ms} |`,
      );
      console.log(
        `  ${arm.name.padEnd(11)} summary ${String(got.summary.length).padStart(5)} chars, ` +
          `seeded identifiers found ${found.length}/${needles.length}, instructions seen ` +
          `${(got.sawInstructions ?? "").length} chars`,
      );
    }
    console.log("\n| arm | instructions the host saw | summary chars | seeded identifiers in the summary | ms |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const r of rows) console.log(r);
    console.log(
      "\nThe identifiers are the package names the transcript's own `ls packages` printed, so they are in\n" +
        "the summary only if the summariser read the tool output the harness wrote. **If that column is 0,\n" +
        "every arm below is measuring an empty conversation and scoring the same** -- which is precisely the\n" +
        "shape docs/38 §2's bug had, where a skill router shipped for two reports having never read a skill.\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--show")) {
    show(JSON.parse(readFileSync(PATH, "utf8")) as Record_);
    return;
  }
  if (argv.includes("--seams")) {
    seams();
    return;
  }
  if (argv.includes("--rejudge")) {
    // Re-score the stored summaries with the CURRENT judge, and say how many
    // verdicts moved. docs/42's `--rejudge` is the precedent and it earned its
    // keep the day this judge was fixed: it proved the fix left docs/42's
    // published numbers untouched (0 of 40 rows), so the comparison in the
    // report is between like and like.
    const rec = JSON.parse(readFileSync(PATH, "utf8")) as Record_;
    const byId = new Map(transcripts().map((t) => [t.id, t]));
    let moved = 0;
    for (const row of rec.rows) {
      const t = byId.get(row.transcript);
      if (!t || row.error) continue;
      if (row.summary.length !== row.summaryChars) {
        console.log(`  ${row.transcript} ${row.arm}: stored summary is truncated, re-run this row instead`);
        continue;
      }
      const re = judge(t, row.summary);
      if (re.kept !== row.kept || re.invented !== row.invented || re.absent !== row.absent) moved += 1;
      Object.assign(row, re);
    }
    console.log(`  ${moved} of ${rec.rows.length} rows changed verdict.\n`);
    writeFileSync(PATH, `${JSON.stringify(rec, null, 2)}\n`);
    show(rec);
    return;
  }
  const only = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : 999;
  /**
   * `--arm <name>` runs one arm and MERGES it into the existing record.
   *
   * Added for TODO §1.5's `oracle`: the other three arms are already recorded
   * and re-running them would replace 24 measured rows with a fresh draw of
   * the same thing, which is exactly the variance §5.2 spent an arm measuring.
   * Rows for the named arm are replaced; every other row is kept verbatim.
   */
  const armFlag = argv.includes("--arm") ? argv[argv.indexOf("--arm") + 1] : null;
  const arms = armFlag ? ARMS.filter((a) => a.name === armFlag) : ARMS;
  if (arms.length === 0) throw new Error(`no arm named ${armFlag} -- have ${ARMS.map((a) => a.name).join(", ")}`);
  const root = resolve("/tmp", `jev-precompact-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const kept: Row[] =
    armFlag && existsSync(PATH)
      ? (JSON.parse(readFileSync(PATH, "utf8")) as Record_).rows.filter((r) => r.arm !== armFlag)
      : [];
  if (armFlag) process.stderr.write(`merging into ${kept.length} existing rows, replacing arm \`${armFlag}\`\n`);
  const rows: Row[] = [];
  const all = transcripts().slice(0, only);
  try {
    for (const t of all) {
      for (const arm of arms) {
        const got = compact(t, arm, root);
        const scored = judge(t, got.summary);
        rows.push({
          transcript: t.id,
          arm: arm.name,
          ...scored,
          facts: t.facts.length,
          summaryChars: got.summary.length,
          tokensBefore: t.tokens,
          ms: got.ms,
          sawInstructions: got.sawInstructions,
          // THE WHOLE SUMMARY, not a slice. The first version capped this at
          // 6,000 characters and 6 of 16 rows hit the cap -- the SCORING used
          // the full text, so the numbers were right, but the record could not
          // reproduce them and a later `--rejudge` would have quietly scored
          // less text than the original run. docs/42 stores its `sample` whole
          // for the same reason, which is why its numbers could be re-derived
          // when this judge changed.
          summary: got.summary,
          ...(got.error ? { error: got.error } : {}),
        });
        process.stderr.write(
          `${t.id.padEnd(16)} ${arm.name.padEnd(11)} kept ${scored.kept}/${t.facts.length}  ` +
            `${got.summary.length} chars  ${got.ms} ms${got.error ? `  ERR ${got.error.slice(0, 60)}` : ""}\n`,
        );
        mkdirSync(RECORDS, { recursive: true });
        writeFileSync(PATH, `${JSON.stringify({ note: NOTE, rows: [...kept, ...rows] }, null, 2)}\n`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  show({ note: NOTE, rows: [...kept, ...rows] });
}

if (process.argv[1]?.endsWith("precompact.ts")) await main();
