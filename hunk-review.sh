#!/usr/bin/env bash
# hunk-review — review a git diff in hunk's terminal TUI (in a fresh cmux pane),
# and pipe your inline (user) comments into the cmux agent pane that launched
# this. The terminal-native counterpart to diffx-review.sh.
#
#   cd <repo>
#   hunk-review                 # working-tree changes  (hunk diff)
#   hunk-review --staged        # staged changes
#   hunk-review develop...HEAD  # a target/range  (args pass through to `hunk diff`)
#   hunk-review -- src/         # limit to a pathspec
#
# Requires: hunk (npm i -g hunkdiff), node, and a cmux terminal.
set -euo pipefail
# Resolve our own real directory through symlinks (npm global bin, ~/bin, etc.).
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$D/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
CMUX="${CMUX_BUNDLED_CLI_PATH:-cmux}"
HUNK="${HUNK_BIN:-hunk}"
REPO="$PWD"

command -v "$HUNK" >/dev/null || { echo "hunk not found — run: npm i -g hunkdiff"; exit 1; }
[ -n "${CMUX_SURFACE_ID:-}" ] || echo "warning: CMUX_SURFACE_ID unset — run this inside a cmux terminal"

# 1. open a terminal pane and launch the hunk TUI in it (this is the human's view)
OUT=$("$CMUX" new-pane --type terminal --direction right --focus true 2>&1)
SURF=$(echo "$OUT" | grep -oE 'surface:[0-9]+' | head -1)
[ -n "$SURF" ] || { echo "could not open a cmux terminal pane: $OUT"; exit 1; }
"$CMUX" send --surface "$SURF" "cd \"$REPO\" && $HUNK diff $*" >/dev/null
"$CMUX" send-key --surface "$SURF" enter >/dev/null

# 2. bridge: poll user comments from the live session -> this (agent) pane
node "$DIR/hunk-bridge.mjs" --repo "$REPO" --surface "${CMUX_SURFACE_ID:-}" & BRIDGE_PID=$!

echo "hunk review ready — TUI in $SURF, comments -> surface ${CMUX_SURFACE_ID:-?}"
echo "Leave inline comments in hunk; they auto-deliver to the agent shortly after. Ctrl-C to stop."
trap 'kill $BRIDGE_PID 2>/dev/null || true' INT TERM
wait
