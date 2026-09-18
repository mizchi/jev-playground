/**
 * The rules under test, and the ONLY thing Jev is allowed to learn about them.
 *
 * The point of the experiment is that the rule's implementation stays hidden:
 * Jev gets the code and the rule's stated criteria, never `create()`. So the
 * description is not hand-written here — it is read out of ESLint's own
 * `meta.docs.description` at runtime, which keeps the prompt honest (no hints
 * of mine sneak in) and reproducible (it is whatever the installed ESLint
 * says). `assertNoImplementationLeak` then checks the outgoing payload against
 * the actual source of every `create()` we loaded.
 */

/** Loaded straight from ESLint; `use-at-your-own-risk` ships no typings. */
interface LoadedRule {
  meta?: {
    docs?: { description?: string };
    defaultOptions?: unknown;
    schema?: unknown;
  };
  create?: unknown;
}

const { builtinRules } = (await import("eslint/use-at-your-own-risk")) as unknown as {
  builtinRules: Map<string, LoadedRule>;
};

/**
 * Twelve core rules, grouped by how much of the verdict the description can
 * possibly carry. `group` is our annotation for the write-up — it is never
 * sent to Jev.
 *
 * - `lexical`   — a token or node type decides it; reading the code is enough.
 * - `analysis`  — needs scope or control-flow reasoning, but no hidden policy.
 * - `defaulted` — the rule's DEFAULT OPTIONS decide it, and those live in the
 *                 implementation, not in the description.
 */
export const RULE_GROUPS: Record<string, "lexical" | "analysis" | "defaulted"> = {
  "no-var": "lexical",
  "no-eval": "lexical",
  "no-debugger": "lexical",
  "no-self-compare": "lexical",
  "no-prototype-builtins": "lexical",
  "no-empty": "analysis",
  "no-fallthrough": "analysis",
  "no-unused-vars": "analysis",
  "prefer-const": "analysis",
  eqeqeq: "defaulted",
  "no-constant-condition": "defaulted",
  "no-cond-assign": "defaulted",
};

export const RULE_IDS = Object.keys(RULE_GROUPS);

/**
 * Collect the option vocabulary out of a rule's JSON schema: the property
 * names an option object accepts, plus the string enums it allows. For
 * `no-cond-assign` that yields ["except-parens", "always"] -- the exact words
 * for the carve-out that the one-line description omits.
 */
function optionVocabulary(schema: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === "object") {
      for (const key of Object.keys(obj.properties as object)) found.add(key);
    }
    if (Array.isArray(obj.enum)) {
      for (const v of obj.enum) if (typeof v === "string") found.add(v);
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(schema);
  return [...found];
}

/** Everything about a rule that may cross the wire. */
export interface RuleSpec {
  id: string;
  description: string;
  /**
   * `meta.defaultOptions` and the schema vocabulary -- both PUBLISHED metadata,
   * neither one written by us, and neither one the implementation. The `spec`
   * arm sends these to test whether the carve-outs that only `create()` knows
   * are the thing the other arms are missing.
   */
  defaultOptions?: unknown;
  options: string[];
}

export const RULE_SPECS: RuleSpec[] = RULE_IDS.map((id) => {
  const rule = builtinRules.get(id);
  if (!rule) throw new Error(`rule '${id}' is not in this ESLint build`);
  const description = rule.meta?.docs?.description;
  if (!description) throw new Error(`rule '${id}' has no meta.docs.description`);
  return {
    id,
    description,
    defaultOptions: rule.meta?.defaultOptions,
    options: optionVocabulary(rule.meta?.schema),
  };
});

export function specOf(id: string): RuleSpec {
  const spec = RULE_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`no spec for '${id}'`);
  return spec;
}

/** Source text of every rule implementation we are keeping hidden. */
const IMPLEMENTATIONS: string[] = RULE_IDS.map((id) =>
  String(builtinRules.get(id)?.create ?? ""),
);

/**
 * Fail loudly if any request body carries a piece of a rule's implementation.
 *
 * Any 48-character window of a `create()` body is distinctive enough that a
 * hit means we leaked; short windows would false-positive on ordinary English.
 * This is the experiment's central claim, so it is checked on every request
 * rather than asserted in prose.
 */
export function assertNoImplementationLeak(payload: string, extraSecrets: string[] = []): void {
  const WINDOW = 48;
  for (const [i, impl] of IMPLEMENTATIONS.entries()) {
    for (let at = 0; at + WINDOW <= impl.length; at += WINDOW) {
      const window = impl.slice(at, at + WINDOW);
      if (payload.includes(window)) {
        throw new Error(
          `implementation leak: payload contains ${WINDOW} chars of ` +
            `${RULE_IDS[i]}'s create() at offset ${at}`,
        );
      }
    }
  }
  for (const secret of extraSecrets) {
    if (secret.length >= 24 && payload.includes(secret)) {
      throw new Error(`annotation leak: payload contains "${secret.slice(0, 40)}..."`);
    }
  }
}
