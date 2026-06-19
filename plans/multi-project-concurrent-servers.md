# Plan: Multi-Project Concurrent Servers

**Created:** 2026-06-19
**Branch:** `feat/multi-project-concurrent-servers` _(optional — this repo has been worked directly on `main`; create the branch only if desired)_
**Status:** not started

## Context

local-pm is a LAN dashboard that manages dev servers across git worktrees. Today it enforces a single-server-at-a-time invariant: `runner.js` holds one `active` slot, one shared 300-line log ring buffer, and a single global `inProgress` guard. Starting a second server stops the first.

This plan removes that single-server constraint and replaces it with a per-target (per worktree/project path) model: Map-keyed state, per-server log buffers, per-target port assignment, per-target command execution, and a UI that reflects all running servers simultaneously.

The end state: from the UI, a user can add projects by pointing at a folder (auto-detected as git-wt / Docker / plain, persisted, editable later); start servers in multiple projects/worktrees at once, each on a distinct port; view each server's own log console (lazy: only fetched while open); run an ad-hoc command in one worktree without blocking others; and stop any server independently or stop all at once.

**Out of scope (PRD 2):** Interactive terminals (node-pty + WebSocket + xterm.js) are explicitly deferred. The lazy-console design (fetch logs only while open, GET /api/logs?path=...) is intentionally forward-compatible with PRD 2's streaming approach. This is called out in P1's UI section.

## Risk: high

The runner module is load-bearing (every feature flows through it). The Map-based refactor touches every existing test file. Port-injection is a new concern that did not exist before. UI changes are non-trivial (multi-server list replaces single-server banner).

## Dependencies & Risks

- **SECURITY — RCE surface (P3 + P1/P2 spawn).** The add-project flow accepts a user-supplied folder path and later spawns that project's dev command. Both are live RCE surfaces. Mitigations required: (1) validate the supplied path is a real directory (`fs.stat`) before saving to `projects.json`; (2) the spawned dev command must come from the project's own `package.json` `scripts` field or its `docker-compose*.yml`, never from a raw user-typed string; (3) if no command is auto-detected, the user explicitly fills in a setup form — the displayed value must be shown back to the user before the first spawn so the command is visible and intentional. These validation steps are called out in the P3 steps and in the P1/P2 spawn steps below.
- **runner.js is the blast radius.** Every test file mocks or exercises it. The Map refactor must be done atomically in P1 and all tests updated in the same phase or the test suite will be in an inconsistent state.
- **spawn env injection is new.** Today `spawn` passes `{cwd, shell:true}` only. P1 adds `env`. Windows requires passing the full `process.env` merged with overrides — omitting `process.env` breaks PATH, which breaks `npm.cmd` etc. Tests must verify the env merge, not just that env is passed.
- **git-wt-ports.json is git-wt-owned.** local-pm reads but never writes it. Three cases P2 must handle explicitly: (a) file absent — fall back to local-pm pool allocation (`assignPort`); (b) file present but branch has no entry — same fallback; (c) malformed JSON — catch parse error, log a warning, fall back to pool. All three cases are tested in `ports.test.js`.
- **Atomic writes to projects.json (P3).** Write-then-rename pattern is required to avoid partial-write corruption on crash.
- **Docker compose down scoping (P2).** Per-target stop must pass `--project-name <COMPOSE_PROJECT_NAME>` so it only tears down that stack, not others sharing the same compose file.
- **Port pool collisions (P1).** `assignPort` scans the runner's active Map for ports already allocated to running servers and picks the first free slot in 3100–3199. It does NOT probe the OS for unrelated processes occupying those ports (acceptable single-instance assumption for a LAN tool — document this). On pool exhaustion (all 100 slots taken) `assignPort` throws a descriptive error; the route returns 503. A second local-pm instance on the same machine would collide — out of scope.
- **Phase ordering is strict.** P2 builds on P1's Map-based runner; P3 builds on P2's env-building; P4 builds on P1's per-target command map.

## Phases

### Phase 0: Branch setup (optional)

**Note:** local-pm has been developed directly on `main` (MVP executed on main; environment is not a git repo at time of writing). A feature branch is not required. If the user wants one, run:

```
git init   # if needed
git checkout -b feat/multi-project-concurrent-servers
```

No worktree creation is needed. Skip this phase and proceed to P1 unless the user explicitly requests branch isolation.

---

### Phase 1: Concurrent plain-project servers end-to-end

**Risk:** high
**Mode:** afk
**Type:** mixed
**Success criteria:** Start two plain (freelo-style, no Docker) projects simultaneously from the UI; each runs on a distinct PORT visible in its row; each server's "Open console" button fetches and displays that server's own logs in a panel; stopping one server leaves the other running and its logs unchanged.
**Commit message:** `feat: multi-server Map-based runner, per-server logs, lazy console UI`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `runner.js` | `active` → `Map<path, ServerEntry>`, `inProgress` → `Map<path, bool>`, `logs` → `Map<path, string[]>`; new exports: `startServer(path,meta,env)`, `stopServer(path)`, `stopAll()`, `getStatus(path)`, `getAllStatuses()`, `getLogs(path)`; spawn options: `{cwd, shell:true, env:{...process.env, ...env}}` — spreading `process.env` is mandatory (omitting it breaks PATH and npm.cmd on Windows); devCmd must originate from package.json scripts, never from raw user input |
| create | `ports.js` | `assignPort(path)` — scans runner's active Map for already-allocated ports, picks first free slot in 3100–3199 (in-process only; no OS probe); throws descriptive error on exhaustion; `releasePort(path)` — removes the slot on stop |
| modify | `server.js` | `/api/state` returns `{worktrees, running:[], lanUrl, serverPort}`; add `GET /api/logs?path=...`; `POST /api/stop` accepts optional `{path}` (omit = stop all); `POST /api/start` calls `assignPort` then passes `{PORT}` env to `runner.startServer`; remove global 409 from command handler |
| modify | `public/index.html` | Replace single-server `renderBanner()` with `renderRunning()` list (one row per running server: port/URL, Stop button, Open Console button); lazy console = `openConsole(path)` starts polling `/api/logs?path=...` and renders in a `<pre>`; Stop all button; NOTE comment marking lazy-fetch as PRD-2-forward-compatible |
| modify | `runner.test.js` | Rewrite for Map-based API: multi-server start, per-server logs, stopServer(path), stopAll(), verify env merged with process.env |
| create | `ports.test.js` | `assignPort` allocates distinct ports for distinct paths; `releasePort` frees the slot; exhausted pool throws |
| modify | `server.test.js` | New route tests: `/api/logs?path=`, `/api/stop` with path, `/api/stop` without path (stop all); 409 absent on second concurrent start |
| modify | `runner.command.test.js` | Update stubs/calls to new `runCommand(path,{cmd,label})` signature (no behavior change, just API alignment) |

**Steps:**

- [x] Rewrite `runner.js`: replace module-level `active`/`inProgress`/`logs`/`command` scalars with `Map` instances; update all internal references; update `startServer` signature to `(path, meta, env)`; spawn options must be `{cwd, shell:true, env:{...process.env, ...env}}` — the spread of `process.env` is a hard requirement on Windows (PATH, npm.cmd); update exports
- [x] Create `ports.js` with `assignPort(path)` and `releasePort(path)` scanning the runner's active Map for in-use ports in the 3100–3199 range; export both functions
- [x] Update `server.js` routes: `/api/state` drops `logs` from response body, adds `running` array from `getAllStatuses()`; add `GET /api/logs?path=...` handler returning `getLogs(path)`; update `/api/stop` to accept optional `path`; update `/api/start` to call `assignPort`, pass `{PORT}` to `startServer`; remove global 409 guard from `handleCommand`
- [x] Update `public/index.html`: remove `renderBanner()`; add `renderRunning(running)` building rows from `state.running`; add `openConsole(path)` that polls `/api/logs?path=...` and inserts a `<pre>` panel (lazy fetch: only while panel open); add "Stop all" button calling `/api/stop` with no body; add comment `// PRD 2: replace poll with WebSocket stream (node-pty+xterm.js) — out of scope here` near the console fetch so the seam is visible
- [x] Rewrite `runner.test.js` for Map API; add env-merge assertion
- [x] Create `ports.test.js`
- [x] Update `server.test.js` with new route cases
- [x] Update `runner.command.test.js` for new signature
- [x] Update README: replace "one server at a time" with multi-server model; document `/api/logs`, updated `/api/stop`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `runner.test.js` | Map-based start/stop/status/logs; two servers coexist; env merged with process.env; stopAll(); getLogs(path) isolation |
| create | `ports.test.js` | assignPort returns distinct ports for distinct paths; releasePort frees slot; pool-exhausted throws |
| modify | `server.test.js` | GET /api/logs?path=; POST /api/stop with path; POST /api/stop without path; no 409 on concurrent start |
| modify | `runner.command.test.js` | runCommand(path,...) signature alignment |

**Verification:**

- [x] Automated tests pass: `pnpm test`
- [ ] Manually start two plain-project worktrees from the UI; confirm each row shows a distinct port
- [ ] Click "Open console" on each server; confirm logs appear independently
- [ ] Stop server A; confirm server B is still running with its logs intact
- [ ] "Stop all" terminates both servers

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: multi-server Map-based runner, per-server logs, lazy console UI`
- [ ] Phase marked complete

---

### Phase 2: Docker + git-wt port sourcing

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Two web_template worktrees (e.g. `main` and a feature branch) can be started concurrently from the UI, each assigned distinct APP_PORT and WS_HOST_PORT values derived from their git-wt offset; stopping one runs `docker compose down --project-name <name>` for only that stack, leaving the other running.
**Commit message:** `feat: hybrid port model — git-wt offset + compose env injection + scoped docker stop`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `ports.js` | Add `readGitWtOffset(projectRoot, branch)` reading `.git/git-wt-ports.json` → `{offset}`; add `scanComposePortVars(projectRoot)` scanning `docker-compose*.yml` / `compose.yaml` for `${VAR}` placeholders in `ports:` section → `[{varName, base}]`; add `buildEnvForTarget(worktree)` → env object (git-wt path: compute APP_PORT/WS_HOST_PORT from offset + bases, set COMPOSE_PROJECT_NAME; plain: delegate to `assignPort`; docker-not-git-wt: local-pm-assigned ports for each VAR + COMPOSE_PROJECT_NAME) |
| modify | `runner.js` | `startServer(path, meta)` — remove caller-supplied `env` param; call `buildEnvForTarget(meta)` internally; spawn still uses `{cwd, shell:true, env:{...process.env, ...derivedEnv}}` — `process.env` spread preserved from P1; on `stopServer(path)`, if entry has `COMPOSE_PROJECT_NAME` in its env, run `docker compose --project-name <name> down` scoped to that name only, never bare `docker compose down` |
| modify | `server.js` | `POST /api/start` no longer passes env (runner derives it); passes full worktree meta (project, branch, path, type) |
| modify | `ports.test.js` | Add: `readGitWtOffset` parses the JSON correctly and returns offset; `scanComposePortVars` extracts var names and bases from fixture compose files; `buildEnvForTarget` returns correct env for git-wt, plain, and docker-not-git-wt cases |
| modify | `runner.test.js` | Add: verify env injected in spawn call matches `buildEnvForTarget` output; verify scoped `docker compose down` on stop when COMPOSE_PROJECT_NAME present |

**Steps:**

- [x] Add `readGitWtOffset(projectRoot, branch)` to `ports.js`: reads `.git/git-wt-ports.json`; returns `{offset}` for the branch; returns `null` in all three fallback cases — (a) file absent, (b) file present but branch has no entry, (c) malformed JSON (catch `JSON.parse` error, emit a `console.warn`, return `null`); caller falls back to `assignPort` on `null`
- [x] Add `scanComposePortVars(projectRoot)` to `ports.js`: globs for `docker-compose*.yml` and `compose.yaml`, parses each for `ports:` lines containing `${VAR}` pattern, returns `[{varName, base}]`; returns `[]` if no compose files or no port placeholders
- [x] Add `buildEnvForTarget(worktree)` to `ports.js`: dispatches to git-wt path (offset + base arithmetic), docker-not-git-wt path (assignPort per VAR), or plain path (assignPort for PORT); always includes COMPOSE_PROJECT_NAME for any Docker target
- [x] Update `runner.js` `startServer` to call `buildEnvForTarget(meta)` internally; remove env parameter from signature
- [x] Update `runner.js` `stopServer` to extract `COMPOSE_PROJECT_NAME` from stored entry env and pass `--project-name` flag to `docker compose down` if present
- [x] Update `server.js` `POST /api/start` to pass full worktree meta; remove env assembly from route handler
- [x] Add fixture files for tests: a sample `.git/git-wt-ports.json` and a sample `docker-compose.yml` with `${APP_PORT}` / `${WS_HOST_PORT}` placeholders
- [x] Update `ports.test.js` with new cases
- [x] Update `runner.test.js` with env-injection and scoped-stop assertions
- [x] Update README: document hybrid port model (git-wt offset vs plain PORT vs docker-not-git-wt)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `ports.test.js` | readGitWtOffset: parses correctly; returns null when file absent; returns null when branch not in file; returns null (not throws) on malformed JSON; scanComposePortVars extracts vars from fixture compose; buildEnvForTarget correct for git-wt, plain, and docker-not-git-wt; buildEnvForTarget falls back to assignPort when readGitWtOffset returns null |
| modify | `runner.test.js` | spawn env contains buildEnvForTarget result merged over process.env; stopServer with COMPOSE_PROJECT_NAME passes `--project-name <name>` to docker compose down; stopping target A does NOT invoke compose down for target B (assert compose called exactly once with correct project name) |

**Verification:**

- [x] Automated tests pass: `pnpm test`
- [ ] Manually start two web_template worktrees; confirm each row shows distinct APP_PORT values
- [ ] Stop one; confirm only its `docker compose down` fires (check process output / logs); other worktree stays running
- [ ] Start a plain project alongside a git-wt worktree; both run concurrently on distinct ports

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: hybrid port model — git-wt offset + compose env injection + scoped docker stop`
- [ ] Phase marked complete

---

### Phase 3: Add and manage projects in UI

**Risk:** medium
**Mode:** hil
**Type:** mixed
**Success criteria:** From the UI, add a new project by typing a folder path; the server auto-detects its type (git-wt / Docker / plain) and persists it to `projects.json`; if detection is inconclusive a setup form appears for the user to fill in dev command and port vars; the project then appears in the worktree list with a Start button; remove and edit (rename/change dev command) also work and persist.
**Commit message:** `feat: project CRUD — add/edit/remove via UI with auto-detection`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `detect.js` | `autoDetectProject(folderPath)` → `{type:'git-wt'\|'docker'\|'plain', devCmd, portVars:[], needsSetup:bool}`; first validates `folderPath` is an existing directory (`fs.stat`) — throws if not; checks for `.git-wt.json` / `.git/git-wt-ports.json` (git-wt); `docker-compose*.yml` / `compose.yaml` (Docker); else plain; populates `devCmd` from `package.json` `scripts.dev` or `scripts.start` only — never from user input; sets `needsSetup:true` if devCmd null or portVars ambiguous |
| modify | `config.js` | Add `addProject(entry)`, `removeProject(root)`, `updateProject(root, patch)` — all write `projects.json` atomically (write to `projects.json.tmp` then rename); keep existing `loadProjects()` / `normalizeCommands()` unchanged |
| modify | `server.js` | Add routes: `POST /api/projects/add {path}` → auto-detect (validate dir + detect) → write → respond with project+detection including `devCmd` so UI can display it; route returns 400 if path is not a valid directory; `DELETE /api/projects {root}`; `PATCH /api/projects {root, patch}`; `GET /api/projects` returns list with detection result |
| modify | `public/index.html` | Add "Add project" section: path input + Add button → calls `/api/projects/add` → if `needsSetup` shows inline form (dev cmd + port var fields) → on submit calls `PATCH` → project appears in list; add Edit (pencil) and Remove (×) buttons per project row; edit opens inline form pre-populated |
| create | `detect.test.js` | autoDetectProject: throws on nonexistent path; throws on file-not-dir path; correct type/devCmd/portVars/needsSetup for all fixture types; devCmd sourced from package.json scripts only; needsSetup when devCmd missing |
| modify | `config.test.js` | Tests for `addProject`, `removeProject`, `updateProject` including atomic-write behavior (simulate crash by checking tmp file absent after success) |
| modify | `server.test.js` | Tests for all four new `/api/projects/*` routes |

**Steps:**

- [ ] Create `detect.js` with `autoDetectProject(folderPath)`: **security gate first** — call `fs.stat(folderPath)` and throw `'not a directory'` if it fails or is not a directory (prevents path-traversal saves and later spawn of nonexistent paths); then check `.git-wt.json` presence; check compose file presence; read `package.json` scripts — populate `devCmd` from `scripts.dev` or `scripts.start` only (never accept a dev command from user-typed input); set `needsSetup:true` if devCmd is null or portVars list is ambiguous
- [ ] Add `addProject`, `removeProject`, `updateProject` to `config.js`; implement atomic write for all three: `JSON.stringify` → write to `projects.json.tmp` → `fs.renameSync` to `projects.json`; a crash between write and rename leaves `.tmp` (recoverable), never a half-written `projects.json`
- [ ] Add the four `/api/projects/*` routes to `server.js`; keep route handler thin (logic in config.js / detect.js)
- [ ] Add "Add project" UI to `public/index.html`: path input → POST → response includes detected `devCmd` → always display `devCmd` in the project row before enabling Start (user sees what will be spawned); if `needsSetup:true` show inline form pre-filled with detected value for confirmation → PATCH on submit; per-row Edit and Remove
- [ ] Create fixture directories for `detect.test.js` (one git-wt fixture, one Docker fixture, one plain fixture, one ambiguous fixture)
- [ ] Create `detect.test.js`
- [ ] Update `config.test.js` with CRUD + atomic-write cases
- [ ] Update `server.test.js` with project-route cases
- [ ] Update README: document "Adding a project" workflow, auto-detection logic, setup form fallback

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `detect.test.js` | autoDetectProject: throws on nonexistent path; throws on file-not-dir; correct type/devCmd/portVars/needsSetup for git-wt, docker, plain, ambiguous fixtures; devCmd from package.json only; needsSetup when devCmd missing |
| modify | `config.test.js` | addProject persists to JSON; removeProject removes entry; updateProject patches entry; atomic-write: tmp file gone after success |
| modify | `server.test.js` | POST /api/projects/add calls detect + config; DELETE removes; PATCH updates; GET returns list |

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] Manually add a plain project (e.g. freelo) via UI path input; confirm it appears in list and Start works
- [ ] Add a git-wt project; confirm type detected correctly and no setup form shown
- [ ] Add a project with no `dev` script; confirm setup form appears; fill it in; confirm project saved and Start works
- [ ] Remove a project; confirm it disappears from list and `projects.json`
- [ ] Edit a project's dev command; confirm change persists across page reload

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: project CRUD — add/edit/remove via UI with auto-detection`
- [ ] Phase marked complete

---

### Phase 4: Per-target ad-hoc commands

**Risk:** low
**Mode:** afk
**Type:** mixed
**Success criteria:** Running an ad-hoc command in worktree A while worktree B has an active server returns 200 (not 409); each server row in the UI has its own command input; a command running in worktree A does not block starting, stopping, or commanding worktree B.
**Commit message:** `feat: per-target ad-hoc commands — remove global 409, per-path command map`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `runner.js` | `command` scalar → `Map<path, CommandEntry>`; `runCommand(path, {cmd,label})` checks only that path's guard; `stopCommand(path)` stops only that path's command; `getStatus(path)` includes that path's `command` field |
| modify | `server.js` | `POST /api/command {path,cmd,label}` — per-target 409 only (not global); `POST /api/command/stop {path}` — passes path through |
| modify | `public/index.html` | Command input (text field + Run button) moves inside each running-server row; was a single global input |
| modify | `runner.command.test.js` | Rewrite for Map-based per-target command; add case: two paths can run commands simultaneously; per-path 409 when that path's command is active |
| modify | `server.test.js` | Add: two worktrees run commands simultaneously (both return 200); per-target 409 when same path has active command |

**Steps:**

- [ ] Replace `command` scalar in `runner.js` with `Map<path, CommandEntry>`; update `runCommand(path,{cmd,label})`, `stopCommand(path)`, `getStatus(path)` to use per-path map
- [ ] Update `server.js` `POST /api/command` to do per-target busy check (`getStatus(path).command !== null`) instead of global check; update `POST /api/command/stop` to pass path
- [ ] Move command input in `public/index.html` from global position into each running-server row; wire up path-scoped start/stop calls
- [ ] Rewrite `runner.command.test.js` for Map API and concurrent-path case
- [ ] Update `server.test.js` with concurrent-command and per-target-409 cases

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `runner.command.test.js` | runCommand(pathA,...) and runCommand(pathB,...) coexist; per-path 409 when same path busy; stopCommand(path) only stops that path |
| modify | `server.test.js` | POST /api/command two distinct paths both succeed; same path twice returns 409 |

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] Manually: start server in worktree A; run a command in worktree B via UI → no 409
- [ ] Run command in worktree A while A's server is running → command appears in A's row, B unaffected
- [ ] Stop command in A → B's state unchanged

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: per-target ad-hoc commands — remove global 409, per-path command map`
- [ ] Phase marked complete

---

### Phase 5: Documentation

**Risk:** low
**Mode:** hil
**Type:** docs
**Success criteria:** README accurately describes the multi-server model, all new API routes, and the hybrid port scheme; ROADMAP marks Stage C (parallel servers) complete and lists PRD 2 (interactive terminals) as the next stage; user has reviewed and approved both documents.
**Commit message:** `docs: update README and ROADMAP for multi-server model`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `README.md` | Replace "one server at a time" language; document all new API routes (`GET /api/logs`, `GET /api/projects`, `POST /api/projects/add`, `DELETE /api/projects`, `PATCH /api/projects`); document hybrid port model (git-wt offset, plain PORT pool, docker-not-git-wt); document "Adding a project" workflow |
| modify | `ROADMAP.md` | Mark Stage C (parallel servers) complete; add PRD 2 (interactive terminals: node-pty + ws + xterm.js) as next planned stage |

**Steps:**

- [ ] Update README.md with multi-server model description, new routes table, hybrid port model explanation, and "Adding a project" workflow
- [ ] Update ROADMAP.md: tick Stage C complete; add PRD 2 entry with description of interactive terminals scope
- [ ] User reviews both documents and approves

**Tests:**

No automated tests — justified because: pure documentation change with no executable logic.

**Verification:**

- [ ] README accurately reflects all routes introduced in P1–P4
- [ ] README hybrid port section matches actual behavior of `ports.js`
- [ ] ROADMAP Stage C marked complete
- [ ] ROADMAP PRD 2 entry present with interactive-terminals description
- [ ] User has read and approved both documents

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing (or no-tests justification accepted)
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `docs: update README and ROADMAP for multi-server model`
- [ ] Phase marked complete

---

### Phase Final: Final Verification

**Mode:** hil

**Overall success criteria:**

- From the UI, add a project by pointing at a folder; it auto-detects type, persists, is editable
- Start servers in two or more projects/worktrees simultaneously; each has a distinct port/URL shown in its row
- "Open console" for each running server fetches and displays that server's own logs independently
- Run an ad-hoc command in one worktree without blocking any other
- Stop any single server independently; all others remain running
- "Stop all" terminates every running server cleanly
- For git-wt projects: stopping one worktree's server runs `docker compose down` scoped to that worktree only
- No CLAUDE.md invariants violated (zero runtime deps, no build step, plain ESM, node:http, pnpm)

**Steps:**

- [ ] Every preceding phase's Steps / Verification / Phase review checkboxes are ticked in this plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review have been reflected back into this plan file
- [ ] All tests pass: `pnpm test`
- [ ] No CLAUDE.md invariants violated
- [ ] Feature tested manually (golden path: add project → start server → view logs → stop; edge cases: pool exhausted, missing git-wt-ports.json, ambiguous compose file)
- [ ] Overall success criteria above met
- [ ] All phase checkboxes above are ticked

---

## Documentation

| Change | Documentation location |
|---|---|
| Multi-server model replaces single-server; new /api/logs and /api/stop with path | `README.md` (Phase 1) |
| Hybrid port model: git-wt offset, plain pool, docker COMPOSE_PROJECT_NAME scoping | `README.md` (Phase 2) |
| "Adding a project" workflow, auto-detection, setup form fallback | `README.md` (Phase 3) |
| Per-target commands, removed global 409 | `README.md` (Phase 4) |
| Stage C complete; PRD 2 (interactive terminals) as next stage | `ROADMAP.md` (Phase 5) |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | Map-based runner: multi-server start/stop/status/logs; env merge with process.env; stopAll(); getLogs isolation | `runner.test.js` |
| Phase 1 | Port pool: assignPort distinct across paths; releasePort frees slot; pool-exhausted error | `ports.test.js` |
| Phase 1 | Server routes: GET /api/logs?path=; POST /api/stop with/without path; no global 409 | `server.test.js` |
| Phase 1 | runCommand signature alignment | `runner.command.test.js` |
| Phase 2 | readGitWtOffset: parse JSON, null on missing file/branch | `ports.test.js` |
| Phase 2 | scanComposePortVars: extract var names and bases from fixture compose files | `ports.test.js` |
| Phase 2 | buildEnvForTarget: correct env for git-wt, plain, docker-not-git-wt | `ports.test.js` |
| Phase 2 | spawn receives env from buildEnvForTarget; scoped docker compose down on stop | `runner.test.js` |
| Phase 3 | autoDetectProject: path validation (nonexistent/file); type/devCmd/portVars/needsSetup for all fixtures; devCmd from package.json only | `detect.test.js` |
| Phase 3 | config CRUD: addProject/removeProject/updateProject persist; atomic write — tmp→rename (no orphaned .tmp on success; projects.json never partially written) | `config.test.js` |
| Phase 3 | Project routes: POST /api/projects/add, DELETE, PATCH, GET | `server.test.js` |
| Phase 4 | Per-target command Map: two paths concurrent; per-path 409; stopCommand(path) scoped | `runner.command.test.js` |
| Phase 4 | Server command routes: two paths concurrent (200); same path twice (409) | `server.test.js` |
| Phase 5 | Pure docs — no automated tests | — |

## Human Summary

**What and why:** local-pm today lets you run exactly one dev server at a time — starting a second one kills the first. This plan replaces that constraint with a true multi-server model so you can run, say, a freelo instance and two web_template worktrees all at once, each on its own port, with its own log console, with commands you can run independently in each.

**How the phases connect:**

- **P1** does the heavy lifting: rewrites the runner's single-slot state into Maps, introduces a simple port pool for plain projects, updates the server API and UI so the whole feature is exercisable end-to-end for plain projects.
- **P2** layers on Docker and git-wt awareness: reads git-wt's pre-allocated port offsets, scans compose files for port-variable names, injects the right env into each spawn, and scopes `docker compose down` to the correct stack on stop.
- **P3** adds the project management UI: point at a folder, auto-detect type, persist, edit, remove. After this phase you no longer need to hand-edit `projects.json`.
- **P4** is small: moves the ad-hoc command feature from a single global input to a per-server input, removing the global 409 gate.
- **P5** catches up README and ROADMAP.

**End result:** A LAN dashboard where you point at any project folder, it figures out how to run it, and you can have as many dev servers running simultaneously as you want — each with its own port, its own log view, and independent start/stop/command controls.

**Key trade-offs:**
- Port pool (P1) is in-process only; two local-pm instances on the same machine would collide. Acceptable for a personal LAN tool.
- No OS-level port probing; allocation is fast but relies on local-pm controlling the pool.
- Interactive terminals (xterm.js) are deferred to PRD 2; the lazy-fetch log API is designed to be forward-compatible with that upgrade.
- Atomic write for projects.json (write-then-rename) protects against corruption but is OS-level, not transactional — concurrent writes from two browser tabs could still race. Acceptable given the single-user LAN context.
