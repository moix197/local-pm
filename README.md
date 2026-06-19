# local-pm

Lightweight local web dashboard to control a dev server per git worktree,
accessible over the LAN. Multiple servers run **concurrently**, each on its own
port with its own log console. No web framework, only Node built-ins. Frontend is a
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
2. **Start**: assigns a free port from the local pool (3100–3199), runs `npm install`
   first if `node_modules` is missing, then `npm run dev` in the worktree folder with
   that `PORT` injected into the environment.
3. **Run many at once**: each started worktree runs independently and concurrently —
   starting a second server no longer stops the first. Every running server appears in
   the **Running servers** section with its assigned port, an **Open** link, an
   **Open console** button (its own logs), and a per-server **Stop**.
4. **Stop**: kills the dev server process tree (`taskkill /T /F`), runs
   `docker compose down` in the worktree (errors ignored — fine for worktrees with no
   compose file), and frees the server's port back to the pool. A per-server **Stop**
   stops only that one; **Stop all** stops every running server.
5. **Docker pre-flight**: if the worktree has a compose file (`docker-compose.yml` etc.)
   and Docker Desktop isn't running, that start is aborted with a clear
   `Docker is not running — start Docker Desktop first, then try again.` log message
   instead of a raw error, and any other running servers are left untouched.

Each server keeps its own log buffer (last ~300 combined stdout/stderr lines).
Consoles are **lazy**: a server's logs are fetched (via `GET /api/logs?path=…`) only
while its console panel is open, so idle servers cost nothing.

> The lazy log-fetch design is intentionally forward-compatible with the planned
> interactive-terminal upgrade (PRD 2: node-pty + WebSocket + xterm.js).

## Hybrid port model

local-pm handles ports differently depending on the worktree's `type` field (set in `projects.json` or passed by git-wt):

| Type | How ports work |
|---|---|
| `git-wt` | local-pm does **not** assign or inject a port. git-wt projects run on their own fixed port (e.g. always 3000 for OAuth redirect URI compatibility). local-pm **observes** the actual port by scanning the dev server's log output for the first URL it prints (e.g. `- Local: http://localhost:3000`). Sets `COMPOSE_PROJECT_NAME` only when a compose file is present. |
| `docker` | Scans compose files for `${VAR}:PORT` entries; assigns a pool port (3100–3199) per variable and injects it. Sets `COMPOSE_PROJECT_NAME` so `docker compose down` is scoped to this worktree only. |
| plain (default) | Assigns one port from the 3100–3199 pool and injects it as `PORT`. |

### git-wt port detection

For `git-wt` targets, local-pm displays `—` or `starting…` in the dashboard until the dev server prints a URL. On the first log line matching `http(s)://localhost:<port>` (or `127.0.0.1` / `0.0.0.0`), that port is recorded and the dashboard shows it with an **Open** link.

### Scoped docker compose down

When a worktree has a `COMPOSE_PROJECT_NAME` (set during start), `docker compose down` is called with `--project-name <name>` so only that worktree's containers are stopped, not all compose services on the machine.

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
# state — { worktrees, running:[…], lanUrl, serverPort } (no logs field)
curl -H "Authorization: Bearer <token>" http://localhost:7420/api/state
# start a worktree's dev server (a free pool port is assigned and injected as PORT)
curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"path":"C:/path/to/worktree"}' http://localhost:7420/api/start
# fetch one server's own logs
curl -H "Authorization: Bearer <token>" \
  "http://localhost:7420/api/logs?path=C:/path/to/worktree"
# stop ONE server (pass its path)
curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"path":"C:/path/to/worktree"}' http://localhost:7420/api/stop
# stop ALL running servers (omit the body)
curl -X POST -H "Authorization: Bearer <token>" http://localhost:7420/api/stop
```

### API routes

| Method | Route | Body / query | Returns |
|---|---|---|---|
| GET | `/api/state` | — | `{ worktrees, running, lanUrl, serverPort }` |
| GET | `/api/logs` | `?path=<worktree>` | `{ logs: string[] }` for that server |
| GET | `/api/browse` | `?path=<dir>` (optional) | `{ path, parent, drives, entries }` — subdirectories only (used by the **Browse…** folder picker); `400` if not a directory |
| POST | `/api/start` | `{ path }` | status for that path (pool port assigned) |
| POST | `/api/stop` | `{ path }` (optional) | with `path`: stop that server; without: stop all |
| POST | `/api/command` | `{ path, cmd, label }` | runs a command in that worktree (per-target `409` only — a command in another worktree never blocks this one) |
| POST | `/api/command/stop` | `{ path }` | stops that worktree's running command |

If the port pool (3100–3199) is fully allocated, `/api/start` returns `503` with a
descriptive error. Port allocation combines two checks: local-pm's in-process Map
(prevents handing the same port to two simultaneous starts before either binds) and
an OS bind-probe via `node:net` (skips ports already held by orphaned or externally-started
servers). A port is only assigned when it passes both checks.

Without a valid token these endpoints return `401 {"error":"Unauthorized"}`.

## Running commands in a worktree

Commands are **per-target**: every worktree path has its own command slot. Running a
command in worktree A never blocks starting, stopping, or commanding worktree B —
`/api/command` only returns `409` when *that same path* already has a command running.

A **stopped** worktree row shows command controls. A worktree whose server is running
is controlled from the **Running servers** section, where each running row carries its
own command input and **Stop command** button.

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

Output streams into that worktree's own log buffer (last ~300 combined lines), viewable
via its **Open console** button. The header line is `[cmd] <label>`, followed by
stdout/stderr, then a footer `[cmd] exited <code>`.

Each worktree path has its own 300-line buffer — a noisy command only churns that
path's logs, never another server's.

### Stop command

A running command can be stopped via `POST /api/command/stop` with `{ path }`, which
kills that worktree's command process tree (`taskkill /T /F` on Windows) and marks the
command failed. Each running-server row exposes a **Stop command** button wired to its
own path; stopping a command in worktree A leaves worktree B untouched.

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
binds to `0.0.0.0`. Each running server's row links to its own
`http://<desktop-ip>:<assigned-port>`; the header `lanUrl` points at the first running
server's port (`null` when nothing is running).

## Add projects

### From the UI (recommended)

The **Add project** panel at the top of the dashboard takes a folder path. You
can either **paste** the path (surrounding quotes from Windows "Copy as path" are
stripped automatically) or click **Browse…** to navigate the host filesystem and
pick a folder — the browser shows subfolders only, marks project-looking folders,
offers an **Up** control and (on Windows) a drive switcher, and **Use this
folder** drops the current path into the input and adds it. On **Add**, the
server:

1. **Validates the path** is a real existing directory (`fs.stat`). A bad path
   returns `400` and the panel shows the error — nothing is saved.
2. **Auto-detects the type:**
   - `.git-wt.json` or `.git/git-wt-ports.json` present → `git-wt`
   - a `docker-compose*.yml` / `compose.yaml` present → `docker` (its `${VAR}`
     port placeholders are scanned via `scanComposePortVars`)
   - otherwise → `plain`
3. **Sources the dev command** from the project's **own `package.json`** —
   `scripts.dev` (→ `npm run dev`), else `scripts.start` (→ `npm run start`).
   The dev command is **never** taken from a typed string; it always comes from
   the project's `package.json`.
4. **Persists** the entry to `projects.json` (atomic write: `projects.json.tmp`
   then rename, so a crash never leaves a half-written file).

The detected dev command is returned to the UI and shown on each stopped
worktree row (`starts: <cmd>`) so you can see exactly what **Start** will spawn.

A **plain (non-git) project** has no git worktrees, so it shows up as a **single
row at its own root** (labelled with its type, e.g. `plain`) rather than
rendering nothing — that one row is the startable target.

#### Setup form fallback

If detection is inconclusive — no `dev`/`start` script, or a compose port var
whose base port could not be resolved — `needsSetup` is `true` and an inline
**setup form** appears, pre-filled with whatever was detected. Fill in the dev
command and any port variables, then **Save** (`PATCH /api/projects`). The
project then appears in the worktree list with a **Start** button.

#### Edit / remove

Each project header has a pencil (**Edit** — opens the same form pre-populated to
rename or change the dev command) and an **×** (**Remove**). Both persist via
`PATCH` / `DELETE /api/projects` and survive a page reload.

### By hand

You can still edit `projects.json` at the repo root directly:

```json
[
  { "name": "my-project", "root": "C:/path/to/your/project", "type": "plain" }
]
```

If `projects.json` is missing it's created with a generic placeholder on first run.
Projects whose `root` doesn't exist are flagged and skipped. If `projects.json`
contains invalid JSON, startup fails with a descriptive error
(`projects.json is not valid JSON: …`) rather than starting silently broken.

### Project API routes

| Method | Route | Body | Returns |
|---|---|---|---|
| GET | `/api/projects` | — | `{ projects }` (configured list) |
| POST | `/api/projects/add` | `{ path }` | `{ project, detection }` (detection includes `devCmd`); `400` if not a directory |
| PATCH | `/api/projects` | `{ root, patch }` | `{ project }` (updated); `404` if no match |
| DELETE | `/api/projects` | `{ root }` | `{ projects }` (remaining); `404` if no match |

## Limitations & assumptions

- **Multiple servers run concurrently**. Plain and docker targets use distinct pool ports (3100–3199);
  git-wt targets run on their own port (not pool-assigned). Port allocation is in-process; a second
  local-pm instance on the same machine would collide.
- **Dev mode only.**
- Each plain server's dev `PORT` is injected from the pool; the worktree's dev script
  must honour `PORT`. git-wt targets are not assigned a port — local-pm reads the port
  from the dev server's log output. docker targets receive their compose port vars
  (e.g. `APP_PORT`, `WS_HOST_PORT`) — see [Hybrid port model](#hybrid-port-model).
  The header `lanUrl` points at the first running server's port.
- `docker compose down` is run on stop; its errors are ignored so worktrees without a
  compose file still stop cleanly.
- Windows-specific: uses `npm.cmd`, `taskkill`, and `shell: true` for `.cmd` resolution.
- **No interactive stdin.** Commands waiting on user input hang until stopped manually
  (see [Stop command](#stop-command) above).
