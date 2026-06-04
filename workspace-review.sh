#!/usr/bin/env bash
# workspace-review — review EVERY changed repo in a feature workspace in one
# @pierre/diffs pane, grouped by repo, comments piped to the agent pane that
# launched this. Built on pierre-server's --workspace mode.
#
#   cd ~/features/<feature>/<any-repo>   # (or the feature dir itself)
#   workspace-review                      # auto-discovers sibling repos
#   workspace-review ~/features/<feature> # explicit feature dir
#
# Each repo is diffed against its own base branch (from its .feature-cli.json,
# default "develop"), as `origin/<base>...HEAD`. Requires node + a cmux terminal.
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$D/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
CMUX="${CMUX_BUNDLED_CLI_PATH:-cmux}"

# Feature dir: explicit arg, else parent of $PWD if we're inside a repo, else $PWD.
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  FEATURE_DIR="$(cd "$1" && pwd)"
elif [ -e "$PWD/.git" ]; then
  FEATURE_DIR="$(dirname "$PWD")"
else
  FEATURE_DIR="$PWD"
fi

freeport() { local p=$1; while lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do p=$((p+1)); done; echo "$p"; }
PORT=$(freeport "${PIERRE_PORT:-3500}")

[ -n "${CMUX_SURFACE_ID:-}" ] || echo "warning: CMUX_SURFACE_ID unset — run this inside a cmux terminal"

# Build the @pierre/diffs bundle on first run (shared with diffx-review).
if [ ! -f "$DIR/pierre/dist/main.js" ]; then
  echo "building @pierre/diffs bundle (first run)…"
  ( cd "$DIR/pierre" && npm install && npm run build ) || { echo "build failed"; exit 1; }
fi

node "$DIR/pierre-server.mjs" --workspace "$FEATURE_DIR" --port "$PORT" --surface "${CMUX_SURFACE_ID:-}" & SRV=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/diff" >/dev/null 2>&1 && break; sleep 0.25; done

"$CMUX" browser open "http://127.0.0.1:$PORT/" --focus true >/dev/null 2>&1 \
  || "$CMUX" open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true

echo "workspace review ready — $(basename "$FEATURE_DIR") on :$PORT -> surface ${CMUX_SURFACE_ID:-?}"
echo "Review across repos, comment, '▶ Send to agent'. Ctrl-C to stop."
trap 'kill $SRV 2>/dev/null || true' INT TERM
wait
