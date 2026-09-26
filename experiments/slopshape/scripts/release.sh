#!/usr/bin/env bash
# Fetch the SlopShape release (arXiv:2609.15369) at the pinned commit into
# vendor/, and check every file this experiment reads against the sha256 the
# release itself lists in MANIFEST.md. The release is all-rights-reserved
# outside its code directories, so it is read at run time, never copied here.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=https://github.com/pulse-energy-eu/slopshape
PIN=6c1fbd0af1b22034b72d3cda9560cbf5b6a8c740
if [ ! -d vendor/slopshape/.git ]; then
  git clone --quiet "$REPO" vendor/slopshape
fi
git -C vendor/slopshape fetch --quiet origin "$PIN" 2>/dev/null || true
git -C vendor/slopshape checkout --quiet "$PIN"
FILES=(
  fetch/corpus_manifest.csv
  artifacts/r6/splits.json
  artifacts/r6/variant_sets.json
  artifacts/r6/core_values_selection.json
  artifacts/r6/variant_results_parity.json
  artifacts/r7/durability_aggregates.json
  artifacts/r6/rarity_report.json
  instrument/condensed_taxonomy_0.85.json
  instrument/feature_exclusions.json
  instrument/style_excluded_features.json
  prompts/lamp_rewrite.md
  study_b/extract_briefs.py
  study_b/generate_mirrors.py
)
fail=0
for f in "${FILES[@]}"; do
  want=$(grep -F "| $(basename "$f") |" vendor/slopshape/MANIFEST.md | head -1 | awk -F'|' '{print $(NF-1)}' | tr -d ' ')
  got=$(sha256sum "vendor/slopshape/$f" | cut -d' ' -f1)
  if [ -z "$want" ]; then echo "  (not in manifest) $f $got"
  elif [ "$want" = "$got" ]; then echo "  ok  $f"
  else echo "  MISMATCH $f"; fail=1; fi
done
exit $fail
