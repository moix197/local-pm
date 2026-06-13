# local-pm

Lightweight local web dashboard to control a dev server per git worktree, one at a
time, accessible over the LAN. No web framework, only Node built-ins. Frontend is a
single static HTML page with vanilla JS — no build step.

## Works with git-wt

local-pm is the companion to **[git-wt](https://github.com/moix197/git-wt)** — a
cross-platform Git worktree manager. git-wt *creates and manages* the worktrees
(branching, per-worktree `.env`/port allocation, safe cleanup); local-pm *runs and
stops the dev server* for whichever worktree you're working in. Use git-wt to spin up
a worktree, then use local-pm to start/stop/switch its server from the browser.

## What it does

Automates, per worktree, what you'd otherwise do by hand:

1. Discovers git worktrees for each configured project (`git worktree list`).
2. **Start**: runs `npm install` first if `node_modules` is missing, then `npm run dev`
   in the worktree folder.
3. **Stop**: kills the dev server process tree (`taskkill /T /F`) and runs
   `docker compose down` in the worktree (errors ignored — fine for worktrees with no
   compose file).
4. Switching worktrees stops the current server before starting the new one.
5. **Docker pre-flight**: if the worktree has a compose file (`docker-compose.yml` etc.)
   and Docker Desktop isn't running, startup is aborted with a clear
   `Docker is not running — start Docker Desktop first, then try again.` log message
   instead of a raw error, and the currently-running server is left untouched.

Logs (last ~300 combined stdout/stderr lines) stream into the page.

## Requirements

- **Node.js v22+** (uses the built-in `node:test` runner and modern ESM features).
- pnpm.

## Run

```sh
pnpm start
```

Then open <http://localhost:7420>. On startup it prints the local and LAN URLs.

Override the port with `LOCAL_PM_PORT` (default `7420`).

## Authentication

Every `/api/*` route is protected by a bearer token. `GET /` (the page itself) is open.

On first startup the server generates a 64-char token, writes it to `token.local` (repo
root, gitignored), and prints it **once**:

```
  token: 1a2b3c…
```

Subsequent starts print a masked line instead — safe to capture in a log file:

```
  auth token loaded from token.local
```

If you lose the value, read it from `token.local` directly. Delete the file to rotate it
(a new one is generated on next start).

**Browser login overlay:** Opening the dashboard without a stored token shows a login
overlay. Paste the token once and click **Log in** — the token is validated against the
server and stored in `localStorage` under the key `lpm-token`. It persists across browser
refreshes and full browser restarts, so you paste once per device, not once per session.
A wrong token keeps the overlay visible with an error. Click **forget token** in the
header to clear the stored token and return to the overlay (useful when the server rotates
its token). If the stored token becomes stale mid-session (e.g. `token.local` was
deleted), the next poll returns 401 and the overlay re-appears automatically.

**Legacy URL fragment:** `http://localhost:7420/#token=<value>` still works — the page
reads the token, writes it to `localStorage`, and strips the fragment from the URL bar.

**curl:** pass the token as a bearer header.

```sh
# state
curl -H "Authorization: Bearer <token>" http://localhost:7420/api/state
# start a worktree's dev server
curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"path":"C:/path/to/worktree"}' http://localhost:7420/api/start
# stop the active dev server
curl -X POST -H "Authorization: Bearer <token>" http://localhost:7420/api/stop
```

Without a valid token these endpoints return `401 {"error":"Unauthorized"}`.

## Running commands in a worktree

On a **stopped** worktree each row shows command controls — only available when no server
is running for that worktree (a running server returns 409 and the UI disables the
controls).

### Quick-action buttons

Three default buttons appear on every stopped worktree row:

| Button | Command run |
|---|---|
| `npm install` | `npm install` |
| `npm run build` | `npm run build` |
| `npm run lint` | `npm run lint` |

Clicking a quick-action runs immediately — **no confirmation dialog**.

### Per-project custom commands

Add a `commands` array to any project entry in `projects.json`:

```json
[
  {
    "name": "my-project",
    "root": "C:/path/to/your/project",
    "commands": [
      "npm run typecheck",
      { "label": "DB migrate", "cmd": "npm run db:migrate" }
    ]
  }
]
```

Each entry is either a plain string (used as both label and command) or a
`{ "label": "…", "cmd": "…" }` object. Per-project commands **extend** the three
defaults — they appear after them. If a project entry has the same label as a default,
the project's version wins (override semantics).

### Free-form command input

Each stopped worktree row also has a text box. Type any shell command and press
**Enter** or click **Run**. Empty or whitespace-only input is rejected client-side
without sending a request. A confirmation dialog appears before the command runs:

```
Run <command> in <branch>?
```

On confirm the command runs and streams output to the logs panel exactly like a
quick-action.

### Command output and the shared log buffer

Output streams into the existing logs panel (last ~300 combined lines). The header line
is `[cmd] <label>`, followed by stdout/stderr, then a footer `[cmd] exited <code>`. A
green `✓ (exit 0)` or red `✗ (exit N)` banner shows the result at the top of the page.

The 300-line buffer is shared between server logs and command output — a noisy command
will churn it and push out earlier server logs. Accepted trade-off for the LAN tool.

### Stop command

While a command is running a **Stop command** button appears in the banner. Clicking it
kills the command process tree (`taskkill /T /F` on Windows) and marks the command
failed. Controls re-enable after the command exits or is stopped.

### Known limitation — interactive commands

A command that waits on stdin (e.g. a prompt, `npm init`, etc.) will **hang** and never
exit on its own. Use **Stop command** to kill it. There is no interactive stdin support.

## Security caveat

> **Read this before exposing the dashboard beyond your local machine.**

local-pm is a **LAN-only, single-user tool** designed for trusted home/office networks:

- **Token-gated only.** All `/api/*` routes require a Bearer token. That is the sole
  authentication boundary — there is no second factor, no IP allowlist, no rate limit.
- **HTTP cleartext.** Traffic between your browser and the server is unencrypted. Anyone
  on the same network can intercept the token and replay it.
- **Arbitrary RCE by design.** The free-form command box and the quick-action buttons
  execute shell commands directly on the host machine (`spawn(cmd, { shell: true })`),
  with the server process's full environment and privileges. This is intentional for a
  local developer tool and is what makes it useful.

**Acceptable for solo/LAN use. You MUST add HTTPS (self-signed or a real cert) and
review hardening before exposing the dashboard to any network you do not fully trust.**
See ROADMAP for the planned hardening item.

## Run as a background service

To have local-pm start automatically at log-on (no terminal needed), register a Windows
Task Scheduler task. Run this from an **Administrator** terminal — creating the
scheduled task (`schtasks /create`) requires elevation:

```sh
pnpm schedule:install
```

Remove it with:

```sh
pnpm schedule:uninstall
```

Both scripts are idempotent (delete-then-create), so re-running install never duplicates
the task.

- The daemon runs **windowless** (no console window): install generates a small hidden
  launcher (`scripts/run-hidden.generated.vbs`, gitignored) that starts node via
  `wscript.exe`. `schedule:uninstall` removes both the task and the generated launcher.
- The task runs as the **current user in your interactive session** — required so it can
  reach Docker Desktop (which only runs in the interactive session).
- Task Scheduler does **not** inherit your shell environment variables. That's why the
  auth token lives in `token.local` (read by the server at startup) rather than an env var.
  Start the server once first (`pnpm start`) so `token.local` exists.
- Confirm the task is registered:

  ```sh
  schtasks /query /tn local-pm
  ```

- The full at-log-on cycle must be verified **manually**: sign out, sign back in, and
  check the dashboard loads — there's no automated test for the live Task Scheduler trigger.

## MCP adapter

The `mcp/` folder is a standalone package that exposes local-pm's four daemon actions —
`list_worktrees`, `status`, `start_server`, `stop_server` — as
[Model Context Protocol](https://modelcontextprotocol.io) tools so Claude Code (or any MCP
client) can drive the daemon directly. The token is auto-read from `token.local` when
`LOCAL_PM_TOKEN` is unset, and any failure (daemon down, non-2xx, missing token) surfaces
as a structured MCP error rather than crashing.

See [`mcp/README.md`](mcp/README.md) for full setup, env vars, and the Claude Code snippet.

## Reach from another LAN machine

Open `http://<desktop-ip>:7420` from any device on the same network — the dashboard
binds to `0.0.0.0`. The active dev server link points at `http://<desktop-ip>:3000`.

## Add projects

Edit `projects.json` at the repo root:

```json
[
  { "name": "my-project", "root": "C:/path/to/your/project" }
]
```

If `projects.json` is missing it's created with a generic placeholder on first run.
Projects whose `root` doesn't exist are flagged and skipped. If `projects.json`
contains invalid JSON, startup fails with a descriptive error
(`projects.json is not valid JSON: …`) rather than starting silently broken.

## Limitations & assumptions

- **One server at a time.** Parallel servers are future roadmap.
- **Dev mode only.**
- Dev servers are assumed to serve on **port 3000** (the LAN link uses `:3000`).
- `docker compose down` is run on stop; its errors are ignored so worktrees without a
  compose file still stop cleanly.
- Windows-specific: uses `npm.cmd`, `taskkill`, and `shell: true` for `.cmd` resolution.
- **Commands block the server.** The single-operation guard means you cannot start a
  server while a command is running, and vice versa.
- **No interactive stdin.** Commands waiting on user input hang until stopped manually
  (see [Stop command](#stop-command) above).
