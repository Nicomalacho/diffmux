# cmux-review

Review a git diff inside cmux's embedded browser, leave **inline comments**, and
pipe them straight into a running agent's pane — no GitHub round-trip, no
"please read my PR comments." The feedback lands in the agent as one message and
(optionally) auto-submits.

It's ~2 files and uses only Node built-ins + the `cmux` CLI. Nothing to install.

## How it works

```
diff UI (browser pane)  ──POST /api/send──▶  server.mjs  ──▶  cmux set-buffer
  click line, comment                          builds prompt    cmux paste-buffer --surface <agent>
  "Send to agent"                                               cmux send-key --surface <agent> enter
                                                                        │
                                                                        ▼
                                                              agent receives the review
                                                              as one message, addresses it
```

The injection recipe is what makes it reliable: `cmux send` interprets embedded
newlines as Enter (would submit early), but `paste-buffer` uses **bracketed
paste**, so a multi-line prompt lands atomically and a single `send-key enter`
submits it.

## Usage

From inside a cmux terminal, in (or pointed at) your repo:

```bash
node /Users/nicolasgaviria/Documents/Projects/cmux-review/server.mjs --cwd "$PWD"
# or, after `chmod +x cmux-review` and putting it on PATH:
cmux-review                 # working tree vs HEAD
cmux-review -- main...HEAD  # a branch range (anything after -- is git diff args)
cmux-review --surface surface:34   # send to a specific pane
```

It opens the reviewer in a cmux browser pane automatically. Click the `+` in the
gutter of any line to comment. Pick the **target surface** (the agent's pane) via
the chips in the footer, or type a ref/uuid. Hit **Send to agent**.

## Targeting the agent's pane

- Default target is `$CMUX_SURFACE_ID` — the surface that launched the tool. So if
  the **agent itself** runs `cmux-review` (e.g. at the end of a task), feedback
  routes back to that same session with zero config.
- Otherwise the footer lists every terminal surface in the workspace; click one.
- `cmux list-pane-surfaces --pane <p> --json` shows refs/titles if you want to
  pick manually.

## Flags

| flag | default | meaning |
|---|---|---|
| `--cwd <path>` | `$PWD` | repo to diff |
| `--surface <ref|uuid>` | `$CMUX_SURFACE_ID` | default target pane |
| `--port <n>` | `$CMUX_PORT` | server port (cmux reserves 9270–9279) |
| `--no-open` | off | don't auto-open the browser pane |
| `--no-focus` | off | open the pane without stealing focus |
| `-- <args>` | `HEAD` | passed to `git diff` (e.g. `-- main...HEAD`, `-- --staged`) |

## Notes / limits (MVP)

- Untracked files aren't shown (they're not in `git diff`). Use `git add -N` to
  include them, or extend the diff command.
- "auto-submit" sends Enter. Turn it off to stage the prompt in the agent's input
  and submit yourself — safer if the agent might be mid-task.
- Socket access is `cmuxOnly` by default; this works because the server is a
  cmux-spawned process. If you run it from a non-cmux shell, set a socket
  password or change `automation.socketControlMode` in `~/.config/cmux/cmux.json`.
- Round-trip: comments clear on the agent side once sent; re-diff and review again
  for the next round.
