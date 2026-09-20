/**
 * Statistics, from `tiny-stats`.
 *
 * Node resolves a bare specifier by walking up from THIS file, so a
 * `node_modules` beside it wins over the one at the project root.
 */
import { mean, median } from "tiny-stats";

export function summary(xs) {
  return { mean: mean(xs), median: median(xs) };
}
