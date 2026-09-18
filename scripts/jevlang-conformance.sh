#!/usr/bin/env bash
# Run every example through BOTH jevlang implementations and diff the results.
#
#   scripts/jevlang-conformance.sh
#
# Needs no API key: each example has a recorded transcript under
# examples/transcripts/, and --replay makes zero requests. That is the point of
# record/replay in a language whose conditions are probabilistic — without it
# there is no way to tell an implementation difference from the model simply
# answering differently this time.
#
# The comparison is on the --json output, which carries only what both
# implementations must agree on: effects, printed output, bindings in order,
# and the judgments actually consumed. Both are normalised through the same
# JSON canonicaliser first, so a diff means a semantic difference and not a
# disagreement about key order or number formatting.
set -uo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.moon/bin:$PATH"

if ! command -v moon >/dev/null 2>&1; then
  echo "conformance: no 'moon' on PATH; install the MoonBit toolchain first" >&2
  exit 2
fi

echo "building the MoonBit implementation..."
moon build --target native >/dev/null 2>&1 || {
  echo "conformance: moon build failed" >&2
  exit 1
}
# `moon run` rather than a path into _build: the layout there is moon's
# business, and the repo drives every other CLI this way too.
MBT_RUN=(moon run --target native cmd/jevlang --)

# Sort keys recursively so the diff is about content, not about which JSON
# writer emitted which order.
canon() {
  node -e '
    const fs = require("node:fs");
    const sort = (v) =>
      Array.isArray(v)
        ? v.map(sort)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
          : v;
    const text = fs.readFileSync(0, "utf8");
    const start = text.indexOf("{");
    process.stdout.write(JSON.stringify(sort(JSON.parse(text.slice(start))), null, 2) + "\n");
  '
}

pass=0
fail=0
# hooks/policy.jev is in the list because it is the one program using noul
# criteria and conf(), so it is where the two implementations are most likely
# to drift. It needs an injected state, which is the .state.json convention.
for program in examples/*.jev hooks/policy.jev; do
  name="$(basename "$program" .jev)"
  transcript="examples/transcripts/${name}.json"
  state_file="examples/transcripts/${name}.state.json"
  state_args=()
  if [[ -f "$state_file" ]]; then
    state_args=(--state "$state_file")
  fi
  if [[ ! -f "$transcript" ]]; then
    echo "  SKIP ${name} (no transcript; record one with --record)"
    continue
  fi

  js_out="$(mktemp)"
  mbt_out="$(mktemp)"
  if ! node jevlang-js/bin/jevlang.mjs "$program" --replay "$transcript" "${state_args[@]+"${state_args[@]}"}" --json 2>&1 | canon >"$js_out"; then
    echo "  FAIL ${name}: the JS implementation errored"
    fail=$((fail + 1))
    continue
  fi
  if ! "${MBT_RUN[@]}" "$program" --replay "$transcript" "${state_args[@]+"${state_args[@]}"}" --json 2>/dev/null | canon >"$mbt_out"; then
    echo "  FAIL ${name}: the MoonBit implementation errored"
    fail=$((fail + 1))
    continue
  fi

  if diff -q "$js_out" "$mbt_out" >/dev/null; then
    judgments="$(node -e 'const fs=require("node:fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).judgments.length)' "$js_out")"
    echo "  ok   ${name}  (${judgments} judgments, identical in both)"
    pass=$((pass + 1))
  else
    echo "  FAIL ${name}: the two implementations disagree"
    diff -u "$js_out" "$mbt_out" | head -40
    fail=$((fail + 1))
  fi
  rm -f "$js_out" "$mbt_out"
done

echo ""
echo "  ${pass} identical, ${fail} differing"
[[ "$fail" -eq 0 ]]
