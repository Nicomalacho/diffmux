# cmux-review

A fast, local code-review loop for cmux: review a diff in a polished GitHub-style
UI, leave inline comments, and pipe them **straight into the agent running in your
cmux pane** — no GitHub round-trip, no "please read my PR comments."

## Frontends

Review UIs, all piping inline comments into the cmux agent pane that launched
them (no GitHub round-trip). Pick with the matching command:

| command | UI | notes |
|---|---|---|
| **`diffx-review`** ⭐ | browser — [`@pierre/diffs`](https://diffs.com) | **default** — fast: file sidebar, split/unified, collapse, mark-as-read, click-to-comment. `pierre-review` is an alias. |
| `workspace-review` | browser — [`@pierre/diffs`](https://diffs.com) | **multi-repo** — every changed repo in a `~/features/<feature>/` workspace, grouped by repo |
| `hunk-review` | terminal — [`hunk`](https://github.com/modem-dev/hunk) TUI | native, no webview; polls `hunk session comment list --type user` |
| `diffx-classic` | browser — [`diffx`](https://github.com/wong2/diffx) | the original diffx engine; scroll-jumps, mitigated by `scrollfix.js` |

> Heads-up: `diffx-review` launches the `@pierre/diffs` UI (the default). The old
> diffx engine is now `diffx-classic`; the diffx-specific sections further below
> describe it.

### `diffx-review` (default — the @pierre/diffs UI)

```bash
npm install -g .                  # installs diffx-review, pierre-review, hunk-review, diffx-classic
cd /path/to/repo
diffx-review                      # working-tree changes
diffx-review -- --staged          # staged
diffx-review -- develop...HEAD    # PR-style: branch vs base (use your repo's real base)
```

Opens a cmux browser pane: file sidebar (with `+/-` counts), split/unified diff,
per-file collapse, **Viewed** (mark-as-read), and **⤢ Whole file** (re-fetches
the file with full context so you see the entire file, not just the hunks).
Click a line number — or hover a line for the gutter **+** — to open a comment
composer; comments collect in a panel (delete / jump-to-line); hit **▶ Send to
agent** and they paste into the launching pane as one prompt with precise
`file:line` refs. The agent must be **idle** to receive them — a paste during an
active turn is dropped. First run builds the `@pierre/diffs` bundle under
`pierre/` (esbuild + Shiki, ~1s); later runs are instant.

Pieces: `pierre-review.sh` (launcher, picks a free port + builds on first run),
`pierre-server.mjs` (serves the UI, computes `git diff` + `--numstat`, pastes
comments into the agent pane), `pierre/src/main.js` (the `@pierre/diffs`
frontend), `pierre/index.html`. `hunk-review.sh` + `hunk-bridge.mjs` are the
terminal-native sibling; `diffx-review.sh` + `bridge.mjs` + `inject.js` +
`scrollfix.js` are the `diffx-classic` engine.

### Reviewing a whole feature workspace (`workspace-review`)

For a multi-repo feature workspace (`~/features/<feature>/` with several repo
worktrees), `workspace-review` aggregates **every changed repo into one review**,
grouped by repo in the sidebar:

```bash
cd ~/features/<feature>/snappr.server   # any repo in the workspace
workspace-review                         # or: workspace-review ~/features/<feature>
```

Each repo is diffed against its own base branch (from its `.feature-cli.json`,
default `develop`) as `origin/<base>...HEAD`; files are namespaced `<repo>/<file>`
(via `git diff --src-prefix/--dst-prefix`) so they don't collide, and comments
come back as `<repo>/<file>:line` with the workspace path noted. Same collapse /
Viewed / click-to-comment as the single-repo UI. Served by `pierre-server.mjs
--workspace`; launched by `workspace-review.sh`.

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
