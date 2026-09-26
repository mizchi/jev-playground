/**
 * The release's frozen 214-feature instrument, turned into Jev questions.
 *
 * The release scores with an LLM that writes one JSON object per dimension.
 * Here each feature is one typed Jev question, with the answer shape matched
 * to the feature type (docs/tuning.md §1: shape first):
 *
 *   binary, categorical   -> choice over the allowed values
 *   ordinal, scale        -> score over the allowed values, in order
 *   multi_select          -> one noul per allowed value ("is X among them?")
 *
 * The feature's question and its detection_method become the instructions;
 * nothing in any question names humans, AI, or which value leans where.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Question } from "../../shared/jev.js";
import { REL } from "./corpus.js";

export type FeatureType = "binary" | "categorical" | "ordinal" | "scale" | "multi_select";

export interface Feature {
  id: string;
  name: string;
  question: string;
  type: FeatureType;
  values: string[];
  detection_method: string;
  dimension: string;
}

export type Variant = "narrative_strict" | "style_only" | "all_features";

const read = (p: string) => JSON.parse(readFileSync(resolve(REL, p), "utf8"));

export function taxonomy(): Feature[] {
  const t = read("instrument/condensed_taxonomy_0.85.json").feature_taxonomy as Record<
    string,
    { aspects: Record<string, { features: Omit<Feature, "dimension">[] }> }
  >;
  return Object.entries(t).flatMap(([dimension, d]) =>
    Object.values(d.aspects).flatMap((a) => a.features.map((f) => ({ ...f, dimension }))),
  );
}

export function variantSets(): Record<Variant, string[]> {
  return read("artifacts/r6/variant_sets.json");
}

/** The 214 features the release analyses (266 minus the 52 floor exclusions). */
export function instrument(): Feature[] {
  const keep = new Set(variantSets().all_features);
  return taxonomy().filter((f) => keep.has(f.id));
}

export interface CoreSelection {
  core_values: string[];
  value_signs: Record<string, "human" | "ai">;
  value_gaps: Record<string, number>;
}

export function coreSelection(): CoreSelection {
  return read("artifacts/r6/core_values_selection.json");
}

/** "1_title_or_subtitle" -> "title or subtitle": what the scorer reads. */
export function label(value: string): string {
  return value.replace(/^\d+_/, "").replace(/_/g, " ");
}

/** The release's encoded column name for one value (r6_build.py). */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

const instructionsOf = (f: Feature) => `${f.question} (${f.detection_method})`;

export const MULTI_SEP = "__";

export function questionsFor(features: Feature[]): Record<string, Question> {
  const qs: Record<string, Question> = {};
  for (const f of features) {
    if (f.type === "multi_select") {
      for (const v of f.values) {
        qs[`${f.id}${MULTI_SEP}${slug(v)}`] = {
          type: "noul",
          instructions: `${instructionsOf(f)} Several answers may apply. Does this one apply: "${label(v)}"?`,
        };
      }
    } else if (f.type === "ordinal" || f.type === "scale") {
      qs[f.id] = { type: "score", instructions: instructionsOf(f), criteria: f.values.map(label) };
    } else {
      qs[f.id] = {
        type: "choice",
        instructions: instructionsOf(f),
        criteria: Object.fromEntries(f.values.map((v) => [label(v), null])),
      };
    }
  }
  return qs;
}

/** The state every feature question shares: the rule, then the post. */
export function stateFor(text: string): string {
  return `A B2B company blog post, to be annotated against fixed features. Judge only what is in the text.\n\nPOST:\n${text}`;
}
