#!/usr/bin/env bash
# Jev vs Jev: referee + two player processes, each an independent OS process.
#
# The referee owns the game and enforces fog of war on the wire; each player
# is a separate process with its own Jev client that only ever sees its own
# team's observation. The two players think in parallel, so a tick costs about
# one Jev request's latency rather than two.
#
#   TYPESAFEAI_API_KEY=... scripts/jev-vs-jev.sh [--games N] [--port P] [--max-ticks T] [--verbose]
#
# Logs land in a temp dir, printed at the end.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

GAMES=1
PORT=$(( 8900 + RANDOM % 200 ))
MAX_TICKS=60
VERBOSE=""
REPLAY=""
ACOMP=""
BCOMP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --games) GAMES="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --max-ticks) MAX_TICKS="$2"; shift 2 ;;
    --replay) REPLAY="$2"; shift 2 ;;
    --a-comp) ACOMP="$2"; shift 2 ;;
    --b-comp) BCOMP="$2"; shift 2 ;;
    --verbose) VERBOSE="--verbose"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${TYPESAFEAI_API_KEY:-}" ]]; then
  echo "set TYPESAFEAI_API_KEY" >&2; exit 1
fi

export PATH="$HOME/.moon/bin:$PATH"
LOGDIR="$(mktemp -d)"
echo "jev-vs-jev: port $PORT, $GAMES game(s), logs in $LOGDIR"

REF_ARGS=(--port "$PORT" --games "$GAMES" --max-ticks "$MAX_TICKS")
[[ -n "$REPLAY" ]] && REF_ARGS+=(--replay "$REPLAY")
[[ -n "$ACOMP" ]] && REF_ARGS+=(--a-comp "$ACOMP")
[[ -n "$BCOMP" ]] && REF_ARGS+=(--b-comp "$BCOMP")
[[ -n "$VERBOSE" ]] && REF_ARGS+=("$VERBOSE")

# Pre-build so the referee starts listening quickly (moon run would build first).
moon build --target native cmd/moba_referee cmd/moba_player >/dev/null 2>&1 || true

# Referee first; wait until it is actually listening before the players dial in.
moon run --target native cmd/moba_referee -- "${REF_ARGS[@]}" \
  > "$LOGDIR/referee.log" 2>&1 &
REF=$!

for _ in $(seq 1 300); do
  grep -q "listening on" "$LOGDIR/referee.log" 2>/dev/null && break
  if ! kill -0 "$REF" 2>/dev/null; then
    echo "referee exited early:" >&2; cat "$LOGDIR/referee.log" >&2; exit 1
  fi
  sleep 0.2
done

# Two independent player processes. They never talk to each other.
moon run --target native cmd/moba_player -- --team A --port "$PORT" $VERBOSE \
  > "$LOGDIR/player-a.log" 2>&1 &
PA=$!
moon run --target native cmd/moba_player -- --team B --port "$PORT" $VERBOSE \
  > "$LOGDIR/player-b.log" 2>&1 &
PB=$!

# Wait for the referee to finish the games, then let the players wind down.
wait "$REF" || { echo "referee failed" >&2; cat "$LOGDIR/referee.log" >&2; }
wait "$PA" 2>/dev/null || true
wait "$PB" 2>/dev/null || true

echo ""
echo "=== referee ==="; cat "$LOGDIR/referee.log"
echo ""
echo "=== player A ==="; tail -n 4 "$LOGDIR/player-a.log"
echo ""
echo "=== player B ==="; tail -n 4 "$LOGDIR/player-b.log"
echo ""
echo "full logs: $LOGDIR"
