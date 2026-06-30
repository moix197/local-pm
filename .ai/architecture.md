# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction. Capture the *structure and
its rationale* — not API-level detail the code already documents.

## System shape

A single daemon process (`src/server.js`) owns three surfaces from one `node:http`
server: the dashboard (static `public/`), the REST API (`/api/*`), and a WebSocket
upgrade. No web framework, no build step — Node built-ins plus `node-pty`/`ws` only.
See [node-builtins-only](decisions/node-builtins-only.md). A generic
`serveStatic(baseDir, urlPrefix)` (realpath/`startsWith` traversal guard, shared
`STATIC_CONTENT_TYPES` MIME map) serves `/vendor/*`, `/js/*`, and `/css/*` — all
**before** the `/api/` auth gate, so the frontend's own assets load unauthenticated
exactly like `/` and the vendored libs.

State lives in process memory inside the service modules (runner's per-path Maps),
except the project list which persists to `projects.json` via `config`, and the auth
token which persists to `token.local` via `token`. The daemon binds `0.0.0.0` so the
LAN can reach it; auth gates the API rather than the bind address.

`ports` holds its allocation map (`path → port`) in process memory only — nothing
is persisted, so the pool resets on daemon restart. Allocations survive a restart
only incidentally: `assignPort` cross-checks running servers and OS-bound ports, so
a still-running dev server's port is re-skipped even after the map is lost.

Interactive terminals are a second surface of the same daemon: `ws` attaches a
WebSocket server (`noServer`) to the same `node:http` server and routes frames to
`pty`, which spawns real shells (pwsh/cmd) or `claude` via `node-pty`. `node-pty` is
used over plain `child_process` because terminal programs need a real PTY/ConPTY
(TTY semantics, resize, ANSI) that pipes can't provide — recoverable from the
spawn/resize code, so no decision file. `pty` keeps its sessions (`id → session`)
in process memory only, capped at `MAX_SESSIONS = 10`.

The browser frontend is **native ESM, no build step** (see
[frontend-native-esm-modules](decisions/frontend-native-esm-modules.md)): a thin
`public/index.html` shell loads `public/css/app.css` and `public/js/main.js`, which
imports the `public/js/*` module tree. `main.js` is the only orchestrator; a leaf
`app-events.js` holds shared mutable state (`lastState`/`inFlight`) and registerable
render/auth callback slots so lower modules never import `main.js` back — the import
graph stays a DAG. Per-module responsibilities live in `public/js/README.md`, not
here. It talks to the daemon over two channels — a 2s `GET /api/state` +
`/api/projects` poll for dashboard state, and one WebSocket per terminal tab
(xterm.js) for live I/O.

Each terminal group carries a persistent bottom input toolbar (`terminals.js`,
built once per group, anchored as the group's last child so the poll's wipe and
new panes never displace it): fixed quick-key buttons that send raw byte
sequences (Enter/Esc/arrows/Tab/Ctrl+C/literals) to the active session's
WebSocket, plus tappable text-macro chips. Macros are a frontend-only store — a
leaf `term-macros.js` does `localStorage` CRUD for a global `{label, text}` list,
persisted per-device with no daemon involvement (see
[terminal-macros-localstorage](decisions/terminal-macros-localstorage.md)). On
narrow viewports (≤768px) the left nav becomes a collapsible drawer toggled by a
class on the static `.app` wrapper, so the 2s poll's innerHTML wipe preserves the
open/closed state. A per-group full-screen "focus mode" (⛶) toggles classes on
`<body>` + the persistent group root to fill the viewport (`100dvh`) and lock page
scroll for mobile terminal use; it refits the active session (never disposes it)
and auto-releases on worktree switch or last-tab close to avoid a scroll-lock trap.

On desktop, a modal keyboard layer (`public/js/keynav/*`) lets the whole UI be
driven without a mouse: a single capture-phase `keydown` handler with two modes —
NAV (`gt`/`gT` projects, `↑`/`↓` worktrees, `ctrl+shift+p` fuzzy quick-nav palette,
`Enter`/`i` into a terminal) and WRITING (a terminal is focused; the handler owns
nothing but a double-`Esc`, so a lone `Esc` and every other key reach xterm). It is
gated to desktop and inert on mobile (which has the touch toolbar instead). The
layer obeys the same DAG discipline as the rest of the frontend: it routes selection
+ render through `app-events.js`/`selection.js` and never imports `main.js`; its mode
reducer, desktop gate, traversal index math, fuzzy matcher, and MRU localStorage
store are pure leaves so they unit-test without a DOM. The `NAV`/`WRITING` badge and
the palette overlay mount on `document.body` (outside the poll-rebuilt sidebar/main
subtree) and re-assert idempotently in the render callback, so the 2s poll never
tears them down or steals focus. See
[desktop-modal-keyboard-nav](decisions/desktop-modal-keyboard-nav.md) and
[quicknav-mru-localstorage](decisions/quicknav-mru-localstorage.md).

`mcp/` is a **standalone package** outside the daemon: its own `package.json`
(`@modelcontextprotocol/sdk` + `zod`, deps the daemon never pulls in), not a pnpm
workspace member, no shared code. It holds zero state and forwards every tool call
to the daemon's `/api/*` over HTTP, so the daemon stays the single source of truth.
See [standalone-mcp-package](decisions/standalone-mcp-package.md).

## Dependency direction

One-way: entry → services → store. `server` imports the services
(`runner`, `config`, `token`, `detect`) and calls them; none of those import
`server`. `runner` depends on `ports`; `detect` depends on `ports`. Services never
reach back to the HTTP layer, so the request handler is replaceable without
touching lifecycle logic (and tests drive the services directly).

## Data flow

Incoming request → if path starts with `/api/`, `isAuthorized(req)` checks the
`Authorization: Bearer` header against the stored token (401 on mismatch) → matched
route handler runs. Handlers translate HTTP into service calls: `/api/start` →
`runner.startServer`, `/api/stop` → `runner.stopServer`/`stopAll`, project CRUD →
`config`, `/api/projects/add` → `detect.autoDetectProject` then `config.addProject`.

Start lifecycle (`runner.startServer`): per-path `inProgress` guard → docker-running
check if a compose file is present → build target env (`ports.buildEnvForTarget`) →
**run `npm install` only when `node_modules` is absent** → spawn the dev server.
Stop teardown kills the process tree and runs `docker compose down` scoped by
`COMPOSE_PROJECT_NAME` when set. Logs are not pushed: they accumulate in a per-path
ring buffer and are fetched lazily on `GET /api/logs`.

Target enumeration → env → port (feeds the start lifecycle above):
`worktrees.getWorktrees` runs `git worktree list --porcelain` per configured project
and parses each entry; a project with no real worktrees (or whose `git` call fails)
contributes one **synthetic root row** so it still shows as a startable target. Each
target carries the project's `type` (git-wt / docker / plain, from `detect`).
`ports.buildEnvForTarget` then branches on that type to produce the spawn env:
- **git-wt** — injects no PORT/WS_PORT (the dev server owns its own fixed port; see
  [hybrid-port-models](decisions/hybrid-port-models.md)); sets `COMPOSE_PROJECT_NAME`
  only when a compose file is present.
- **docker** — `assignPort` per compose port-var (keyed by composite `${path}:${varName}`)
  drawn from the 3100–3199 pool; sets `COMPOSE_PROJECT_NAME`.
- **plain** — a single `PORT` from the pool, keyed by the worktree path.

`assignPort` reserves the first slot that is neither in the allocation map nor bound
on the OS; `releasePort(path)` frees the path's port and any `${path}:*` composite keys.

Terminal lifecycle (decouples the PTY session from the WebSocket so a closed tab
doesn't kill the shell): WS upgrade → `ws.authorizeUpgrade` checks the query-string
`token` (timing-safe) and, when an `Origin` header is present, an allowlist built
from localhost/127.0.0.1/the LAN IPv4 (`netinfo`) → on a known `sessionId`,
`pty.attachClient` (reattach); otherwise `pty.spawnSession` (new). At spawn, `pty`
wires `onData` **once**: every chunk is appended to the session's scrollback ring
(evicted from the front past `SCROLLBACK_MAX_BYTES = 512000` / `SCROLLBACK_MAX_CHUNKS
= 5000`) and sent live only while a client is attached. `attachClient` replays the
full scrollback to the new socket in order, then sets it as the live client
(superseding any prior socket). `detachClient` (on WS close) just nulls the client
and stamps `idleAt` — the PTY keeps running. A 60s reaper kills sessions idle (no
client) longer than `IDLE_TIMEOUT_MS` (env `LOCAL_PM_IDLE_TIMEOUT_MINUTES`, default
30 min). This is what lets a browser reattach to a still-running terminal and see
its backlog. On teardown, `killSession` removes the session from the map immediately
(so `MAX_SESSIONS` cap is correct at once), then `finalizeSession` writes `\x03` +
`/exit\r` to ask claude to flush its incremental session JSONL, and schedules an
unconditional force-kill after a 1500 ms grace window — preventing zombie ConPTY
processes on Windows. claude already writes JSONL as the conversation progresses, so
this hardens the last-turn flush for a cleaner `/resume` listing on close; it is not
the primary fix for refresh continuity (that is the `localStorage` reattach in
`term-sessions.js`). On SIGINT/SIGTERM, `shutdown()` skips the grace window and kills
every session synchronously, also cancelling any pending grace timers from prior
`killSession` calls (tracked in `_pendingGrace`) so the daemon exits promptly with no
leaked timers.

MCP flow: an MCP client invokes a tool (`list_worktrees`, `status`, `start_server`,
`stop_server`) over stdio → `mcp/index.js` resolves the bearer token (env
`LOCAL_PM_TOKEN`, else `token.local`) → `fetch`es the matching daemon `/api/*`
endpoint → returns the JSON; any failure is wrapped as an MCP `isError` result so a
down daemon or bad token never crashes the adapter.

> Update via the `sync-knowledge` skill when an architectural boundary, package,
> or flow is introduced or changed.
