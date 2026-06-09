# diffmux

A fast, local code-review loop for cmux: review a git diff in
a polished GitHub-style UI (the [`@pierre/diffs`](https://diffs.com) renderer),
leave inline comments, and pipe them **straight into the agent running in your
cmux pane** — no GitHub round-trip, no "please read my PR comments."

| command | what |
|---|---|
| **`diffx-review`** | review one repo's diff (`pierre-review` is an alias) |
| **`workspace-review`** | review **every changed repo** in a multi-repo feature workspace, grouped by repo |

## Install

```bash
npm install -g .        # from this repo → puts diffx-review / pierre-review / workspace-review on PATH
```

The launchers resolve their own path through the npm symlink, so they find the
server and frontend regardless of where they're invoked from. First run builds
the `@pierre/diffs` bundle under `pierre/` (esbuild + Shiki, ~1s); later runs
are instant.

## Use

From a **cmux terminal** (comments route back to `$CMUX_SURFACE_ID`, the pane
you launch from), `cd` into the repo you want reviewed:

```bash
diffx-review                      # working-tree (uncommitted) changes
diffx-review -- --staged          # staged
diffx-review -- develop...HEAD    # PR-style: branch vs base (use your repo's real base)
```

Everything after `--` goes to `git diff`. Note the default is **uncommitted**
changes — for a feature branch's committed work, pass a range like
`origin/<base>...HEAD`.

It opens a cmux browser pane: file sidebar (with `+/-` counts), split/unified
diff, per-file **collapse**, **Viewed** (mark-as-read), and **⤢ Whole file**
(re-fetches the file with full context so you see the entire file, not just the
hunks). Click a line number — or hover a line for the gutter **+** — to open a
comment composer; comments collect in a panel (delete / jump-to-line); hit
**▶ Send to agent** and they paste into the launching pane as one prompt with
precise `file:line` refs.

> **The agent must be idle to receive comments** — a bracketed paste during an
> active turn is dropped. Review while the agent waits, then Send.

## Reviewing a whole feature workspace (`workspace-review`)

For a multi-repo feature workspace (`~/features/<feature>/` with several repo
worktrees), `workspace-review` aggregates **every changed repo into one review**,
grouped by repo in the sidebar:

```bash
cd ~/features/<feature>/snappr.server   # any repo in the workspace
workspace-review                         # or: workspace-review ~/features/<feature>
```

Each repo is diffed against its own base branch (from its `.feature-cli.json`,
default `develop`) as `origin/<base>...HEAD`; files are namespaced
`<repo>/<file>` (via `git diff --src-prefix/--dst-prefix`) so they don't
collide, and comments come back as `<repo>/<file>:line` with the workspace path
noted. Same collapse / Viewed / click-to-comment as the single-repo UI.

## Pieces

| file | role |
|---|---|
| `pierre-review.sh` | launcher: free port (from `PIERRE_PORT`, default 3500), first-run build, opens the pane |
| `workspace-review.sh` | multi-repo launcher; discovers sibling repos, runs the server in `--workspace` mode |
| `pierre-server.mjs` | serves the UI; computes `git diff` (+ `--numstat` for counts); `/api/file` (full-context single file); `/api/send` (pastes comments into the agent pane) |
| `pierre/src/main.js`, `pierre/index.html` | the `@pierre/diffs` frontend (esbuild bundle; `pierre/dist/` is gitignored, built on first run) |
| `scrollfix.js` | reverts the cmux-webview async scroll-jump without ever fighting a user-driven scroll; served at `/scrollfix.js` |

## Knobs

- `PIERRE_PORT` — start of the free-port scan (default 3500)
- `pierre-server.mjs --no-submit` — paste the prompt but don't press Enter (submit yourself)
- `pierre-server.mjs --surface <ref|uuid>` — override the target pane (default `$CMUX_SURFACE_ID`)

## Why this design

- **UI is commodity** — `@pierre/diffs` already nails highlighting, split view,
  virtualized rendering. No point reimplementing GitHub's review surface.
- **The cmux-native part is the value** — comments land in your *live* agent
  session, not the clipboard or a separate fetch-skill.
- **Comments are a page-level composer + panel**, not in-diff annotations —
  annotations only attach to fully-rendered change lines and Shiki renders
  async, which made them flaky.

## cmux facts this relies on

- `cmux send` treats `\n` as Enter (submits early) — multi-line must go through
  `paste-buffer` (bracketed paste) + a single `send-key enter`.
- Socket auth is `cmuxOnly`, so the server must run inside the cmux process tree
  (launch it from a cmux terminal; don't `nohup`-detach it).
