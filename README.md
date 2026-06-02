# cmux-review

A fast, local code-review loop for cmux: review a diff in a polished GitHub-style
UI, leave inline comments, and pipe them **straight into the agent running in your
cmux pane** — no GitHub round-trip, no "please read my PR comments."

## Architecture: diffx UI + cmux bridge

We use [**diffx**](https://github.com/wong2/diffx) for the review UI (Shiki syntax
highlighting, file tree, split/unified, auto-collapse, viewed tracking) and add
the one thing it lacks — delivery into a *running* cmux agent pane.

```
diffx UI (cmux browser pane)
  └─ injected "▶ Send to agent" button   (cmux browser addscript)
       └─ bridge.mjs : GET diffx /api/comments  (only status != resolved)
            └─ cmux set-buffer → paste-buffer → send-key enter  →  agent pane
                 └─ PUT each comment status:"resolved"  (so nothing re-sends)
```

### Setup

```bash
npm install -g diffx-cli         # the review UI (required)
npm install -g .                 # this repo → puts `diffx-review` on your PATH
```

`npm install -g .` (run from this repo) installs a global `diffx-review` command
(plus the legacy `cmux-review`). The launcher resolves its own path through the
npm symlink, so it always finds `bridge.mjs` / `inject.js` regardless of where
it's invoked from. To work on the scripts in place instead, `npm link` here.

### Use

From a cmux terminal, `cd` into the repo you want reviewed (the diff is taken
from your current directory), then:

```bash
diffx-review                    # uncommitted changes
diffx-review -- --staged        # staged
diffx-review -- develop...HEAD  # PR-style: your branch vs its merge-base with the base branch
```

`--` separates diffx's flags from the git-diff args (diffx's own syntax). Use your
repo's *actual* base branch — if there's no `main`, `git diff main..HEAD` fails and
diffx returns 500. Check with `git remote show origin` or `git symbolic-ref
refs/remotes/origin/HEAD` (commonly `develop`, `master`, or `main`).

It opens diffx in a cmux browser pane, starts the bridge, and injects a floating
**▶ Send to agent** button. Click `+` on lines to comment, then hit the button —
the comments become one prompt pasted into the pane that launched the tool
(`$CMUX_SURFACE_ID`) and submitted. The agent picks them up and edits.

### Why this design

- **UI is commodity** — diffx already nails highlighting, file tree, collapse,
  split view. No point reimplementing GitHub's review surface.
- **The cmux-native part is the value** — comments land in your *live* agent
  session, not the clipboard or a separate fetch-skill.
- **Double-send is structurally impossible** — the button disables while a push
  is in flight, the bridge holds a busy-lock, and every sent comment is marked
  `resolved` in diffx so a second click finds nothing new. Verified:
  `push#1 → sent 2`, `push#2 → sent 0`.

### Pieces

| file | role |
|---|---|
| `diffx-review.sh` | one-command launcher (diffx + pane + bridge + button) |
| `bridge.mjs` | pulls diffx `/api/comments`, injects into the cmux pane, resolves them |
| `inject.js` | the floating "Send to agent" button added to the diffx page |
| `scrollfix.js` | reverts diffx's native scroll-jump in the cmux webview (#24); injected unless `CMUX_REVIEW_SCROLLFIX=0` |

diffx comment shape (its API): `{ id, filePath, side, lineNumber, lineContent, body, status, replies }`.
The bridge renders `filePath:lineNumber` + the code line + your comment (and any replies).

### Knobs

- `DIFFX_PORT` (default 3433), `BRIDGE_PORT` (default 3434)
- `CMUX_REVIEW_SCROLLFIX=0` — disable the injected scroll-jump fix (`scrollfix.js`,
  for [wong2/diffx#24](diffx-scroll-jump-issue.md); on by default)
- `bridge.mjs --surface <ref|uuid>` — override the target pane (default `$CMUX_SURFACE_ID`)
- `bridge.mjs --no-submit` — paste the prompt but don't press Enter (submit yourself)

### cmux facts this relies on

- `cmux send` treats `\n` as Enter (submits early) — multi-line must go through
  `paste-buffer` (bracketed paste) + a single `send-key enter`.
- Socket auth is `cmuxOnly`, so the bridge must run inside the cmux process tree
  (launch it from a cmux terminal; don't `nohup`-detach it).

## Legacy: zero-dependency built-in viewer

`server.mjs` + `index.html` are a self-contained hand-rolled reviewer (no diffx,
no npm) — kept as a fallback. Works, but no syntax highlighting / file tree /
collapse. Prefer the diffx path above.

```bash
cmux-review            # installed by `npm install -g .`; or: node server.mjs --cwd "$PWD"
```
