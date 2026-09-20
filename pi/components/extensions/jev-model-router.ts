/**
 * The model router, as Pi loads it. See `../../seams.ts` for the map.
 *
 * A re-export and nothing else: the decision lives in
 * `packages/jev-model-router` and this file exists so that Pi's
 * `extensions/` convention directory finds it. It imports the package's
 * DOCUMENTED subpath rather than reaching into `src/`, so this assembly
 * exercises the same export an outside user would get.
 */
export { default } from "jev-model-router/pi";
