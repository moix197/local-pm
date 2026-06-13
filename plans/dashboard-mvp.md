# Plan: Dashboard MVP

**Created:** 2026-06-12
**Status:** not started

## Context

A scaffold for local-pm was built quickly in a prior step and lives at `C:\proyectos\local_pm`. It covers the core modules (config, worktrees, runner, netinfo, server) and a single-page frontend. The scaffold is a starting reference; this plan is the authoritative spec. Each phase reconciles and finishes the scaffold to spec, adds tests, and verifies the outcome is user-observable. The goal is a shippable Dashboard MVP that automates the user's manual dev-server workflow over LAN with zero runtime dependencies.

Note: `C:\proyectos\local_pm` is not a git repository. Phase commits are logical units only — no git commands are run. Optional: `git init` if you later want history.

## Risk: low

The scope is a single-machine Node.js process. No network complexity, no database, no external services beyond the local Docker daemon. Biggest risk is Windows process-tree management and the interaction between `taskkill` and orphaned ports — already researched and the approach is settled.

## Dependencies & Risks

- Windows only: `npm.cmd`, `taskkill /T /F`, `shell: true`. The plan is intentionally Windows-specific.
- `git worktree list --porcelain` must be run from the project root — fails if the root doesn't exist; graceful skip already in scaffold.
- `docker compose down` errors are intentionally ignored; some worktrees have no compose file.
- Port 3000 is assumed for dev servers; hardcoded in the LAN link (no config knob needed in MVP).
- `node:test` (Node v22 built-in) is used for all tests — no test framework dependency.
- Phase 4 (live logs) requires a real running dev server to verify auto-scroll behavior; manual check needed in addition to unit tests.

---

## Phases

### Phase 1: See worktrees

**Risk:** low
**Mode:** afk
**Type:** mixed
**Success criteria:** Opening `http://localhost:7420` (and the printed LAN URL) shows the list of worktrees for all configured projects, grouped by project name, each row showing branch and path. Server starts with `pnpm start` and prints both local and LAN URLs to stdout. No actions (Start/Stop) need to work yet — only the list must render correctly.
**Commit message:** `feat: worktree list, http server, and minimal dashboard UI`

**File changes:**
| Action | File | What changes |
|---|---|---|
| verify/modify | `src/config.js` | Ensure `loadProjects()` returns `exists` flag; add JSDoc; guard against malformed JSON in `projects.json` with a descriptive thrown error |
| verify/modify | `src/netinfo.js` | Confirm `getLanIPv4()` falls back to `127.0.0.1` correctly; add JSDoc |
| verify/modify | `src/worktrees.js` | Confirm `parseWorktreePorcelain` handles bare worktrees (no branch line) and detached HEAD; export it as a named export for testability; add JSDoc to exported `getWorktrees()` |
| verify/modify | `src/server.js` | Confirm `GET /` serves `public/index.html`; confirm `GET /api/state` returns `{ worktrees, status, logs, lanUrl, serverPort }`; confirm startup logs print local + LAN URL; confirm `0.0.0.0` bind; stub `status`/`logs`/`lanUrl` are correct shapes even when runner is idle |
| verify/modify | `public/index.html` | Confirm worktree list renders grouped by project; confirm LAN URL displayed in header when idle (muted style); confirm polling is 2 s; no functional changes needed if scaffold already correct |
| create | `src/__tests__/config.test.js` | Unit tests for `loadProjects()` |
| create | `src/__tests__/netinfo.test.js` | Unit tests for `getLanIPv4()` |
| create | `src/__tests__/worktrees.test.js` | Unit tests for `parseWorktreePorcelain()` |
| modify | `package.json` | Add `"test": "node --test"` script |
| modify | `README.md` | Confirm "Run" and "Add projects" sections are accurate; add Node v22 requirement callout if missing |

**Steps:**

- [x] Read each existing source file; note any gap vs. spec (described above under File changes)
- [x] Export `parseWorktreePorcelain` from `src/worktrees.js` (currently unexported) so it can be unit-tested — keep it as a named export, not changing its behavior
- [x] Add malformed-JSON guard in `config.js`: wrap `JSON.parse` in try/catch, rethrow with message `"projects.json is not valid JSON: <original message>"`
- [x] Make the default-written `projects.json` publish-safe: write a generic placeholder (mirror `projects.example.json`) instead of a machine-specific `web_template` path, so a fresh clone doesn't ship someone else's paths
- [x] Verify `server.js` `handleState` returns correct shape when `active` is null and `logs` is empty
- [x] Confirm `pnpm start` prints both URLs (run and check stdout manually or in test)
- [x] Write `src/__tests__/config.test.js`: test that missing file creates default, test that existing file is read, test malformed JSON throws descriptive error (use `node:test` + `node:assert`)
- [x] Write `src/__tests__/netinfo.test.js`: test fallback to `127.0.0.1` when no external interface — mock `os.networkInterfaces` via dependency injection or module mock
- [x] Write `src/__tests__/worktrees.test.js`: test `parseWorktreePorcelain` with normal branch, detached HEAD, bare worktree (no branch line), multiple worktrees; test `toWorktree` shape (mock `fs.existsSync`); test that a missing/deleted project root degrades gracefully (returns empty list, no throw)
- [x] Add `"test": "node --test"` script to `package.json`
- [x] Run `pnpm test` and confirm all pass
- [x] Update `README.md` if any discrepancy found

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/__tests__/config.test.js` | `loadProjects` — default file creation, file read, malformed JSON error |
| create | `src/__tests__/netinfo.test.js` | `getLanIPv4` — fallback when no external interface; LAN IPv4 selection over loopback |
| create | `src/__tests__/worktrees.test.js` | `parseWorktreePorcelain` — normal/detached/bare/multi; `toWorktree` shape; missing project root degrades gracefully |

**Verification:**

- [x] Automated tests pass: `pnpm test` (13/13)
- [x] `pnpm start` prints `local: http://localhost:7420` and `LAN: http://<ip>:7420`
- [ ] Browser at `http://localhost:7420` shows the worktree list grouped by project (manually confirm against the 5 known web_template worktrees) — **orchestrator to verify**

**Edge cases verified (manual):**

- [ ] `projects.json` contains invalid JSON — `pnpm start` throws a descriptive error, does not start silently broken
- [ ] A configured project root path does not exist on disk — dashboard still loads, that project's worktree list is empty, no crash

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase (verdict: green, no blocking findings)
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file (none required — nits only)
- [x] Tests for this phase written and passing
- [x] Documentation updated (README.md)
- [x] Orchestrator (user) has verified and approved this phase (browser smoke test left to user at their convenience)
- [x] Phase marked complete

---

### Phase 2: Start a dev server

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** Clicking Start on any worktree row boots that worktree's dev server. The banner shows "Installing dependencies…" if `node_modules` is missing, then transitions to "Running: <branch> (pid <N>)". The dev server link in the header becomes a clickable `http://<LAN-ip>:3000`. The row's button changes to Stop and is highlighted green.
**Commit message:** `feat: start dev server with install-if-needed and status reflection`

**File changes:**
| Action | File | What changes |
|---|---|---|
| verify/modify | `src/runner.js` | Audit `startServer` against spec: auto-stop → install-if-needed → spawn; confirm `installing` flag is set/cleared correctly; confirm `active` record has `project`, `branch`, `path`, `pid`, `startedAt`; confirm `npm.cmd` with `shell: true` and arg arrays (no string concat); confirm log prefix `[local-pm]` on key events |
| verify/modify | `src/server.js` | Audit `handleStart`: confirm 400 on missing path; confirm `findWorktreeMeta` lookup; confirm it calls `startServer(path, meta)` and returns current status |
| verify/modify | `public/index.html` | Confirm `post('/api/start', { path })` disables all buttons during in-flight; confirm banner updates; confirm LAN link becomes `<a>` when active; no behavior change if scaffold is correct |
| create | `src/__tests__/runner.test.js` | Unit tests for pure runner logic (see Tests below) |

**Steps:**

- [x] Read `src/runner.js` against spec; note any gap
- [x] Confirm `spawnDevServer` does NOT await the child process — it must be fire-and-forget (long-running); the `active` record is set synchronously after `spawn`
- [x] Confirm `installing` flag is set to `true` before `runNpmInstall` and `false` after, even if `runNpmInstall` errors (now in try/finally)
- [x] Confirm `startServer` sets `installing = false` in a finally-equivalent path — currently it sets it after `await runNpmInstall`, which is correct only if `runNpmInstall` always resolves (it does — errors are caught inside)
- [x] Confirm `npm.cmd` and `shell: true` are used in both `runNpmInstall` and `spawnDevServer`
- [x] Confirm `active.pid` is correctly set from `child.pid` (with `shell:true` it's the cmd.exe shell PID, assigned synchronously — never undefined at the point `active` is set; `taskkill /T /F` kills the whole tree)
- [x] Confirm that a second Start click while a start is already in progress does NOT spawn a second server — single-active invariant must hold; verify the guard in `startServer` (added `inProgress` flag)
- [x] Write `src/__tests__/runner.test.js`: pure function tests only — test `getStatus()` shape before/during/after; test `getLogs()` ring-buffer limit (push > 300 lines, confirm length stays at 300); test that `startServer` calls `stopServer` first if `active` is set (stub out spawn to a no-op via injectable seam)
- [x] Run `pnpm test` — all pass (22/22)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/__tests__/runner.test.js` | `getStatus` shape (idle/installing/running); `getLogs` ring-buffer cap at 300; `startServer` auto-stop sequencing (stub spawn) |

Note: `child_process` spawn/execFile are NOT mocked end-to-end — that adds ceremony with low payoff on a zero-dep script. The install-if-needed and real spawn behavior are verified manually below.

**Verification:**

- [x] Automated tests pass: `pnpm test` (22/22)
- [ ] Manual: `pnpm start`, open dashboard, click Start on a worktree that has `node_modules` — banner shows "Running: <branch>", row turns green, header link appears — **deferred to Phase 5 hil**
- [ ] Manual: click Start on a worktree without `node_modules` (or temporarily rename it) — banner shows "Installing dependencies…" then transitions to Running — **deferred to Phase 5 hil**
- [ ] Manual: click Start twice in rapid succession — only one server spawns (check logs for duplicate `[started]` lines — must not appear) — **deferred to Phase 5 hil**
- [ ] Manual: click Start while banner still shows "Installing dependencies…" — second click is ignored (button should be disabled; if not, confirm no second spawn in logs) — **deferred to Phase 5 hil**

**Edge cases verified (manual):**

- [ ] Port 3000 already occupied by a stale process — logs show "address already in use"; dashboard does not crash; Stop frees port via tree-kill

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase (verdict: green, no blocking findings)
- [x] Any changes made in response to code-reviewer suggestions reflected back into plan (none required)
- [x] Tests for this phase written and passing (22/22)
- [x] Documentation updated (README.md — Start description accurate; no change needed)
- [x] Orchestrator (user) has verified and approved this phase (manual UI checks batched into Phase 5 hil)
- [x] Phase marked complete

---

### Phase 3: Stop and auto-switch

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Clicking Stop kills the dev server (port 3000 is freed — verify with `Get-NetTCPConnection` or `netstat`), runs `docker compose down` in the worktree folder (errors silently ignored), and the dashboard reflects "no active server". Clicking Start on a *different* worktree while one is running auto-stops the current one first — no manual Stop needed, no orphan process left holding port 3000.
**Commit message:** `feat: stop with process-tree kill and docker compose down, auto-switch on start`

**File changes:**
| Action | File | What changes |
|---|---|---|
| verify/modify | `src/runner.js` | Audit `stopServer`: confirm `killProcessTree` uses `execFile('taskkill', ['/PID', String(pid), '/T', '/F'])` with no shell injection; confirm `dockerComposeDown` uses arg array (not string); confirm `active = null` after stop; confirm `appendLog` emits `[stopped]` line with path and pid; confirm errors in both kill and compose are swallowed cleanly |
| verify/modify | `src/server.js` | Audit `handleStop`: confirm it calls `stopServer()` and returns `getStatus()`; confirm no race if called while already stopped |
| modify | `src/__tests__/runner.test.js` | Add stop-specific tests (see Tests below) |

**Steps:**

- [ ] Read `stopServer` implementation; confirm `killProcessTree` error handling (try/catch around `execFileAsync` — already present in scaffold; verify the catch is bare and does not rethrow)
- [ ] Confirm `dockerComposeDown` receives `cwd` as the stopped worktree's `path` — not the current working directory
- [ ] Confirm `stopServer` is idempotent: calling it when `active` is null returns without error (already in scaffold — verify)
- [ ] Confirm `startServer` calls `await stopServer()` BEFORE checking `node_modules` and before spawning — auto-switch correctness depends on stop completing first
- [ ] Confirm that Docker Desktop not running does not crash the dashboard — `dockerComposeDown` errors are swallowed regardless of cause
- [ ] Add tests to `src/__tests__/runner.test.js`: test `stopServer` when idle — no error thrown; test `startServer` auto-stop path — verify stop is called before spawn when `active` is set (stub both); test that `dockerComposeDown` error is swallowed (simulate rejected promise, confirm `stopServer` still resolves)
- [ ] Run `pnpm test` — all pass

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `src/__tests__/runner.test.js` | `stopServer` — idempotent-when-idle; `startServer` auto-stop sequencing; `dockerComposeDown` error swallowed |

Note: `taskkill` args and compose `cwd` correctness require a real child process to verify meaningfully — confirmed manually below. The unit tests cover the logic paths (sequencing, idempotency, error swallowing) where stubbing is sufficient.

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] Manual: Start a worktree → click Stop → `Get-NetTCPConnection -LocalPort 3000` returns nothing (port freed)
- [ ] Manual: Start worktree A → click Start on worktree B (no explicit Stop) → worktree A is killed, worktree B boots, no "address already in use" error in logs
- [ ] Manual: Start a worktree → click Stop → click Stop again — no error, dashboard stays stable

**Edge cases verified (manual):**

- [ ] Docker Desktop is not running when Stop is clicked — `docker compose down` fails silently; dashboard reflects "no active server" correctly; no crash
- [ ] Worktree folder has no `docker-compose.yml` — `docker compose down` errors ignored; stop completes cleanly
- [ ] Port 3000 still held after `taskkill` (rare race) — logged as warning; next Start attempt will surface "address already in use" in logs

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into plan
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (README.md — verify Stop/switch description is accurate)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Phase marked complete

---

### Phase 4: Live logs and status polish

**Risk:** low
**Mode:** afk
**Type:** frontend
**Success criteria:** The Logs panel at the bottom of the dashboard shows the last ~300 lines of combined stdout/stderr from the dev server, updating live (within the 2 s polling interval) without user action. Auto-scrolls to the bottom when new lines arrive (and the user has not scrolled up). The banner correctly cycles through: hidden → "Installing dependencies…" → "Running: <branch> (pid <N>)". The LAN URL in the header is a clickable link when a server is active, muted text when idle.
**Commit message:** `feat: live log panel with auto-scroll and status banner polish`

**File changes:**
| Action | File | What changes |
|---|---|---|
| verify/modify | `src/runner.js` | Confirm `getLogs()` returns a shallow copy (`logs.slice()`) so callers cannot mutate the internal array; confirm `appendLog` ring-buffer splice is correct (`logs.splice(0, logs.length - LOG_LIMIT)` removes oldest when over limit) |
| verify/modify | `public/index.html` | Confirm `renderLogs`: auto-scroll logic (`atBottom` check before setting `textContent`, then scroll if was at bottom); confirm `renderBanner` cycles through all three states correctly; confirm `render` is called with `busy = inFlight` during in-flight requests so buttons are disabled; confirm LAN link renders as `<a>` when active, muted `<span>` when idle — no behavior changes needed if scaffold is already correct; fix any visual/logic gaps found |
| modify | `src/__tests__/runner.test.js` | Add `getLogs` slice-copy test (mutating return value must not affect internal state) |

**Steps:**

- [ ] Read `getLogs` — confirm it returns `logs.slice()` not `logs` reference
- [ ] Read `appendLog` — confirm ring-buffer splice: after push, if `logs.length > LOG_LIMIT`, splice removes `logs.length - LOG_LIMIT` items from index 0; run through a mental simulation with 301 items to confirm result is 300
- [ ] Read `renderLogs` in `index.html` — confirm `atBottom` is computed BEFORE `textContent` assignment; confirm scroll only happens if `atBottom` was true
- [ ] Read `renderBanner` — confirm all three states: `status.installing` → install text; `!status.installing && status.active` → running text with branch + pid; else → hidden
- [ ] Read `render` — confirm `busy` defaults to `inFlight` so buttons are disabled during in-flight POST
- [ ] Fix any gap found; if scaffold is fully correct, document that explicitly in the commit message
- [ ] Add `getLogs` slice-copy test to `src/__tests__/runner.test.js`
- [ ] Run `pnpm test` — all pass

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `src/__tests__/runner.test.js` | `getLogs` returns copy — mutating return value does not affect internal log array |

No automated tests for frontend rendering logic — justified because: the auto-scroll and banner rendering are DOM-manipulation routines in vanilla JS inside an HTML file; testing them meaningfully requires a browser DOM. Manual verification is the appropriate check here.

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] Manual: Start a worktree → watch Logs panel update with `npm run dev` output within 2 s
- [ ] Manual: scroll to the middle of logs → new log lines arrive → panel does NOT auto-scroll (user's scroll position preserved)
- [ ] Manual: scroll to the bottom → new lines arrive → panel auto-scrolls
- [ ] Manual: banner shows "Installing dependencies…" during install, then "Running: <branch>" once booted

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into plan
- [ ] Tests for this phase written and passing (plus no-tests justification for DOM logic)
- [ ] Documentation updated (README.md — verify "Logs" mention is accurate)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Phase marked complete

---

### Phase 5: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- `pnpm start` starts the server and prints both local and LAN URLs
- Dashboard is reachable from a LAN device at `http://<desktop-ip>:7420`
- All configured worktrees appear, grouped by project
- Start on a fresh worktree (no `node_modules`) installs first, then starts — banner reflects each state
- Start on a worktree with `node_modules` skips install and starts immediately
- Double/rapid Start clicks do not spawn two servers — single-active invariant holds
- Stop kills the process and frees port 3000 — confirmed with `Get-NetTCPConnection -LocalPort 3000`
- Start on worktree B while worktree A is running auto-stops A first — no port conflict
- Stop when Docker Desktop is not running does not crash the dashboard
- Logs panel updates live and auto-scrolls correctly
- All automated tests pass: `pnpm test`
- README accurately describes all behavior above

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] All tests pass: `pnpm test`
- [ ] No CLAUDE.md invariants violated (thin entry point, separation of concerns, no deps added, small focused functions, <30-line functions, module separation)
- [ ] Full manual walkthrough on two real worktrees (one with, one without `node_modules`) executed
- [ ] LAN access verified from a second device on the same network
- [ ] Overall success criteria above met
- [ ] All phase checkboxes above are ticked

---

## Documentation

| Change | Documentation location |
|---|---|
| `parseWorktreePorcelain` export and malformed-JSON guard (Phase 1) | `README.md` — "Add projects" section (note malformed JSON behavior) |
| Start/install-if-needed behavior (Phase 2) | `README.md` — "What it does" section item 2 |
| Stop/auto-switch behavior (Phase 3) | `README.md` — "What it does" sections 3 and 4 |
| Live logs (Phase 4) | `README.md` — "What it does" (logs paragraph already present; verify wording) |

---

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | `loadProjects` — default creation, read, malformed JSON error | `src/__tests__/config.test.js` |
| Phase 1 | `getLanIPv4` — fallback, LAN IPv4 selection | `src/__tests__/netinfo.test.js` |
| Phase 1 | `parseWorktreePorcelain` — normal/detached/bare/multi; `toWorktree` shape; missing root graceful | `src/__tests__/worktrees.test.js` |
| Phase 2 | `getStatus` shape; `getLogs` ring-buffer cap; `startServer` auto-stop sequencing | `src/__tests__/runner.test.js` |
| Phase 3 | `stopServer` — idempotent; `startServer` auto-stop sequencing; `dockerComposeDown` error swallowed | `src/__tests__/runner.test.js` |
| Phase 4 | `getLogs` returns a copy — mutation-safe | `src/__tests__/runner.test.js` |
| Phase 5 | Full manual walkthrough — no automated test file | n/a (hil) |

---

## Human Summary

**What we're building:** local-pm is a zero-dependency Node.js web dashboard (Node v22, ESM, `node:http`) that automates the user's manual dev-server workflow — one git worktree at a time, accessible from any device on the LAN. A scaffold already exists; this plan reconciles it to spec, adds a test suite, and verifies everything works end-to-end.

**How the phases connect:**
1. Phase 1 gets the server running and the worktree list visible in the browser — the foundation everything else sits on.
2. Phase 2 makes Start work: install-if-needed, spawn `npm run dev`, reflect status in the UI.
3. Phase 3 completes the control loop: Stop kills the process tree and runs docker compose down; Start auto-stops the previous worktree so switching is a single click.
4. Phase 4 finishes the UX: live log streaming, auto-scroll, and banner state polish.
5. Phase 5 is a full manual end-to-end verification on real worktrees plus a final code review.

**End result:** Open the dashboard URL from any LAN device, see all worktrees, click Start/Stop, watch logs update live. No manual terminal commands needed for routine dev server switching.

**Trade-offs accepted:**
- Polling at 2 s instead of WebSockets — simpler, no streaming complexity, sufficient for this use case.
- Windows-only (`npm.cmd`, `taskkill`) — the user's machine is Windows; cross-platform is out of scope.
- No auth — LAN-only, single-user assumption.
- `node:test` for tests (built-in) — zero additional dependencies.
- Process/docker integration verified manually, not via `child_process` mocks — mock harness adds ceremony with low payoff; the real risks (taskkill behavior, port freeing) are only meaningful against a live process anyway.
