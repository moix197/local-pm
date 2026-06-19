# Plan: Interactive Terminals

**Created:** 2026-06-19
**Branch:** `feat/interactive-terminals`
**Status:** not started

## Context

local-pm is a LAN dashboard (plain Node ESM, no build step, `node:http`) that manages dev servers across git worktrees. PRD 1 (multi-project-concurrent-servers) adds per-worktree server rows with a lazy-polled log console and leaves a documented seam: _"PRD 2: replace poll with WebSocket stream"_. This plan is PRD 2.

The goal: add fully interactive terminals — not just log tails — to each worktree panel, so the user can type commands, run `claude`, and see live PTY output rendered by xterm.js, all from the browser. Sessions outlive their WebSocket connection (detach/reattach with scrollback). Multiple tabbed terminals per worktree are supported. A one-click "Claude" quick-action opens a terminal already running `claude` in that worktree.

**Dependency:** PRD 1 must be complete before this plan begins. The worktree validation, path-scoping, per-worktree panel layout, and test-seam pattern (injectable `_setSpawnFn`) introduced in PRD 1 are all prerequisites and are reused here.

## Risk: high

Interactive PTY over WebSocket is the most RCE-sensitive surface in the project. node-pty is a native addon (N-API); the Windows prebuild may not match the local Node ABI, requiring a compiler fallback. xterm.js vendoring introduces static-serving code. The WebSocket upgrade path bypasses the existing HTTP `isAuthorized` gate and needs its own auth. Scrollback + idle reaper add stateful lifecycle logic. All of these are new territory for this codebase.

## Dependencies & Risks

- **PRD 1 must be complete.** This plan reuses PRD 1's worktree validation, path-scoping in `getWorktrees()`, per-worktree panel structure, and the injectable-spawn test pattern. Do not start this plan until PRD 1's Final Verification is ticked.
- **node-pty prebuild vs compile risk (P0).** node-pty 1.1.0 ships a prebuilt win32-x64 N-API binary. If the ABI doesn't match the local Node version, `pnpm add node-pty` silently falls back to `node-gyp`, which requires Python + VS Build Tools with Spectre-mitigated C++ libraries. P0 is `Mode: hil` specifically because a human must confirm the install succeeded without a compile, and must document the fallback path if it did not. If node-gyp runs, add the prerequisite toolchain to the README.
- **SECURITY — terminal = unrestricted shell.** A PTY spawned at a worktree cwd with the user's `PATH` can do anything. Mitigations baked into every phase: auth rejected **before** WS handshake (401 + `socket.destroy()`, before `wss.handleUpgrade` — no pty is ever spawned for an unauthorized request); token compared with `crypto.timingSafeEqual` (reuse `token.js`'s `readToken`/length-guard pattern); Origin allowlist check; pty cwd fixed to a validated registered-worktree path (reuse PRD 1's `getWorktrees()` lookup — never accept an arbitrary client path); `kind` maps to a fixed command table (`shell`|`claude`) — never an arbitrary command string from the client; env is explicit (`{...process.env, TERM:'xterm-color'}`); max concurrent sessions cap enforced at spawn time; idle reaper kills abandoned ptys; inbound `maxPayload` cap + backpressure guard on WS send; session ids are crypto-random and reattach re-checks auth.
- **SECURITY — `?token=` query-string leakage (accepted for local-only).** A token in the WS URL query can leak via access logs, browser history, and `Referer` headers. This is **accepted** for the current LAN-only deployment, with two cheap mitigations applied now: (1) never log full request URLs in `ws.js`/`server.js` upgrade handling — log path + outcome only, never the query string; (2) the server already binds to the LAN interface (PRD 1) — do not bind to `0.0.0.0`/public. The real fix (short-lived one-time `?ticket=`) is the named ROADMAP follow-up and is a single-function change in `authorizeUpgrade`.
- **SECURITY — CSWSH (cross-site WebSocket hijacking).** Browsers do not apply same-origin policy to WS handshakes, so any web page the user visits could open a WS to this server. The `?token=` requirement blocks unauthenticated origins, but the Origin allowlist is kept as defence-in-depth (and is mandatory once cookie/ticket auth lands). Allowlist source: `http://localhost[:port]`, `http://127.0.0.1[:port]`, and `http://<LAN-IPv4>[:port]` where the LAN IP comes from PRD 1's `getLanIPv4()`; the listening port comes from the server config. A `null`/absent Origin (non-browser client, e.g. test harness) is allowed; any other present Origin is rejected.
- **Windows shell selection.** `pwsh.exe` is the preferred shell (ConPTY-aware, Unicode-clean). Falls back to `cmd.exe` if `pwsh.exe` is absent. Shell is auto-detected at startup and stored as a module-level constant in `pty.js`; configurable via `LOCAL_PM_SHELL` env var. ConPTY is used by default on Win11 via node-pty — no `useConpty` override needed.
- **No build step — xterm UMD only.** `@xterm/xterm` 6.x and `@xterm/addon-fit` expose UMD bundles. These must be downloaded and committed to `public/vendor/` (not fetched from CDN at runtime). P0 covers the download + commit. Loading is via `<script src="/vendor/xterm.js">` and `<link href="/vendor/xterm.css">` — no bundler, no npm build.
- **Static serving new path.** Today only `/` serves `index.html`. P0 adds a `/vendor/` route. It must be path-traversal-safe (validate the resolved path stays inside `public/vendor/`).
- **Ticket-based WS auth + WSS hardening are OUT OF SCOPE.** The current `?token=` query approach is suitable for local-only use. When remote access via Cloudflare Tunnel is enabled, replace with: (a) authed HTTP `POST /api/terminal/ticket` issues a short-lived one-time ticket, (b) WS connects with `?ticket=` instead. This is a small localized change in `ws.js` + `token.js`. Explicitly tracked as a follow-up in the ROADMAP.
- **Phase ordering is strict.** P1 requires P0's vendored files and installed deps. P2 requires P1's session Map and WS infrastructure. P3 requires P2's reattach mechanism.

## Phases

### Phase 0: Infrastructure prerequisites

**Branch note:** local-pm is a solo repo developed directly on `main` (see PRD 1) — no worktree/feature-branch flow. Work on `main` unless the user asks for a branch; if they do, `git checkout -b feat/interactive-terminals` is a one-liner before starting. This is NOT a phase step.

**Risk:** medium
**Mode:** hil
**Type:** config
**Success criteria:** `GET /vendor/xterm.js`, `GET /vendor/xterm.css`, and `GET /vendor/addon-fit.js` each return 200 with the correct `Content-Type`; `import pty from 'node-pty'` and `import { WebSocketServer } from 'ws'` both resolve without error in a smoke-test script run locally.
**Commit message:** `chore: add node-pty + ws deps, vendor xterm UMD, add /vendor/ static route`

**Justification for runtime dependencies (CLAUDE.md exception):**

CLAUDE.md directs "build our own before installing." This plan adds three external packages as a sanctioned exception:

- **node-pty** — A POSIX/Win32 PTY requires native OS APIs (`CreatePseudoConsole` on Windows, `forkpty` on POSIX). Implementing this in pure JS is not feasible; the complexity is deep in the OS ABI. node-pty is the canonical N-API wrapper.
- **ws** — Implementing a spec-compliant WebSocket server (RFC 6455 handshake, masking, fragmentation, ping/pong) from scratch is impractical for a maintenance-burdened LAN tool. `ws` is minimal (no transitive deps), widely audited, and the standard choice for attaching WS to an existing `node:http` server.
- **xterm.js** — A browser PTY renderer (VT100/VT220 emulation, ANSI escape sequences, Unicode, selection, accessibility) is a substantial front-end component. Vendored as a UMD bundle into `public/vendor/` so there is zero build step — no bundler, no CDN dependency.

These are the only new runtime dependencies this plan adds.

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `package.json` | Add `"node-pty": "^1.1.0"` and `"ws": "^8.0.0"` to `dependencies` |
| create | `public/vendor/xterm.js` | Vendored UMD bundle for `@xterm/xterm` 6.x (global `window.Terminal`) |
| create | `public/vendor/xterm.css` | Vendored CSS for `@xterm/xterm` 6.x |
| create | `public/vendor/addon-fit.js` | Vendored UMD bundle for `@xterm/addon-fit` 0.11.x (global `window.FitAddon`) |
| modify | `src/server.js` | Add `/vendor/` static route: resolve path, assert it stays inside `public/vendor/` (traversal guard), infer `Content-Type` from extension (`.js` → `application/javascript`, `.css` → `text/css`), stream file; keep route handler thin |

**Steps:**

- [ ] Run `pnpm add node-pty@^1.1.0 ws@^8.0.0` and observe install output — confirm prebuild binary fetched (look for "prebuild-install" success line); if `node-gyp` ran instead, document the required toolchain (Python 3, VS Build Tools with Spectre libs) in README under a "Prerequisites" section
- [ ] Write a one-off smoke script `scripts/check-deps.mjs`: `import pty from 'node-pty'; import { WebSocketServer } from 'ws'; console.log('ok', typeof pty.spawn, typeof WebSocketServer);` — run it with `node scripts/check-deps.mjs`; confirm output is `ok function function`; delete the script after confirmation
- [ ] Download `@xterm/xterm@6` UMD files: `node_modules/@xterm/xterm/lib/xterm.js` and `node_modules/@xterm/xterm/css/xterm.css` → copy to `public/vendor/`
- [ ] Download `@xterm/addon-fit@0.11` UMD file: `node_modules/@xterm/addon-fit/lib/addon-fit.js` → copy to `public/vendor/addon-fit.js`
- [ ] Add `/vendor/` static route to `src/server.js`: resolve `url.pathname` relative to `public/`, normalize, assert resolved path starts with the `public/vendor/` absolute prefix (traversal guard — reject with 403 if not), read file, set `Content-Type`, stream; handle ENOENT → 404
- [ ] Human verifies: `curl http://localhost:7420/vendor/xterm.js` returns 200 with `Content-Type: application/javascript`; same for `xterm.css` and `addon-fit.js`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `src/__tests__/server.test.js` | GET /vendor/xterm.js → 200 application/javascript; GET /vendor/xterm.css → 200 text/css; GET /vendor/addon-fit.js → 200 application/javascript; GET /vendor/../token.local → 403 (traversal guard) |

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] `node scripts/check-deps.mjs` outputs `ok function function` (run before deleting)
- [ ] Manual curl: each vendor file returns 200 with correct Content-Type
- [ ] Traversal attempt (`/vendor/../token.local`) returns 403

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `chore: add node-pty + ws deps, vendor xterm UMD, add /vendor/ static route`
- [ ] Phase marked complete

---

### Phase 1: One live terminal end-to-end

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** From a worktree panel, click "Open terminal"; an xterm.js terminal renders in the browser; type a shell command (e.g. `echo hello`); see the output live; resize the browser window and confirm the PTY reflows; close the tab and confirm no errors.
**Commit message:** `feat: live PTY terminal — pty.js + ws.js + xterm UI wired end-to-end`

**This phase introduces the core PTY + WebSocket + xterm stack. All subsequent phases build on it.**

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `src/pty.js` | Session Map (`Map<sessionId, PtySession>`); `spawnSession({worktreePath, kind, cols, rows})` — validates path against `getWorktrees()`, enforces max concurrent cap (`MAX_SESSIONS = 10`), spawns PTY via `pty.spawn(shell, [], {cwd, cols, rows, name:'xterm-color', env:{...process.env,TERM:'xterm-color'}})`; `writeToSession(id, data)`; `resizeSession(id, cols, rows)`; `killSession(id)`; `getSession(id)`; injectable `_setSpawnFn(fn)` seam for tests |
| create | `src/ws.js` | `attachWebSocket(server)` — creates `WebSocketServer({noServer:true, maxPayload: 1<<20})` (1 MB inbound frame cap so a client cannot flood `pty.write`); registers `server.on('upgrade', ...)` handler that calls `authorizeUpgrade(req)` **before `wss.handleUpgrade`** — on failure: `socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy()` and return immediately (no `handleUpgrade`, no pty); only on success call `wss.handleUpgrade(...)` then parse `sessionId` + `worktreePath` + `kind` + `cols` + `rows` from URL query; call `spawnSession` (or reuse existing — P2 extends this); wire `pty.onData → ws.send` (with `ws.readyState === OPEN` and `ws.bufferedAmount < HIGH_WATER` guard); wire `ws.on('message')` → defensively parse resize JSON or write string to PTY; on `ws.close` → in P1 `killSession` (P2 will change this to detach). Logging: never log the full request URL/query (token leakage) — log `pathname` + outcome only |
| modify | `src/server.js` | Import and call `attachWebSocket(server)` after `server` is defined; no other changes to server.js — keeps it thin |
| modify | `public/index.html` | Add `<link href="/vendor/xterm.css">` and `<script src="/vendor/xterm.js">` + `<script src="/vendor/addon-fit.js">`; add "Open terminal" button to each worktree row; `openTerminal(worktreePath)` function: creates a `<div class="terminal-pane">`, instantiates `new Terminal()`, loads `new FitAddon.FitAddon()`, calls `open(el)`, `fit()`; opens `WebSocket` to `ws://host/ws/terminal?token=<token>&worktreePath=<path>&kind=shell&cols=<cols>&rows=<rows>`; wires `terminal.onData(d => ws.send(d))`; wires `ws.onmessage(e => terminal.write(e.data))`; `ResizeObserver` on the pane → `terminal.resize` → `ws.send(JSON.stringify({resize:{cols,rows}}))` (cols/rows clamped client-side to `[1,500]` before send); backpressure: skip stdin send if `ws.bufferedAmount > HIGH_WATER` (client mirrors the server's 1 MB threshold) |
| create | `src/__tests__/pty.test.js` | Unit tests for `pty.js` using injectable spawn seam |
| create | `src/__tests__/ws.test.js` | Unit tests for `ws.js` WS auth/upgrade logic using injectable seams |

**`authorizeUpgrade(req)` spec** (implemented inside `ws.js`, NOT inside `token.js` — keeps token.js unchanged). **Called before `wss.handleUpgrade`; on `!ok` the upgrade is rejected and no PTY is ever spawned:**
- Parse `?token=` from `req.url` (via `new URL(req.url, 'http://x')` — never log this string)
- Read expected token via `readToken()` from `token.js`
- Compare with `crypto.timingSafeEqual` (length-guard FIRST — `timingSafeEqual` throws on length mismatch — same pattern as `isAuthorized`). Missing/empty token → `ok:false` without calling `timingSafeEqual`
- Origin allowlist: `req.headers.origin` is `undefined`/`null` (non-browser client) → allowed; OR exactly matches one of the computed allowed origins (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://<getLanIPv4()>:<port>`) → allowed; any other present Origin → `ok:false` (anti-CSWSH). Build the allowlist from `getLanIPv4()` + the configured listen port; use prefix-tolerant matching only if PRD 1's `isAuthorized` does
- Return `{ok: boolean, reason?: string}` — `reason` used for the close code / log line, never echoed with the token
- Design note: swapping `?token=` for a short-lived one-time `?ticket=` later requires changing ONLY this function (read `?ticket=`, look it up in a consumed-once Map populated by `POST /api/terminal/ticket`). Nothing else in `ws.js`/`pty.js` changes.

**`spawnSession` security invariants (enforced before any `pty.spawn`):**
1. `worktreePath` must resolve to an entry returned by PRD 1's `getWorktrees()` — compare normalized/resolved absolute paths, reject with descriptive error if not present. The client-supplied path is NEVER passed to `pty.spawn` directly; the cwd used is the validated path from the registry lookup. This blocks traversal/arbitrary-cwd.
2. `kind` must be a key in a fixed `COMMANDS` table (`{ shell: <no args>, claude: <claude subcommand args> }`) defined in `pty.js` — reject anything else. There is NO code path that takes a command string from the client; `kind` selects from this fixed table only.
3. Active session count must be `< MAX_SESSIONS` — reject with descriptive error if at cap (WS layer closes with code `4429`, "session cap reached"; see Resource limits below)
4. `cols` and `rows` must be finite positive integers — reject `NaN`/non-numeric, clamp to `[1, 500]`

**Constants (module-level in `ws.js`/`pty.js`):** `MAX_SESSIONS = 10`; `maxPayload = 1 MB`; `HIGH_WATER = 1<<20` (1 MB `bufferedAmount` threshold — on a detached/slow client, drop live sends rather than buffer unboundedly; scrollback still records so reattach replays).

**WS close codes (4xxx app range):** `4401` auth failed (also sent as raw 401 pre-handshake), `4403` invalid path / bad kind / disallowed origin, `4429` session cap reached, `4400` malformed frame on a frame that should terminate. Document these in the README.

**Steps:**

- [ ] Create `src/pty.js`: define `MAX_SESSIONS = 10`; define shell detection (`process.env.LOCAL_PM_SHELL` → `pwsh.exe` exists check → `cmd.exe` fallback); implement `spawnSession({worktreePath, kind, cols, rows})` with the four security invariants above; for `kind='claude'` spawn `pty.spawn(shell, ['-c', 'claude'], ...)` on pwsh (or `['/c', 'claude']` on cmd); for `kind='shell'` spawn with no args; expose `writeToSession`, `resizeSession`, `killSession`, `getSession`, `getAllSessions`; export `_setSpawnFn` seam
- [ ] Create `src/ws.js`: implement `authorizeUpgrade(req)` with `timingSafeEqual` `?token=` auth + Origin allowlist; implement `attachWebSocket(server)` with `noServer:true` + `maxPayload:1MB`; **call `authorizeUpgrade` and on failure `socket.write('HTTP/1.1 401 …'); socket.destroy(); return` BEFORE `wss.handleUpgrade`**; parse query params from upgrade URL (never log it); call `spawnSession`; wire data/resize/close; guard sends with `ws.readyState === OPEN` and `ws.bufferedAmount < HIGH_WATER`
- [ ] In the `ws.on('message')` handler: treat binary/utf8 as PTY stdin write; only attempt JSON parse for control frames and wrap it in try/catch — a malformed `{resize}` frame must be ignored (log + continue), never throw out of the handler; validate `resize.cols`/`resize.rows` are finite integers in `[1,500]` before calling `resizeSession`, else ignore the frame
- [ ] Modify `src/server.js`: add one line `attachWebSocket(server)` after the server is created (before the listen block); add `import { attachWebSocket } from './ws.js'`
- [ ] Modify `public/index.html`: add vendor script/link tags in `<head>`; add "Open terminal" button per worktree row; implement `openTerminal(worktreePath)` as described; token is already available on the page (PRD 1 stores it in a `<meta>` or JS variable — match that pattern); WS URL uses the page's current `location.host`
- [ ] Create `src/__tests__/pty.test.js`: use `_setSpawnFn` to inject a fake spawn; test: unknown worktreePath rejected; kind='evil' rejected; cap enforced at `MAX_SESSIONS`; cols/rows clamped; `kind='shell'` spawns with correct args; `kind='claude'` spawns with `claude` subcommand; `writeToSession` / `resizeSession` / `killSession` delegate to the fake process
- [ ] Create `src/__tests__/ws.test.js`: test `authorizeUpgrade`: missing/empty token → not ok (and `timingSafeEqual` NOT reached); wrong-length token → not ok without throwing; correct token + allowed origin → ok; correct token + disallowed origin → not ok (CSWSH); absent/`null` origin → ok. Test the upgrade handler with a fake socket: unauthorized request → `socket.destroy` called and `wss.handleUpgrade` NEVER called (assert no spawn). Path-traversal/unknown path in query → close code `4403`; bad `kind` → `4403`; at-cap spawn → close code `4429`. Malformed `{resize}` JSON frame → handler does not throw, session unaffected. Use injectable seams for `readToken`, `getWorktrees`, and spawn so no real pty/socket is created
- [ ] Update README: add "Interactive terminals" section describing the WS endpoint, auth model, and `LOCAL_PM_SHELL` env var

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/__tests__/pty.test.js` | spawnSession security invariants (unknown path, bad kind, cap, clamp); shell vs claude spawn args; write/resize/kill delegation via injectable seam |
| create | `src/__tests__/ws.test.js` | authorizeUpgrade: token auth (missing/wrong/correct); Origin check (allowed/disallowed); upgrade rejection calls socket.destroy |
| modify | `src/__tests__/server.test.js` | Confirm attachWebSocket is called (spy on import); no regression on existing HTTP routes |

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] Manually open dashboard; click "Open terminal" on a worktree; confirm xterm renders and shell prompt appears
- [ ] Type `echo hello` → confirm output visible in terminal
- [ ] Resize browser pane → confirm PTY reflows (no line-wrap artifacts)
- [ ] Open browser devtools → confirm WS connection established on `ws://localhost:7420/ws/terminal?...`
- [ ] Attempt WS connection with wrong token → confirm connection rejected (401 response before handshake)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: live PTY terminal — pty.js + ws.js + xterm UI wired end-to-end`
- [ ] Phase marked complete

---

### Phase 2: Detach / reattach + scrollback + idle reaper

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Start a process that produces continuous output (e.g. `ping localhost -t`); close the terminal tab; wait 5 seconds; reopen the terminal for the same session; confirm the process is still running and scrollback history is replayed into the new xterm; wait idle-timeout minutes with no client attached; confirm the session is reaped (process killed, session removed from Map).
**Commit message:** `feat: terminal detach/reattach — scrollback ring buffer + idle reaper`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `src/pty.js` | Add per-session `scrollback: string[]` ring buffer (cap: 5000 lines OR ~500 KB bytes — whichever limit is hit first); each `pty.onData` chunk appended to the ring (split on `\n`, discard oldest when cap exceeded); `attachClient(id, ws)` replays `scrollback` to the new WS then wires live data; `detachClient(id)` removes the WS reference but keeps pty alive and continues buffering; `spawnSession` no longer kills on WS close — `ws.js` calls `detachClient` instead; add `idleAt: Date` per session updated on each detachClient; add idle reaper: `setInterval` every 60 s, kills sessions where `!session.ws && Date.now() - session.idleAt > IDLE_TIMEOUT_MS`; `IDLE_TIMEOUT_MS` defaults to `30 * 60 * 1000` (30 min), overridable via `LOCAL_PM_IDLE_TIMEOUT_MINUTES` env var; export `_setTimerFn` seam for tests |
| modify | `src/ws.js` | On upgrade: if a session with the requested `sessionId` already exists in the session Map, call `attachClient(id, ws)` (reattach path); if not, call `spawnSession` then `attachClient` (new session path); on `ws.close`, call `detachClient(id)` instead of `killSession` |
| modify | `src/__tests__/pty.test.js` | Add: detachClient keeps pty alive; attachClient replays scrollback to new ws; scrollback cap enforced (drop oldest); idle reaper kills session after timeout using injectable timer seam (`_setTimerFn`) |

**Scrollback ring buffer spec:**
- Stored as `string[]` where each element is a raw PTY data chunk (not line-split — preserves ANSI escape sequences)
- Byte cap: sum of `chunk.length` across all stored chunks ≤ 512 000 bytes; on each append evict from front until under cap
- Line cap as secondary soft limit: if chunk count exceeds 5000, evict from front
- On reattach, replay chunks in order by calling `ws.send(chunk)` for each before wiring live data
- Rationale: chunked replay preserves the terminal's stateful escape sequence context better than line-splitting

**Backpressure / output-rate (DoS) spec:**
- Live `pty.onData → ws.send` is guarded by `ws.bufferedAmount < HIGH_WATER` (1 MB). When over the watermark, skip the live send (the chunk is still appended to scrollback, so a slow client catches up on reattach replay) — this prevents a slow/stalled client from forcing unbounded `ws` send-buffer growth and OOMing the server.
- The scrollback byte cap (512 KB) bounds per-session memory regardless of how fast the pty produces output, so a runaway process (e.g. `yes`) cannot grow memory without bound.
- Inbound is bounded by `ws` `maxPayload` (1 MB) so a single frame can't flood `pty.write`; combined with the byte cap this bounds both directions.
- A per-session output-throttle (coalescing rapid `pty.onData` chunks before send) is noted as a possible later optimization but NOT built now — the backpressure guard + byte cap are sufficient for local use.

**Idle reaper spec:**
- `setInterval` polls every 60 seconds
- A session is idle when: `session.ws === null` (no client attached)
- Kill threshold: `Date.now() - session.idleAt > IDLE_TIMEOUT_MS`
- On kill: call `killSession(id)` (shared teardown — see below), delete session from Map, log `[pty] reaped idle session <id>`
- Injectable seam: `_setTimerFn(fn)` replaces `setInterval` so tests can advance time without real timers

**Process teardown spec (Windows caveat — applies to reaper kill, server shutdown, and any future eviction):**
- `killSession(id)` is the single teardown path: `session.ptyProcess.kill()` then delete from Map.
- **Windows caveat:** `node-pty` on Windows uses ConPTY; `ptyProcess.kill()` terminates the shell, but grandchild processes (e.g. a `claude` process or anything it spawned) may not be reliably reaped — orphaned ConPTY/child processes can linger. The plan must verify actual teardown, not assume it.
- Add a `shutdown()` export that kills all sessions and clears the reaper interval; wire it to `process.on('SIGINT'/'SIGTERM')` and to server close so the process does not exit leaving orphaned ptys.
- Verification (manual, P2): start a `kind:'shell'` session, note the shell + any child PID via Task Manager / `Get-Process`; trigger the reaper (short idle timeout); confirm the shell process is gone. Repeat for `kind:'claude'`. If grandchildren linger, document the limitation in the README and note `taskkill /T /F /PID` (tree kill) as the remediation to evaluate in the remote-hardening follow-up.

**Steps:**

- [ ] Add `scrollback`, `ws` (nullable), and `idleAt` fields to each session entry in `src/pty.js`
- [ ] Update `pty.onData` handler to append to scrollback ring (enforce byte cap + chunk-count cap, evict from front)
- [ ] Implement `attachClient(id, ws)`: replay scrollback chunks to ws, set `session.ws = ws`, wire live data pipe
- [ ] Implement `detachClient(id)`: set `session.ws = null`, set `session.idleAt = new Date()`; do NOT kill pty
- [ ] Implement idle reaper `setInterval` (use `_setTimerFn` seam); call `killSession` (shared teardown) on sessions past threshold; add `_setTimerFn` export; add `shutdown()` (kill all sessions + clear interval) and wire `process.on('SIGINT'/'SIGTERM')` to it
- [ ] Update `src/ws.js` upgrade handler: check if `sessionId` already in Map → reattach path vs new-spawn path; on `ws.close` call `detachClient` instead of `killSession`
- [ ] Update `src/__tests__/pty.test.js` with detach/reattach/scrollback/reaper tests; use `_setSpawnFn` + `_setTimerFn` seams; assert pty NOT killed on detach; assert scrollback replayed on reattach; assert cap eviction; assert reaper fires after mock-timeout
- [ ] No frontend changes needed in this phase (the WS reconnect flow already works with the new reattach path — the browser just opens a new WS with the same `sessionId`)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `src/__tests__/pty.test.js` | detachClient: pty alive, ws=null, idleAt set; attachClient: scrollback replayed in order; scrollback byte cap: evicts oldest chunks; scrollback chunk cap: evicts oldest; backpressure: when fake ws `bufferedAmount > HIGH_WATER`, live send skipped but scrollback still appended; idle reaper: kills session after IDLE_TIMEOUT_MS via `killSession` (mock timer); reaper does NOT kill session with active client; `shutdown()` kills all sessions and clears the reaper interval |

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] Manually: start `ping localhost -t` in terminal; close tab; reopen with same sessionId; confirm process still running + history in scrollback
- [ ] Manually: leave a terminal detached for the configured idle timeout (or temporarily set `LOCAL_PM_IDLE_TIMEOUT_MINUTES=1`); confirm session disappears from any Map introspection (add a `GET /api/terminal/sessions` debug route — gated behind `isAuthorized` and a dev flag — for this verification only; do not expose it in the default build)
- [ ] Manually (Windows teardown): record the shell PID before reaping; after the reaper fires, confirm via `Get-Process` the shell process is terminated; repeat with a `claude` session and check for lingering grandchildren — document any in README per the teardown spec
- [ ] Manually: send SIGINT (Ctrl-C) to the server with a live session; confirm `shutdown()` kills the pty (no orphaned process)
- [ ] Confirm: no memory growth when many chunks produced while detached (byte cap enforced)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: terminal detach/reattach — scrollback ring buffer + idle reaper`
- [ ] Phase marked complete

---

### Phase 3: Multiple tabbed terminals per worktree + Claude quick-action

**Risk:** low
**Mode:** afk
**Type:** mixed
**Success criteria:** In a single worktree panel, open a "Shell" terminal tab and a "Claude" terminal tab concurrently; both run independently; switching tabs reattaches to the correct session without losing output; clicking the "Claude" quick-action opens a terminal already running `claude` in that worktree.
**Commit message:** `feat: multi-tab terminals per worktree + Claude quick-action`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `public/index.html` | Replace single "Open terminal" button with a terminal-tabs bar per worktree panel: "＋ Shell" button and "＋ Claude" button (quick-action); `openTerminal(worktreePath, kind)` now generates a `sessionId = crypto.randomUUID()` per new tab; tab bar renders one tab per open session for that worktree (label: `Shell #N` or `Claude #N`); switching tabs calls `attachClient` on the existing WS or reopens WS if disconnected; closing a tab disconnects WS (session kept alive per P2 detach semantics); per-worktree `sessions: Map<sessionId, {ws, terminal, kind}>` managed in frontend JS |
| modify | `src/__tests__/pty.test.js` | Add: two sessions for same worktreePath coexist independently; `killSession` for one does not affect the other |

**Session ID generation + reattach auth:** `crypto.randomUUID()` (browser + Node 19+) — cryptographically random, unguessable. The sessionId is the Map key.
- **Reattach is always re-authed.** Every WS upgrade (new OR reattach) runs `authorizeUpgrade` first; there is no reattach path that skips auth. Knowing a `worktreePath` is NOT sufficient to attach — the Map is keyed by the random `sessionId`, not by path, so an attacker who knows only a path cannot enumerate or attach to a session.
- **Threat model note (single shared token):** local-pm uses one dashboard token for one user, so all authorized clients are the same principal — there is no cross-*user* hijack to defend against here. The unguessable sessionId defends against the case where the token later becomes per-scope (ticket-auth follow-up): when tickets land, `attachClient` should additionally verify the reattaching ticket was issued for that session. Recorded as part of the ROADMAP follow-up.
- Server treats a client-supplied sessionId that is NOT already in the Map as a new-spawn request (subject to all `spawnSession` invariants); it never trusts the value for anything but Map lookup. Collision is astronomically unlikely; no handling needed.

**Steps:**

- [ ] Update `public/index.html`: add `sessions` Map per worktree panel in JS; update `openTerminal(worktreePath, kind)` to generate a `sessionId`, create a tab element, add to tabs bar; implement tab-switch handler that shows/hides terminal panes and reconnects WS if needed; add "＋ Shell" and "＋ Claude" buttons to each worktree row; "＋ Claude" calls `openTerminal(path, 'claude')`
- [ ] Add multi-session coexistence test to `src/__tests__/pty.test.js`: spawn two sessions on the same worktreePath; assert both in Map; kill one; assert the other unaffected
- [ ] Update README: document multi-tab UI and Claude quick-action

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `src/__tests__/pty.test.js` | Two sessions same worktreePath: both in Map; killSession(id1) leaves id2 intact |

**Verification:**

- [ ] Automated tests pass: `pnpm test`
- [ ] Manually: open "＋ Shell" tab in worktree A; open "＋ Claude" tab in same worktree; both terminals active and independent
- [ ] Switch between tabs: each reconnects to its session with scrollback intact
- [ ] Close Shell tab: Claude tab unaffected, shell session still reachable by reopening

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: multi-tab terminals per worktree + Claude quick-action`
- [ ] Phase marked complete

---

### Phase 4: Documentation

**Risk:** low
**Mode:** hil
**Type:** docs
**Success criteria:** README accurately describes interactive terminals, the WS auth model, `LOCAL_PM_SHELL` and `LOCAL_PM_IDLE_TIMEOUT_MINUTES` env vars, the vendored xterm.js approach, and the node-pty/ws dependency justification; ROADMAP marks Stage D (interactive terminals) complete and lists the ticket-auth + WSS hardening follow-up as the next planned stage; user has reviewed and approved both documents.
**Commit message:** `docs: document interactive terminals, WS auth, env vars, dep justification, roadmap`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `README.md` | Add "Interactive terminals" section: describes terminal tabs, Claude quick-action, detach/reattach semantics, scrollback cap; documents `LOCAL_PM_SHELL` (default: auto-detect pwsh/cmd) and `LOCAL_PM_IDLE_TIMEOUT_MINUTES` (default: 30); documents WS auth model (`?token=` + Origin allowlist) AND the explicit security posture: query-token leakage accepted for LAN-only, LAN-bind requirement, no URL logging; documents the WS close-code table (4401/4403/4429/4400); documents the Windows ConPTY teardown caveat (lingering grandchildren, if observed in P2); documents vendored xterm.js (no CDN, no build); documents node-pty + ws as the two runtime deps and why; adds "node-gyp fallback" note (only if P0 confirmed compile was required) |
| modify | `ROADMAP.md` | Mark Stage D (interactive terminals) complete; add follow-up entry: "Remote access hardening — short-lived ticket-based WS auth + WSS (Cloudflare Tunnel)" with a note that `authorizeUpgrade` in `ws.js` is the only function that needs to change |

**Steps:**

- [ ] Update README.md as described
- [ ] Update ROADMAP.md as described
- [ ] User reviews and approves both documents

**Tests:**

No automated tests — justified because: pure documentation change with no executable logic.

**Verification:**

- [ ] README "Interactive terminals" section present and accurate
- [ ] README env var table includes `LOCAL_PM_SHELL` and `LOCAL_PM_IDLE_TIMEOUT_MINUTES`
- [ ] README dependency justification explains node-pty and ws (CLAUDE.md exception documented)
- [ ] ROADMAP Stage D marked complete
- [ ] ROADMAP follow-up entry for ticket-auth + WSS present
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
- [ ] Changes committed: `docs: document interactive terminals, WS auth, env vars, dep justification, roadmap`
- [ ] Phase marked complete

---

### Phase Final: Final Verification

**Mode:** hil

**Overall success criteria:**

- From a worktree panel, open an interactive shell terminal and type commands; see live output via xterm.js
- Open a Claude quick-action terminal in the same worktree; both tabs run independently
- Close a terminal tab; confirm its PTY process keeps running (no process killed on WS disconnect)
- Reopen the same terminal (same sessionId); confirm reattach with scrollback history intact
- Leave a terminal detached for the idle timeout; confirm it is reaped (session removed, process killed)
- All terminals are gated by the dashboard token (`?token=` on the WS upgrade), compared with `timingSafeEqual`
- WS connection with wrong/missing token is rejected BEFORE `wss.handleUpgrade` (socket destroyed, 401 header emitted, no PTY spawned)
- WS connection from a disallowed Origin is rejected (CSWSH defence)
- PTY cwd is the validated registry path; arbitrary client paths and unknown `kind` are rejected (close `4403`); `kind` selects from a fixed command table only — no client command string
- Max concurrent sessions cap enforced (close `4429`)
- Backpressure guard + scrollback byte cap + `maxPayload` bound memory in both directions
- Session ids are crypto-random; reattach re-runs auth; a known path alone cannot attach
- Reaper/shutdown teardown verified on Windows (no orphaned pty; lingering grandchildren documented if any)
- Full request URLs (with token) are never logged
- Vendored xterm assets served correctly with no CDN or build step
- No CLAUDE.md invariants violated: pnpm, plain ESM, no build step, thin entry points, tests via node:test
- Ticket-auth + WSS hardening marked as explicit out-of-scope follow-up in ROADMAP

**Steps:**

- [ ] Every preceding phase's Steps / Verification / Phase review checkboxes are ticked in this plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review have been reflected back into this plan file
- [ ] All tests pass: `pnpm test`
- [ ] No CLAUDE.md invariants violated
- [ ] Feature tested manually: golden path (open shell terminal, type, resize, detach, reattach); Claude quick-action; multi-tab; idle reaper; auth rejection
- [ ] Overall success criteria above met
- [ ] All phase checkboxes above are ticked

---

## Documentation

| Change | Documentation location |
|---|---|
| `/vendor/` static route; node-pty + ws added; xterm vendored | `README.md` (Phase 0, expanded in Phase 4) |
| WS endpoint, auth model (`?token=` + Origin), `LOCAL_PM_SHELL` env var | `README.md` (Phase 1, expanded in Phase 4) |
| Detach/reattach semantics, scrollback cap, `LOCAL_PM_IDLE_TIMEOUT_MINUTES` | `README.md` (Phase 2, expanded in Phase 4) |
| Multi-tab UI, Claude quick-action | `README.md` (Phase 3, expanded in Phase 4) |
| Stage D complete; ticket-auth + WSS hardening as follow-up | `ROADMAP.md` (Phase 4) |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 0 | `/vendor/` static route: correct Content-Type; traversal guard (403 on `../`) | `src/__tests__/server.test.js` |
| Phase 1 | spawnSession security invariants: unknown path, bad kind, cap, col/row clamp; shell vs claude spawn args; write/resize/kill via injectable seam | `src/__tests__/pty.test.js` |
| Phase 1 | authorizeUpgrade: token missing/wrong-length/correct (timingSafeEqual not reached on missing); Origin allowed/disallowed/absent; socket.destroy + handleUpgrade-never-called on rejection; close codes 4403 (bad path/kind/origin) and 4429 (cap); malformed resize frame does not throw; resize bounds validation | `src/__tests__/ws.test.js` |
| Phase 1 | attachWebSocket called on server; no HTTP route regressions | `src/__tests__/server.test.js` |
| Phase 2 | detachClient: pty alive, ws=null, idleAt set; attachClient: scrollback replayed; byte cap eviction; chunk-count cap eviction; backpressure skip-send over HIGH_WATER; idle reaper kills after timeout via killSession (mock timer); reaper skips sessions with active client; shutdown() kills all + clears interval | `src/__tests__/pty.test.js` |
| Phase 3 | Two sessions same worktreePath coexist; killSession(id1) leaves id2 intact | `src/__tests__/pty.test.js` |
| Phase 4 | Pure docs — no automated tests | — |

## Human Summary

**What and why:** This plan adds interactive PTY terminals to the local-pm dashboard, filling the seam PRD 1 left open. Instead of read-only polled log tails, each worktree panel now has tabbed terminals — a shell and/or a one-click Claude session — backed by real PTYs, rendered in xterm.js, and streamed over WebSocket. Sessions survive tab-closes and can be reattached with full scrollback, so you can leave a long `claude` session running, close the browser, and come back to it later.

**How the phases connect:**

- **P0** is a pure infrastructure phase (the only justified exception to the "no horizontal layers" rule): install native deps, vendor the xterm UMD bundle, add a static-serving route. Nothing interactive yet, but the building blocks are in place and verifiable independently (HTTP 200s for vendor files).
- **P1** delivers the first fully interactive terminal end-to-end — PTY spawns, WS connects, xterm renders. This is the highest-risk phase (native addon, WS upgrade auth, security invariants). Everything subsequent is additive.
- **P2** adds the lifecycle model: detach (WS close keeps PTY alive), reattach (new WS replays scrollback), idle reaper (no zombie ptys). This is pure backend — the browser already works with the new reattach path because it just opens a new WS with the same sessionId.
- **P3** is mostly frontend: tab bar per worktree, sessionId per tab, Claude quick-action button. The backend already handles multiple sessions per worktree (the Map is keyed by sessionId, not by path).
- **P4** catches up README and ROADMAP, and explicitly records the ticket-auth + WSS hardening as a named follow-up.

**End result:** Open the dashboard, pick a worktree, open a Shell tab and a Claude tab side by side, run commands, close the browser, come back, reattach — all gated by the same bearer token that secures the HTTP API, with no CDN dependency and no build step.

**Key decisions and trade-offs:**

- **Sanctioned runtime deps** (node-pty, ws) — the only exceptions to CLAUDE.md's zero-runtime-dep preference. Both are justified: you cannot implement a Win32 ConPTY or RFC 6455 WebSocket in plain Node without effectively reimplementing the libraries. Xterm.js is vendored (not a runtime npm dep) to maintain the no-build-step invariant.
- **`?token=` WS auth** is intentionally simple for local-only use. The `authorizeUpgrade` function is designed so swapping to short-lived ticket-based auth (for remote access) changes exactly one function in one file.
- **Scrollback as chunked ring** (not line-split) preserves ANSI escape sequence context across chunk boundaries. Byte cap (512 KB) bounds memory; chunk-count cap (5000) bounds replay latency.
- **Idle reaper at 30 min** prevents abandoned `claude` sessions from running indefinitely. Configurable via env var for users who want longer-lived sessions.
- **Ticket-auth + WSS hardening explicitly out of scope** — recorded in ROADMAP as the natural next step when Cloudflare Tunnel remote access is enabled.
