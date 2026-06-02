#!/usr/bin/env bash
# diffx-review — run diffx as the review UI inside cmux, with a "Send to agent"
# button that pipes comments straight into the cmux pane that launched this.
#
#   cd <your repo>
#   diffx-review                 # review uncommitted changes
#   diffx-review -- --staged     # staged changes
#   diffx-review -- main..HEAD   # a branch range  (args after -- go to git diff)
#
# Requires: diffx (npm i -g diffx-cli), node, and a cmux terminal.
set -euo pipefail
# Resolve our own real directory through symlinks (npm global bin, ~/bin, etc.)
# so we can always find bridge.mjs / inject.js next to this script.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$D/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
CMUX="${CMUX_BUNDLED_CLI_PATH:-cmux}"

# Pick free ports so a re-run never collides with a still-running instance.
freeport() { local p=$1; while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p+1)); done; echo "$p"; }
DIFFX_PORT=$(freeport "${DIFFX_PORT:-3433}")
BRIDGE_PORT=$(freeport "${BRIDGE_PORT:-$((DIFFX_PORT + 1))}")

command -v diffx >/dev/null || { echo "diffx not found — run: npm i -g diffx-cli"; exit 1; }
[ -n "${CMUX_SURFACE_ID:-}" ] || echo "warning: CMUX_SURFACE_ID unset — run this inside a cmux terminal"

# 1. diffx server (review UI)
( diffx --no-open -p "$DIFFX_PORT" "$@" ) & DIFFX_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$DIFFX_PORT/api/comments" >/dev/null 2>&1 && break; sleep 0.25
done

# 2. open diffx in a cmux browser pane
SURF=$("$CMUX" browser open "http://127.0.0.1:$DIFFX_PORT/" --focus true 2>&1 | grep -oE 'surface:[0-9]+' | head -1)

# 3. bridge: diffx comments -> this cmux pane
node "$DIR/bridge.mjs" --diffx "http://127.0.0.1:$DIFFX_PORT" --port "$BRIDGE_PORT" & BRIDGE_PID=$!
sleep 1

# 4. inject the "Send to agent" button (port-substituted), persist across reloads
BTN=$(sed "s|http://127.0.0.1:3434|http://127.0.0.1:$BRIDGE_PORT|" "$DIR/inject.js")
"$CMUX" browser --surface "$SURF" addinitscript "$BTN" >/dev/null
"$CMUX" browser --surface "$SURF" addscript "$BTN" >/dev/null

# 5. inject the scroll-jump fix (wong2/diffx #24). Disable with CMUX_REVIEW_SCROLLFIX=0.
if [ "${CMUX_REVIEW_SCROLLFIX:-1}" = "1" ] && [ -f "$DIR/scrollfix.js" ]; then
  SF=$(cat "$DIR/scrollfix.js")
  "$CMUX" browser --surface "$SURF" addinitscript "$SF" >/dev/null
  "$CMUX" browser --surface "$SURF" addscript "$SF" >/dev/null
fi

echo "diffx review ready — pane $SURF, bridge :$BRIDGE_PORT -> surface ${CMUX_SURFACE_ID:-?}"
echo "Review in the pane, click '▶ Send to agent'. Ctrl-C to stop."
trap 'kill $DIFFX_PID $BRIDGE_PID 2>/dev/null || true' INT TERM
wait
