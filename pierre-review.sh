#!/usr/bin/env bash
# pierre-review — review a git diff with @pierre/diffs in a cmux browser pane,
# piping inline comments into the cmux agent pane that launched this. The
# browser-based counterpart to hunk-review.sh; replaces diffx as the renderer.
#
#   cd <repo>
#   pierre-review                    # working-tree changes
#   pierre-review -- --staged        # staged
#   pierre-review -- develop...HEAD  # a branch range  (args after -- go to git diff)
#
# Requires: node, npm (first run builds the bundle), and a cmux terminal.
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$D/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
CMUX="${CMUX_BUNDLED_CLI_PATH:-cmux}"
REPO="$PWD"

freeport() { local p=$1; while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p+1)); done; echo "$p"; }
PORT=$(freeport "${PIERRE_PORT:-3500}")

[ -n "${CMUX_SURFACE_ID:-}" ] || echo "warning: CMUX_SURFACE_ID unset — run this inside a cmux terminal"

# Build the @pierre/diffs bundle on first run (or when missing).
if [ ! -f "$DIR/pierre/dist/main.js" ]; then
  echo "building @pierre/diffs bundle (first run)…"
  ( cd "$DIR/pierre" && npm install && npm run build ) || { echo "build failed — run 'cd $DIR/pierre && npm install && npm run build'"; exit 1; }
fi

# Diff server (UI + git diff + send-to-agent), on a free port.
node "$DIR/pierre-server.mjs" --cwd "$REPO" --port "$PORT" --surface "${CMUX_SURFACE_ID:-}" -- "$@" & SRV=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/diff" >/dev/null 2>&1 && break; sleep 0.25; done

# Open the review UI in a cmux browser pane.
"$CMUX" browser open "http://127.0.0.1:$PORT/" --focus true >/dev/null 2>&1 \
  || "$CMUX" open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true

echo "pierre review ready — :$PORT -> surface ${CMUX_SURFACE_ID:-?}"
echo "Click a line to comment, then '▶ Send to agent'. Ctrl-C to stop."
trap 'kill $SRV 2>/dev/null || true' INT TERM
wait
