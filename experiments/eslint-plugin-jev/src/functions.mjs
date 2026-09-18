/**
 * The unit of judgment: one function.
 *
 * This walk is the plugin's most consequential design decision, because every
 * unit it yields costs a question and every question costs tokens (docs/00).
 * Two rules keep the bill honest:
 *
 * - **Only outermost functions.** A closure inside a judged function is
 *   already inside the text we send, so judging it again pays twice for the
 *   same code and lets the plugin report the same problem on two lines.
 * - **Callbacks are skipped by default.** `items.map(x => x.id)` is not a
 *   thing a reviewer has an opinion about, and a plugin that asks about every
 *   inline arrow is mostly paying for noise.
 *
 * The walk is generic (it recurses over own properties) rather than typed
 * against an ESTree version, so a newer parser node type does not silently
 * drop functions.
 */

/** Nodes that are a function body of some kind. */
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Keys that point back up or carry no child nodes. */
const SKIP_KEYS = new Set(["parent", "loc", "range", "start", "end", "tokens", "comments"]);

export const DEFAULT_SELECTION = {
  /** A one- or two-line function has nothing for a reviewer to weigh. */
  minLines: 3,
  /** Inline arrows passed to a call. */
  includeCallbacks: false,
};

/**
 * Best-effort readable name. The name is not decoration: in the cheap arm it
 * is the only handle the question has on which function it is asking about,
 * so `<anonymous>` there is a genuine loss of precision (see judge.mjs).
 */
function nameOf(node, parent, grandparent) {
  if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
  if (!parent) return null;
  switch (parent.type) {
    case "VariableDeclarator":
      return parent.id?.type === "Identifier" ? parent.id.name : null;
    case "MethodDefinition":
    case "PropertyDefinition": {
      const key = parent.key?.name ?? parent.key?.value;
      if (key === undefined) return null;
      // `Cart#total` reads better in a report than a bare `total`, and the
      // class name is often the only thing that disambiguates a `render`.
      const className =
        grandparent?.type === "ClassBody" ? grandparent.parent?.id?.name : undefined;
      const prefix = parent.static ? "static " : "";
      return className ? `${prefix}${className}#${key}` : `${prefix}${key}`;
    }
    case "Property":
      return parent.key?.name ?? parent.key?.value ?? null;
    case "AssignmentExpression":
      return parent.left?.type === "Identifier"
        ? parent.left.name
        : parent.left?.property?.name ?? null;
    case "ExportDefaultDeclaration":
      return "default";
    default:
      return null;
  }
}

/** True when this function is an argument to a call: a callback. */
function isCallback(node, parent) {
  return (
    (parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
    parent.arguments?.includes(node)
  );
}

/**
 * Collect the judgeable functions of one parsed file, outermost first.
 *
 * `sourceCode` is ESLint's SourceCode, so the plugin and the warm pass share
 * this code path exactly -- the cache key is a hash of `text`, and a second
 * extractor that disagreed by one character would miss every entry.
 */
export function collectUnits(sourceCode, filename, selection = {}) {
  const opts = { ...DEFAULT_SELECTION, ...selection };
  const units = [];
  // Attached to every unit so the warm pass can batch by file without
  // re-reading anything. Strings are shared by reference, so this costs a
  // pointer per unit, not a copy.
  const fileSource = sourceCode.getText();

  const visit = (node, parent, grandparent, insideUnit) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, grandparent, insideUnit);
      return;
    }
    if (typeof node.type !== "string") return;

    let nowInside = insideUnit;
    if (FUNCTION_TYPES.has(node.type) && !insideUnit) {
      const lines = node.loc.end.line - node.loc.start.line + 1;
      const skipped =
        lines < opts.minLines || (!opts.includeCallbacks && isCallback(node, parent));
      if (!skipped) {
        const name = nameOf(node, parent, grandparent);
        units.push({
          file: filename,
          fileSource,
          name: name ?? `<anonymous>@${node.loc.start.line}`,
          named: name !== null,
          line: node.loc.start.line,
          endLine: node.loc.end.line,
          lines,
          async: Boolean(node.async),
          generator: Boolean(node.generator),
          // The text we send AND the text we hash. `node` here is the whole
          // function including its `function` keyword or parameter list.
          text: sourceCode.getText(node),
          node,
        });
        nowInside = true;
      }
    }

    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      visit(node[key], node, parent, nowInside);
    }
  };

  visit(sourceCode.ast, null, null, false);
  units.sort((a, b) => a.line - b.line);
  return units;
}
