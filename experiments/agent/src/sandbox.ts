/**
 * The rail that stops a scripted command reaching outside its own scratch tree.
 *
 * THIS FILE EXISTS BECAUSE THE FIRST VERSION OF THIS EXPERIMENT DELETED THE
 * REPOSITORY. The guard-rail scenario scripted `rm -rf /home` so the guard
 * would have something real to refuse, and the CONTROL arm -- which by
 * definition has no guard -- executed it against the actual filesystem. The
 * working tree went with it. Everything was committed and pushed, so the cost
 * was the uncommitted half of this directory, but the lesson is not about
 * luck:
 *
 *   A control arm runs the dangerous thing WITHOUT the safety being tested.
 *   That is what makes it a control. So the containment cannot live in the
 *   thing under test -- it has to live here, in the harness, outside both
 *   arms.
 *
 * The rule below is deliberately crude and deliberately a whitelist: every
 * destructive path a script names must sit under the scenario's own sandbox,
 * checked before pi is spawned. A command that fails the check is a harness
 * bug, so it raises rather than being skipped.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Commands that can destroy something, by the verb that starts them. */
const DESTRUCTIVE = /\b(rm|rmdir|mv|dd|mkfs|shred|truncate|chown|chmod|kill|killall|pkill|shutdown|reboot)\b/;

/** Anything that reaches the network or another machine. */
const OUTBOUND = /\b(curl|wget|nc|ssh|scp|rsync|git\s+push|npm\s+publish|docker\s+push)\b/;

export interface Sandbox {
  /** An absolute directory the scenario may destroy. */
  root: string;
  /** A tree inside it, with files, for a destructive command to remove. */
  tree: string;
}

export function makeSandbox(id: string): Sandbox {
  const root = mkdtempSync(resolve(tmpdir(), `jev-agent-${id}-`));
  const tree = resolve(root, "tree");
  mkdirSync(resolve(tree, "nested"), { recursive: true });
  writeFileSync(resolve(tree, "one.txt"), "one\n");
  writeFileSync(resolve(tree, "nested", "two.txt"), "two\n");
  return { root, tree };
}

/**
 * Throw unless every destructive or outbound command in the script is confined
 * to the sandbox.
 *
 * Checked BEFORE pi is spawned, and checked for both arms, because the control
 * arm is the one with nothing else protecting it.
 */
export function assertContained(
  script: { calls?: { name: string; input: Record<string, unknown> }[] }[],
  sandbox: Sandbox,
  scenario: string,
): void {
  for (const step of script) {
    for (const call of step.calls ?? []) {
      const command = typeof call.input.command === "string" ? call.input.command : "";
      if (!command) {
        // A write or edit names a path instead of a command.
        const path = typeof call.input.path === "string" ? call.input.path : "";
        if (path.startsWith("/") && !path.startsWith(sandbox.root)) {
          throw new Error(`${scenario}: ${call.name} targets ${path}, outside the sandbox ${sandbox.root}`);
        }
        continue;
      }
      if (OUTBOUND.test(command)) {
        throw new Error(`${scenario}: the script would reach the network: ${command}`);
      }
      if (!DESTRUCTIVE.test(command)) continue;
      // A destructive command must name the sandbox, and every absolute or
      // home-relative path token in it must sit inside the sandbox.
      //
      // Per-token rather than a substring blacklist, which the first version
      // used and which was both too loose (it missed paths it had not thought
      // of) and too tight (` /` matched the `/tmp` in the sandbox's own path).
      if (!command.includes(sandbox.root)) {
        throw new Error(
          `${scenario}: destructive command does not name the sandbox: ${command}\n` +
            `  (every rm/mv/dd in a script must target ${sandbox.root}; see src/sandbox.ts)`,
        );
      }
      for (const token of command.split(/\s+/)) {
        const looksAbsolute = token.startsWith("/");
        const looksHome = token.startsWith("~") || token.startsWith("$HOME") || token.startsWith("${HOME}");
        if (!looksAbsolute && !looksHome) continue;
        if (looksHome || !token.startsWith(sandbox.root)) {
          throw new Error(
            `${scenario}: destructive command names ${token}, which is not inside ${sandbox.root}: ${command}`,
          );
        }
      }
    }
  }
}
