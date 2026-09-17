/**
 * Ground truth: the real linter's verdict for every (snippet, rule) pair.
 *
 * All twelve rules are enabled at "error" with DEFAULT OPTIONS -- no options
 * are passed anywhere, because the whole question is whether the defaults
 * (which live in the implementation) can be predicted from the description.
 */
import { ESLint } from "eslint";
import { CORPUS, type Snippet } from "./corpus.js";
import { RULE_IDS } from "./rules.js";

export interface Verdict {
  /** true = ESLint reported at least one problem for this rule. */
  fails: Record<string, boolean>;
  /** Messages per rule, for the write-up. */
  messages: Record<string, string[]>;
  /** File-level: does the file pass the whole rule set? */
  passes: boolean;
}

export async function groundTruth(): Promise<Map<string, Verdict>> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      rules: Object.fromEntries(RULE_IDS.map((id) => [id, "error"])),
    },
  });

  const out = new Map<string, Verdict>();
  for (const snippet of CORPUS) {
    const results = await eslint.lintText(snippet.code, { filePath: `${snippet.id}.js` });
    const fails: Record<string, boolean> = {};
    const messages: Record<string, string[]> = {};
    for (const id of RULE_IDS) {
      fails[id] = false;
      messages[id] = [];
    }
    for (const result of results) {
      for (const m of result.messages) {
        if (!m.ruleId) {
          // A parse error would silently turn every label into "clean".
          throw new Error(`${snippet.id}: ${m.message}`);
        }
        if (!(m.ruleId in fails)) continue;
        fails[m.ruleId] = true;
        messages[m.ruleId].push(`${m.line}:${m.column} ${m.message}`);
      }
    }
    out.set(snippet.id, {
      fails,
      messages,
      passes: RULE_IDS.every((id) => !fails[id]),
    });
  }
  return out;
}

/** Each rule needs both classes present, or its accuracy means nothing. */
export function assertDiscriminable(truth: Map<string, Verdict>): void {
  for (const id of RULE_IDS) {
    const failing = CORPUS.filter((s) => truth.get(s.id)!.fails[id]).length;
    if (failing === 0) throw new Error(`no snippet trips '${id}'`);
    if (failing === CORPUS.length) throw new Error(`every snippet trips '${id}'`);
  }
}

export function snippetOf(id: string): Snippet {
  const s = CORPUS.find((c) => c.id === id);
  if (!s) throw new Error(`no snippet '${id}'`);
  return s;
}
