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

**Browser:** open `http://localhost:7420/#token=<value>`. The page reads the token from
the URL fragment, stores it in `sessionStorage`, and strips the fragment from the URL bar.
Open `GET /` without a token and the page loads but shows an "add your token" message in
place of the project list.

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

## Run as a background service

To have local-pm start automatically at log-on (no terminal needed), register a Windows
Task Scheduler task:

```sh
pnpm schedule:install
```

Remove it with:

```sh
pnpm schedule:uninstall
```

Both scripts are idempotent (delete-then-create), so re-running install never duplicates
the task.

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

The `mcp/` folder is a standalone package that exposes local-pm's four daemon actions as
[Model Context Protocol](https://modelcontextprotocol.io) tools so Claude Code (or any MCP
client) can drive the daemon directly.

### Setup

**First time (or after cloning):**

```sh
cd mcp && pnpm install
```

If the `mcp/node_modules` folder is missing (e.g. fresh clone), run the above. If you need
to upgrade the SDK:

```sh
cd mcp && pnpm add @modelcontextprotocol/sdk
```

### Add to Claude Code

Create or edit `.mcp.json` in your repo root (or `~/.claude/.mcp.json` for global use):

```json
{
  "mcpServers": {
    "local-pm": {
      "command": "node",
      "args": ["C:/path/to/local_pm/mcp/index.js"],
      "env": {
        "LOCAL_PM_URL": "http://localhost:7420",
        "LOCAL_PM_TOKEN": "<paste token here — or omit to auto-read token.local>"
      }
    }
  }
}
```

Replace `C:/path/to/local_pm` with the absolute path to your repo. `LOCAL_PM_TOKEN` is
optional — if omitted the adapter reads `token.local` from the repo root automatically.

### Available tools

| Tool | Params | What it does |
|---|---|---|
| `list_worktrees` | — | Returns the list of all known git worktrees |
| `status` | — | Returns the current dev server status (running/idle, path, etc.) |
| `start_server` | `path` (string) | Starts the dev server for the given worktree path |
| `stop_server` | — | Stops the currently running dev server |

### Token resolution

`LOCAL_PM_TOKEN` env var takes precedence. If not set, the adapter reads `token.local`
from the repo root (the same file the daemon generates on first start). If neither is
available, tool calls return a clear MCP error instead of crashing.

### Failure behavior

When the daemon is unreachable, returns a non-2xx response, or the token is missing, each
tool returns a structured MCP error (`isError: true`) with a descriptive message. No tool
call ever crashes the MCP server process — failures are always surfaced as MCP-level errors.

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
