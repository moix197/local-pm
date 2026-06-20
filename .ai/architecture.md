# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction. Capture the *structure and
its rationale* — not API-level detail the code already documents.

## System shape

A single daemon process (`src/server.js`) owns three surfaces from one `node:http`
server: the dashboard (static `public/`), the REST API (`/api/*`), and a WebSocket
upgrade. No web framework, no build step — Node built-ins plus `node-pty`/`ws` only.
See [node-builtins-only](decisions/node-builtins-only.md).

State lives in process memory inside the service modules (runner's per-path Maps),
except the project list which persists to `projects.json` via `config`, and the auth
token which persists to `token.local` via `token`. The daemon binds `0.0.0.0` so the
LAN can reach it; auth gates the API rather than the bind address.

`ports` holds its allocation map (`path → port`) in process memory only — nothing
is persisted, so the pool resets on daemon restart. Allocations survive a restart
only incidentally: `assignPort` cross-checks running servers and OS-bound ports, so
a still-running dev server's port is re-skipped even after the map is lost.

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

> Update via the `sync-knowledge` skill when an architectural boundary, package,
> or flow is introduced or changed.
