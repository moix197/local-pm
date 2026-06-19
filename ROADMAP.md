# local-pm — Roadmap

A lightweight, LAN-accessible local dashboard to view and control Docker servers
across git worktrees for **all** projects. Lives in `local_pm`, consumes `git-wt`,
runs as a background daemon on the desktop.

## North star

One local daemon serving a web dashboard on the home network. It lists every
configured project and its worktrees, shows each worktree's Docker status, and
lets you start / stop / restart a worktree's stack from the browser — including
from a remote Claude Code session on the same network. Multiple worktrees can run
at once on distinct ports. Outside-network (ngrok) access is deferred.

## Design decisions (locked)

- **Separate tool**, not folded into git-wt. git-wt = stateless worktree-lifecycle
  CLI that deliberately does **not** run docker. local-pm = persistent web+docker
  daemon. Dependency flows one way: `local-pm → git-wt`.
- **Lightweight stack**, mirroring git-wt: TypeScript + tsup, Node 22, `node:http`
  only (no web framework), near-zero deps. Frontend is a single static HTML page +
  vanilla JS — no React, no build step for the UI.
- **All projects, configurable** from day one (config file + worktree discovery).
- **LAN-only for V1.** ngrok/tunnel management deferred.
- **Consume git-wt via `git-wt list --json`** for V1; extract a programmatic API later.

## Architecture

- **Backend**: Node + TS, `node:http`. Shells out to `docker compose` and `git-wt`.
- **Worktree/port data**: `git-wt list --json` per project.
- **Docker control**: `docker compose -p <project> ... up -d | down | ps | logs`.
- **Live status**: short polling or SSE.
- **Frontend**: one static HTML file + vanilla JS.
- **Config**: `projects.json` listing project roots; auto-discover worktrees and
  which have a compose file.
- **Binding**: `0.0.0.0:<port>` so other LAN machines reach it.

---

## Phase 0 — Make worktrees independently runnable  *(git-wt config — prerequisite)*

Root cause: all `web_template` worktrees share `COMPOSE_PROJECT_NAME=web-template`
and host ports 3000/4001 → collision. The compose file already supports isolation
(parameterized names + ports, no hardcoded `name:`). Fix `web_template/.git-wt.json`:

- `env.unique`: `{ "COMPOSE_PROJECT_NAME": "{repo}-{branch}" }`
- `ports.envVars`: add `APP_PORT`, `WS_HOST_PORT` (the host-published ports the
  compose file actually reads).
- `preRemove`: `["docker compose -p {repo}-{branch} down -v"]`

Backfill existing worktrees' `.env` with their unique name + ports. **Exit test:**
two worktrees `up -d` at the same time, both reachable on different ports.

## Phase 1 — git-wt JSON surface

Add `git-wt list --json` emitting structured records per worktree: branch, path,
isMain, allocated port(s), `COMPOSE_PROJECT_NAME`, has-compose flag. Small, in-scope
addition to git-wt's public surface.

## Phase 2 — Dashboard backend (read-only)

- Config loader + project discovery.
- `GET /api/projects` → projects → worktrees (from `git-wt list --json`) joined with
  live Docker status (`docker compose ps` / `docker ps`).
- Status polling endpoint.
- LAN binding, single configurable port.

## Phase 3 — Control actions

- `POST` start / stop / restart per worktree → `docker compose -p <name> up -d | down`.
- Surface each running worktree's LAN URL: `http://<desktop-ip>:<host-port>`.
- Optional: stream `docker compose logs -f` over SSE.

## Phase 4 — Web UI

Single page: projects → worktrees, status badges, port, start/stop/restart buttons,
click-through LAN URL, optional log drawer. Vanilla JS, no build.

## Phase 5 — Run as a background service

Auto-start on Windows boot (Task Scheduler / nssm / pm2) so the dashboard is always
reachable when you remote in.

## Phase 6 — Token login overlay + persistent auth  *(done)*

Login overlay shown when no token is stored. Token validated on submit, persisted to
`localStorage` — paste once per device, survives browser restarts. "Forget token" link
clears it and re-shows the overlay. Stale-token mid-session triggers the overlay
automatically on the next poll. Legacy `#token=` URL still works and also persists.

## Phase 7 — Run commands in a worktree  *(done)*

Quick-action buttons (`npm install`, `npm run build`, `npm run lint`) on every stopped
worktree row. Per-project custom commands via `commands` array in `projects.json`
(strings or `{label,cmd}` objects, extend defaults, project wins on label collision).
Free-form command input with a confirmation dialog. Command output streams to the shared
log panel; green/red banner shows exit code. Stop-command button kills a running command.
Single-operation guard reused — commands and server start/stop are serialized.

---

## Phase 8 — Multi-project concurrent servers  *(done)*

Removed the single-server-at-a-time constraint. The runner is now per-target
(`Map<path, …>`): multiple dev servers run simultaneously, each on a distinct port,
each with its own log buffer and lazy-fetched console (`GET /api/logs?path=`).
`POST /api/stop` stops one server by `path` or all when the body is omitted. Hybrid
port model: git-wt offset (`.git/git-wt-ports.json`), an in-process plain-`PORT` pool
(3100–3199, `503` on exhaustion), and docker-not-git-wt (pool port per compose var +
`COMPOSE_PROJECT_NAME`); `docker compose down` is scoped with `--project-name` on stop.
Project CRUD from the UI (`/api/projects` add/edit/remove) with auto-detection
(git-wt / docker / plain) and a setup-form fallback; the spawned dev command always
originates from the project's `package.json` scripts or the explicit setup form, never
raw user input. Ad-hoc commands are per-target — the global `409` is gone, so a command
in one worktree never blocks another.

---

## PRD 2 — Interactive terminals  *(next planned)*

Replace the poll-based lazy console with true interactive terminals: `node-pty` for a
real PTY per worktree, a WebSocket channel for bidirectional streaming, and `xterm.js`
in the browser. The Phase-8 lazy-fetch log API (`GET /api/logs?path=`) was designed to
be forward-compatible with this upgrade — the fetch seam is marked in the UI code.
Enables interactive commands (prompts, REPLs, full TTY programs) that the current
fire-and-read command model cannot support.

---

## Deferred (post-V1)

- **ngrok / cloudflared** tunnel management for outside-network access, surfaced
  per worktree in the UI.
- **Extract git-wt programmatic API** (`exports` + importable `core/`), replacing the
  `list --json` shell-out.
- **Auto-stop server before running a command** (config opt-in): optionally stop the
  running server automatically before executing a command, then optionally restart it
  after — useful for commands that need the port free.
- **HTTPS / self-signed cert + hardening before any remote exposure.** The dashboard
  runs over HTTP cleartext with a single Bearer token as the only boundary. It executes
  arbitrary shell commands on the host. This is acceptable for solo/LAN use. It MUST get
  HTTPS (self-signed or real cert), a stricter auth model, and a hardening review before
  being exposed to any network outside the trusted LAN.

## Security note

Binding `0.0.0.0` gives anyone on the LAN start/stop control over your Docker stacks,
and (as of Phase 7) the ability to run arbitrary shell commands on the host. The Bearer
token is the sole authentication boundary. Acceptable on a trusted home network;
**must** add HTTPS + hardening before any remote/non-LAN exposure.
</content>
</invoke>
