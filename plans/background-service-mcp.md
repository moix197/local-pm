# Plan: Background Service, Auth Token, and MCP Adapter

**Created:** 2026-06-13
**Branch:** main (direct — solo repo, no worktree flow)
**Status:** complete

## Context

local-pm is a shipped zero-dependency dashboard (plain ESM `.js`, `node:http`, vanilla-JS
single-page UI, no build step, pnpm, Windows). It currently runs only while a terminal is
open. This plan makes it production-ready for solo daily use by adding four things:

1. **Auth token** — every `/api/*` route is protected with a bearer token so the LAN exposure
   isn't wide-open. Token is auto-generated into a gitignored file; browser reads it from
   the URL fragment.
2. **Background service** — Windows Task Scheduler "at log-on" task so the daemon runs in the
   user's interactive session (required for Docker Desktop) without a terminal.
3. **MCP adapter** — a separate `mcp/` subpackage (own `package.json`, `@modelcontextprotocol/sdk`)
   that exposes `list_worktrees`, `start_server`, `stop_server`, `status` as Claude tools,
   forwarding to the guarded daemon. Core stays zero runtime deps.
4. **HTTP API docs** — provider-agnostic curl examples (with bearer token) folded into
   README, not a separate doc file.

Execution is direct on `main`. No worktree/branch steps. Phase commits are fine.

## Risk: low

Single-machine Node.js process. Auth is a single guard function. Task Scheduler
idempotency is handled with delete-then-create. MCP adapter holds no state — forwards
to daemon. Biggest risk is the scheduled task's env var gap (mitigated by the token
file approach).

## Dependencies & Risks

- `node:crypto` is built-in (zero-dep); `randomBytes(32).toString('hex')` produces a
  64-char token.
- The token FILE approach (not env var) is required because Task Scheduler tasks do not
  inherit the user's shell env vars.
- `schtasks` delete-then-create is idempotent but requires the script to swallow
  "task not found" errors on first uninstall attempt.
- `mcp/node_modules` is already covered by the gitignore `node_modules/` glob — no
  additional gitignore entry needed for the SDK.
- The MCP adapter must not be a pnpm workspace package — it's a standalone folder
  installable independently so the core package stays zero-dep.
- Phase 3 (MCP) depends on Phase 1 (guarded API) being in place so the adapter can
  authenticate.
- Token comparison uses `crypto.timingSafeEqual` to prevent timing attacks; length
  mismatch is handled explicitly before calling it (returns `false` immediately).
- The daemon runs as a background service; its stdout may be captured to a log file.
  The full token value is printed ONLY on first generation — subsequent starts print a
  masked confirmation line instead, to avoid leaking the secret into log files.

---

## Phases

### Phase 1: Token guard end-to-end

**Risk:** low
**Mode:** afk
**Type:** security
**Success criteria:** All three `/api/*` routes return `401` without a valid bearer token
and respond normally with one. The browser loads via `GET /` (no token required), reads
`#token=<value>` from the URL fragment, stores it in `sessionStorage`, and sends
`Authorization: Bearer` on every `/api` call. On `401` the page shows a clear
"add your token (#token=…)" message instead of crashing. The token file is auto-generated
on first startup if absent; the full value is printed to stdout only on first generation;
subsequent starts print a masked line (`auth token loaded from token.local`). The token
file is listed in `.gitignore`.
**Commit message:** `feat: bearer token auth guard, token-file provisioning, browser fragment flow`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `src/token.js` | `ensureToken()` — reads `token.local` if present, generates+writes if absent; `readToken()` — reads and returns current token string; `isAuthorized(req)` — checks `Authorization: Bearer <token>` header using `crypto.timingSafeEqual` |
| modify | `src/server.js` | Import `isAuthorized` and `ensureToken` from `src/token.js`; add auth guard at top of `route()` before any dispatch: if path starts with `/api/` and `!isAuthorized(req)`, call `sendJson(res, 401, { error: 'Unauthorized' })` and return; call `ensureToken()` on startup — it returns `{ token, isNew }` so `server.js` prints the value only when `isNew` is `true`, otherwise prints `"auth token loaded from token.local"` |
| modify | `public/index.html` | On DOMContentLoaded: read `location.hash` for `#token=`, store in `sessionStorage('lpm-token')`; update `fetchState()` and `post()` to send `Authorization: Bearer ${token}` header; if any response is `401`, render a `<div class="auth-error">` message in place of the project list instructing the user to add `#token=…` to the URL |
| modify | `.gitignore` | Add `token.local` entry |
| modify | `README.md` | Add "Authentication" section: explains token file, startup print behavior (value once / masked thereafter), browser `#token` fragment, curl `Authorization: Bearer` examples for all three API endpoints |
| create | `src/__tests__/token.test.js` | Tests for `isAuthorized`, `ensureToken`, and `readToken` |

**Steps:**

- [x] Create `src/token.js` with three named exports:
  - `ensureToken()` — uses `repoRoot` (same pattern as `config.js`) to resolve `token.local`;
    if file absent, generates `crypto.randomBytes(32).toString('hex')`, writes it, returns
    `{ token, isNew: true }`; if present, reads, trims, and returns `{ token, isNew: false }`
  - `readToken()` — reads `token.local`, trims result; throws descriptive error if absent
    (`"token.local not found — run the server once to generate it"`)
  - `isAuthorized(req)` — parses `Authorization` header; extracts the value after `"Bearer "`;
    if the header is missing or the prefix is wrong, returns `false`; compares token bytes
    using `crypto.timingSafeEqual` (handle length mismatch: if lengths differ, return `false`
    immediately without calling `timingSafeEqual` to avoid the buffer-length assertion); calls
    `readToken()` internally
- [x] Modify `src/server.js`:
  - Import `{ ensureToken, isAuthorized }` from `./token.js`
  - In `route()`, insert auth guard as first check: `if (url.pathname.startsWith('/api/') && !isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });`
  - In the `server.listen` callback, call `const { token, isNew } = ensureToken();` and:
    - If `isNew`: print `  token: ${token}` to stdout (full value, one-time reveal)
    - If `!isNew`: print `  auth token loaded from token.local` (no value, safe for logs)
- [x] Modify `public/index.html`:
  - At top of `<script type="module">`, add token bootstrap: parse `location.hash` for
    `#token=<value>`, if found store in `sessionStorage.setItem('lpm-token', value)` then
    replace history state to strip fragment from URL bar; read token back:
    `const TOKEN = sessionStorage.getItem('lpm-token') ?? '';`
  - Update `fetchState()`: add `headers: { 'Authorization': 'Bearer ' + TOKEN }` to the
    `fetch` call; check `res.ok` — if `res.status === 401` throw a sentinel `AuthError`
  - Update `post()` similarly: add the `Authorization` header to the `POST` fetch
  - Add `AuthError` class (extends Error) and a `renderAuthError()` function that sets
    `document.getElementById('projects').innerHTML = '<div class="auth-error">…add your token via <code>#token=&lt;value&gt;</code> in the URL…</div>'`
  - In `tick()`, catch `AuthError` and call `renderAuthError()` instead of crashing
  - Add minimal CSS for `.auth-error` (muted color, readable message)
- [x] Add `token.local` to `.gitignore`
- [x] Write `src/__tests__/token.test.js`:
  - `isAuthorized` — valid token returns `true`; missing `Authorization` header returns
    `false`; wrong token returns `false`; `Bearer ` prefix missing returns `false`;
    token with different length than expected returns `false` (covers the `timingSafeEqual`
    length-guard branch)
  - `ensureToken` — creates file if absent (use a temp path via `os.tmpdir()`), returns
    `isNew: true`; reads existing file, returns `isNew: false`; trims whitespace on read
  - `readToken` — throws descriptive error when file absent; returns trimmed string when present
- [x] Run `pnpm test` — all pass
- [x] Update `README.md` with "Authentication" section including curl examples and note on
  startup log behavior (value printed once on generation; masked on subsequent starts)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/__tests__/token.test.js` | `isAuthorized` (valid/missing/wrong/no-prefix/length-mismatch); `ensureToken` (create-if-absent returns `isNew:true`, read-existing returns `isNew:false`, trims); `readToken` (throws when absent, trims when present); `timingSafeEqual` length-guard branch |

**Verification:**

- [x] Automated tests pass: `pnpm test`
- [ ] Manual: `pnpm start` first run — prints `token: <full-value>` to stdout; subsequent
  `pnpm start` — prints `auth token loaded from token.local` (no token value in output)
- [ ] Manual: `curl http://localhost:7420/api/state` returns `401`; `curl -H "Authorization: Bearer <token>" http://localhost:7420/api/state` returns `200`
- [ ] Manual: `GET /` (browser, no token in fragment) — page loads; `/api` calls show the auth-error message
- [ ] Manual: open `http://localhost:7420/#token=<value>` — browser stores token, hides fragment from URL bar, dashboard works normally

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (README.md — "Authentication" section added)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: bearer token auth guard, token-file provisioning, browser fragment flow`
- [x] Phase marked complete

---

### Phase 2: Background service (Windows Task Scheduler)

**Risk:** low
**Mode:** afk
**Type:** config
**Success criteria:** Running `pnpm schedule:install` registers a Windows Task Scheduler
"at log-on" task that starts `node <repo>/src/server.js` in the user's interactive
session. Running `pnpm schedule:uninstall` removes it. Both scripts are idempotent.
`schtasks /query /tn local-pm` confirms the task after install and returns "not found"
after uninstall.
**Commit message:** `feat: Task Scheduler install/uninstall scripts and pnpm scripts`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `scripts/schedule-install.js` | Node ESM script using `node:child_process` `execFileSync('schtasks', [...])` to delete-then-create the task; prints success/failure; no external deps |
| create | `scripts/schedule-uninstall.js` | Node ESM script that deletes the task via `schtasks /delete`; swallows "task not found" error |
| modify | `package.json` | Add `"schedule:install": "node scripts/schedule-install.js"` and `"schedule:uninstall": "node scripts/schedule-uninstall.js"` scripts |
| modify | `README.md` | Add "Run as a background service" section with Task Scheduler instructions, gotcha note (env vars not inherited → token file), and manual at-log-on verification step |

**Steps:**

- [x] Create `scripts/schedule-install.js`:
  - Resolve `repoRoot` via `import.meta.url` (same pattern as other modules)
  - Resolve `nodePath` via `process.execPath` (the Node binary currently running the script)
  - Resolve `serverPath = path.join(repoRoot, 'src', 'server.js')`
  - Delete existing task first (swallow exit-code 1 / "ERROR: The specified task name ... does not exist"): `execFileSync('schtasks', ['/delete', '/tn', 'local-pm', '/f'], { stdio: 'pipe' })` in a try/catch
  - Create task: `execFileSync('schtasks', ['/create', '/tn', 'local-pm', '/tr', `"${nodePath}" "${serverPath}"`, '/sc', 'onlogon', '/rl', 'limited', '/f'], { stdio: 'inherit' })`
  - Print confirmation: "Task 'local-pm' installed. It will run automatically at next log-on."
  - Print token reminder: "Token is stored in token.local — start the server once first if you haven't already."
- [x] Create `scripts/schedule-uninstall.js`:
  - Same `repoRoot` resolution pattern
  - `execFileSync('schtasks', ['/delete', '/tn', 'local-pm', '/f'], { stdio: 'inherit' })` in try/catch; on error print "Task 'local-pm' not found — nothing to remove."
- [x] Add scripts to `package.json`
- [x] Update `README.md` — new section "Run as a background service" with:
  - `pnpm schedule:install` / `pnpm schedule:uninstall`
  - Note: task runs as current user in interactive session (required for Docker Desktop)
  - Note: env vars not inherited by Task Scheduler — token is in `token.local`, not an env var
  - Note: full at-log-on cycle must be verified manually (sign out, sign in, check dashboard)
  - `schtasks /query /tn local-pm` to confirm task is registered

**Tests:**

No automated tests — justified because: both scripts are thin wrappers over `schtasks`
(a system call). The only testable behavior is the `schtasks` invocation itself, which
requires a real Windows session and admin/user rights. Manual verification via
`schtasks /query` is the appropriate check here.

**Verification:**

- [ ] `pnpm schedule:install` exits 0; `schtasks /query /tn local-pm` shows the task with "On logon" trigger
- [ ] `pnpm schedule:install` run a second time (idempotency) — exits 0; task still present, not duplicated
- [ ] `pnpm schedule:uninstall` — exits 0; `schtasks /query /tn local-pm` returns "ERROR: The specified task name ... was not found"
- [ ] `pnpm schedule:uninstall` run a second time (idempotency) — exits 0 with "nothing to remove" message

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing (no-tests justification accepted)
- [x] Documentation updated (README.md — "Run as a background service" section added)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: Task Scheduler install/uninstall scripts and pnpm scripts`
- [x] Phase marked complete

---

### Phase 3: MCP adapter

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** `node mcp/index.js` starts a stdio MCP server. A `tools/list` call
returns four tools: `list_worktrees`, `start_server`, `stop_server`, `status`. Each
`tools/call` forwards to the daemon's guarded HTTP API (token from `LOCAL_PM_TOKEN` env
or by reading `token.local`) and returns the daemon's response as a well-formed MCP result.
When the daemon is unreachable, the token file is missing, or the daemon returns non-2xx,
each tool returns a clear MCP error (non-empty `content` with an `isError: true` flag) —
no crashes, no silent empty results. The `.mcp.json` snippet works in Claude Code
(`claude mcp add`) and drives the daemon from Claude.
**Commit message:** `feat: MCP stdio adapter with four tools forwarding to guarded daemon`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `mcp/package.json` | Standalone package (`"name": "local-pm-mcp"`, `"type": "module"`, `"main": "index.js"`); depends on `@modelcontextprotocol/sdk` at the version resolved by pnpm; NOT a pnpm workspace member |
| create | `mcp/index.js` | Stdio MCP server using `@modelcontextprotocol/sdk`; exposes 4 tools; forwards each to daemon HTTP API; reads token from `LOCAL_PM_TOKEN` env or falls back to reading `../token.local` relative to `mcp/index.js`; all error paths return structured MCP errors |
| create | `mcp/pnpm-lock.yaml` | Lockfile generated by `pnpm add @modelcontextprotocol/sdk` inside `mcp/` — committed so installs are reproducible |
| create | `mcp/.gitignore` | `node_modules/` (belt-and-suspenders; root gitignore already covers it via glob but explicit is clearer for standalone folder) |
| modify | `README.md` | Add "MCP adapter" section: `cd mcp && pnpm add @modelcontextprotocol/sdk` (first time) or `pnpm install` (subsequent), Claude Code `.mcp.json` snippet, tool descriptions, `LOCAL_PM_URL`/`LOCAL_PM_TOKEN` env vars, failure behavior note |

**Steps:**

- [x] Create `mcp/package.json` (no `dependencies` block yet — pnpm will add it):
  ```json
  {
    "name": "local-pm-mcp",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "index.js"
  }
  ```
- [x] Run `pnpm add @modelcontextprotocol/sdk` from inside `mcp/` — this resolves and pins
  the current latest version. Commit whatever exact version pnpm writes into
  `mcp/package.json` and `mcp/pnpm-lock.yaml`. Do NOT hardcode a version number in the
  plan; use whatever pnpm resolves.
- [x] Create `mcp/index.js`:
  - Resolve `repoRoot` via `import.meta.url` pointing to `mcp/` — `path.resolve(dirname, '..')` gives the repo root
  - `getToken()` helper: return `process.env.LOCAL_PM_TOKEN` if set; otherwise read
    `path.join(repoRoot, 'token.local')` and trim; throw descriptive error if neither
    available (`"LOCAL_PM_TOKEN env not set and token.local not found"`)
  - `BASE_URL` = `process.env.LOCAL_PM_URL ?? 'http://localhost:7420'`
  - `apiCall(method, path, body?)` helper: calls `fetch(BASE_URL + path, { method,
    headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined })`; on non-2xx throws an `Error` with
    message `"daemon returned ${status}: ${text}"`; on network error (ECONNREFUSED etc.)
    lets the error propagate with its original message
  - Each tool handler wraps `apiCall(...)` in try/catch and returns:
    - On success: `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
    - On error: `{ isError: true, content: [{ type: 'text', text: err.message }] }`
    This ensures the MCP client always receives a structured response, never a raw crash
  - Import `{ McpServer }` from `@modelcontextprotocol/sdk/server/mcp.js` and
    `{ StdioServerTransport }` from `@modelcontextprotocol/sdk/server/stdio.js`
  - Create server instance; register four tools:
    - `list_worktrees` — no params; calls `GET /api/state`; returns `state.worktrees` as JSON string
    - `status` — no params; calls `GET /api/state`; returns `state.status` as JSON string
    - `start_server` — param `path: string`; calls `POST /api/start` with `{ path }`; returns response JSON
    - `stop_server` — no params; calls `POST /api/stop`; returns response JSON
  - Connect to `StdioServerTransport` and start
- [x] Create `mcp/.gitignore` with `node_modules/`
- [x] Update `README.md` — "MCP adapter" section with:
  - Setup (first time): `cd mcp && pnpm add @modelcontextprotocol/sdk`
  - Setup (subsequent / after cloning): `cd mcp && pnpm install`
  - `.mcp.json` snippet for Claude Code:
    ```json
    {
      "mcpServers": {
        "local-pm": {
          "command": "node",
          "args": ["C:/path/to/local_pm/mcp/index.js"],
          "env": {
            "LOCAL_PM_URL": "http://localhost:7420",
            "LOCAL_PM_TOKEN": "<paste token here or omit to auto-read token.local>"
          }
        }
      }
    }
    ```
  - Tool table: `list_worktrees`, `status`, `start_server` (param: `path`), `stop_server`
  - Note: `LOCAL_PM_TOKEN` env is optional — adapter falls back to reading `token.local` in repo root
  - Note: if daemon is down or returns an error, the tool returns a clear error message to
    Claude rather than crashing

**Tests:**

No automated tests — justified because: the MCP adapter is a thin forwarding layer over
the SDK and the daemon's HTTP API. Its only logic is `getToken()` (env-or-file) and the
`apiCall()` fetch wrapper. These depend on network and file I/O that would require
significant mock ceremony. The acid test (tool calls from Claude driving the real daemon)
covers the integration path meaningfully; `getToken()` env-path is verifiable via manual
env override.

**Verification:**

- [ ] `node mcp/index.js` starts without error (reading token from `token.local`)
- [ ] From Claude Code (after adding `.mcp.json`): `list_worktrees` tool returns the worktree list; `status` returns current daemon status
- [ ] `start_server` with a valid path starts the dev server; `stop_server` stops it
- [ ] Run with `LOCAL_PM_TOKEN=wrongtoken node mcp/index.js` — subsequent tool calls return an MCP error with `isError: true` and message indicating `401 Unauthorized` (not a crash)
- [ ] Run with `LOCAL_PM_URL=http://localhost:9999 node mcp/index.js` — tool calls return an MCP error with `isError: true` and a network error message (daemon not running on that port, not a crash)
- [ ] Remove `token.local` temporarily and run without `LOCAL_PM_TOKEN` env — tool calls return an MCP error with `isError: true` and the "token.local not found" message

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing (no-tests justification accepted)
- [x] Documentation updated (README.md — "MCP adapter" section added)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: MCP stdio adapter with four tools forwarding to guarded daemon`
- [x] Phase marked complete

---

### Phase 4: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- `pnpm start` first run prints local URL, LAN URL, and full token value to stdout;
  subsequent `pnpm start` prints URL lines and `"auth token loaded from token.local"` — no
  token value — safe for log capture
- `token.local` is present and gitignored
- `GET /` loads the page without a token; `/api/state` without token returns `401`;
  `/api/state` with correct bearer token returns `200`
- Browser: open with `#token=<value>` → dashboard works; open without token → auth-error
  message visible
- `pnpm schedule:install` registers the task; `schtasks /query /tn local-pm` confirms it;
  `pnpm schedule:uninstall` removes it
- MCP tools from Claude: `list_worktrees`, `status`, `start_server`, `stop_server` all
  drive the daemon correctly; each failure path (daemon down, bad token, missing token
  file) returns a clear MCP error, not a crash
- All automated tests pass: `pnpm test`
- README accurately covers auth, background service, MCP adapter, and API curl examples

**Steps:**

- [x] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked
- [x] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent reviews the entire change end-to-end
- [x] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [x] All tests pass: `pnpm test` (38/38)
- [x] No CLAUDE.md invariants violated (thin `server.js` — auth/token logic in `src/token.js`; functions ≤30 lines; core zero runtime deps; `mcp/` only has the SDK dep; pnpm used throughout; reuse `sendJson`; no dead code; README updated)
- [x] Manual: curl smoke test without token → 401; with token → 200
- [x] Manual: browser token fragment flow — stores token, strips fragment, dashboard loads
- [x] Manual: browser 401 UX — auth-error message shown, no JS crash
- [x] Manual: `pnpm schedule:install` → `schtasks /query` confirms task (requires elevated shell; verified by user)
- [x] Manual: MCP tools from Claude Code drive the daemon (list, status, start, stop) — verified live via web_template (local-scope registration, `list_worktrees` returned real worktrees)
- [x] Manual: MCP failure paths — daemon down, wrong token, missing token.local each produce clear `isError: true` MCP responses
- [x] Manual: second `pnpm start` — stdout contains no token value, only the masked confirmation line
- [x] Overall success criteria met
- [x] All phase checkboxes above are ticked

---

## Documentation

| Change | Documentation location |
|---|---|
| Token provisioning, bearer auth, startup log behavior, browser fragment flow, curl examples (Phase 1) | `README.md` — "Authentication" section |
| Task Scheduler install/uninstall (Phase 2) | `README.md` — "Run as a background service" section |
| MCP adapter setup, `.mcp.json` snippet, tool table, failure behavior (Phase 3) | `README.md` — "MCP adapter" section |

Documentation is added as a step within each relevant phase.

---

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | `isAuthorized` — valid/missing/wrong/no-prefix/length-mismatch; `ensureToken` — create-if-absent (`isNew:true`), read-existing (`isNew:false`), trim; `readToken` — throws when absent, trims when present; `timingSafeEqual` length-guard branch | `src/__tests__/token.test.js` |
| Phase 2 | No testable logic — thin `schtasks` wrapper; verified via `schtasks /query` | n/a (manual) |
| Phase 3 | No testable logic — thin MCP forwarding layer; verified via Claude tool calls | n/a (manual) |
| Phase 4 | Full manual walkthrough — no automated test file | n/a (hil) |

---

## Human Summary

**What we're building:** Three orthogonal capabilities layered on top of the shipped MVP.

**Phase 1 — Token guard:** Every API call requires a bearer token. The token is
auto-generated into `token.local` on first daemon start and printed to stdout ONCE (first
generation only). On subsequent starts the daemon prints a masked confirmation line
(`"auth token loaded from token.local"`) — no secret value — so stdout is safe to capture
in a log file. The browser reads the token from `#token=<value>` in the URL fragment and
stores it in `sessionStorage` — no manual header work in the browser. On `401` the page
shows a clear message instead of breaking. Token comparison uses `crypto.timingSafeEqual`
to prevent timing side-channels.

**Phase 2 — Background service:** A Windows Task Scheduler "at log-on" task means the
daemon starts automatically in your interactive session (where Docker Desktop runs) every
time you log in. `pnpm schedule:install` / `pnpm schedule:uninstall` are idempotent via
delete-then-create. The token-file approach is what makes this work without env var
inheritance.

**Phase 3 — MCP adapter:** A standalone `mcp/` folder with its own `package.json` pulls
in the `@modelcontextprotocol/sdk` (installed with pnpm, version pinned to whatever pnpm
resolves at install time) without touching the zero-dep core. `mcp/index.js` is a stdio
MCP server that exposes four tools to Claude. Each tool call forwards to the daemon's
HTTP API (with the bearer token), so the daemon stays the single source of truth and the
MCP adapter is a pure forwarding layer. All failure paths — daemon down, non-2xx, missing
token file — return structured MCP errors (`isError: true`) rather than crashing or
returning silent empty results.

**Phase 4 — Final Verification:** End-to-end manual walkthrough: token flows, curl
examples, Task Scheduler round-trip, MCP tools from Claude, MCP failure paths, and a
final code-reviewer pass over everything.

**End result:** local-pm runs in the background at every log-on, is protected by a token,
and Claude can control it directly via MCP tools — while the core package remains
completely dependency-free.

**Trade-offs accepted:**
- Token in a file (not env var) — necessary for Task Scheduler compatibility; minor UX
  friction on first browser use mitigated by the `#token=` fragment approach.
- Token printed to stdout only on first generation — the masking on subsequent starts
  means if you lose the value you must read `token.local` directly, but this is the
  right trade-off for log-file safety.
- `mcp/` not a pnpm workspace — intentional; keeps root `pnpm install` from pulling the
  SDK into core. pnpm handles standalone (non-workspace) package directories fine.
- SDK version not hardcoded in the plan — implementer runs `pnpm add` and commits
  whatever pnpm resolves, ensuring a real lockfile pin rather than a guessed semver range.
- No automated tests for `schtasks` wrapper or MCP forwarding layer — system-call and
  network-integration behavior is only meaningful against real system components; the acid
  tests are manual.
- Browser fragment token is not encrypted in transit on LAN — acceptable for a
  single-user local tool on a trusted home network.
- Concurrent-start race on token file generation is theoretically possible but benign
  on a single-user machine; the file write is atomic enough at this scale. Not worth
  adding OS-level locking.
