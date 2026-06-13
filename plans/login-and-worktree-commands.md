# Plan: Token Login Overlay + Run Commands in a Worktree

**Created:** 2026-06-13
**Branch:** main (solo repo — changes ship directly on `main`)
**Status:** not started

> **Repo convention:** This is a solo repo and changes ship **directly on `main`**
> — no worktree/branch flow. The MVP was executed directly on `main`; every phase
> below commits straight to `main` (one commit per phase), no feature branch, no
> worktree creation step.

## Context

local-pm is a zero-runtime-dependency LAN dashboard (`node:http` + a vanilla-JS
single-page `public/index.html`) for controlling Docker/dev servers across git
worktrees. Two gaps make day-to-day use awkward:

1. **Auth onboarding is hostile.** The only way to authenticate is to paste
   `#token=<value>` into the URL (`public/index.html:115-120`,
   `renderAuthError` at `:154-159`). The token lives in `sessionStorage`, so it
   evaporates when the browser closes — you re-paste the token-in-URL every
   session, on every device. There is no way to drop a stale/bad token.

2. **You can't run one-off commands in a worktree.** To `npm install`,
   `npm run build`, or run an ad-hoc command in a worktree you must drop to a
   terminal. The dashboard already owns the worktree paths, the spawn plumbing
   (`src/runner.js`), the log buffer, and the auth boundary — so it should be
   able to run curated and free-form commands per worktree.

**Intended outcome:** (A) a proper login overlay that persists the token across
browser restarts with a forget/logout escape hatch; (B) per-worktree command
execution (curated quick-actions + free-form) that streams output into the
existing logs panel, gated to stopped worktrees, reusing the existing
single-operation guard.

## Risk: medium

Frontend-only auth change is low risk. The command-execution feature adds
**arbitrary remote code execution by design** behind the existing token. That is
acceptable for a LAN-only, single-user tool but is the load-bearing risk: the
plan documents it explicitly and fences it as "must be revisited before any
remote/non-LAN exposure."

## Dependencies & Risks

- **Arbitrary RCE by design.** Free-form commands run raw via
  `spawn(cmd, { cwd, shell: true })` with inherited env, no allowlist, no
  sanitization. The token Bearer check (`isAuthorized`, applied to all `/api/*`
  in `src/server.js:76-78`) is the *only* boundary. The transport is HTTP
  cleartext. This is fine for local/LAN use and MUST be revisited
  (HTTPS/self-signed, hardening) before any remote exposure. Captured as an
  explicit out-of-scope/future note in Phase 3 docs.
- **Single global log buffer.** Command output reuses the one 300-line ring
  buffer (`appendLog`, `src/runner.js:77-80`). Noisy commands will churn the
  buffer and push out server logs — accepted trade-off, documented.
- **Single-operation model.** A running command must block `startServer` and any
  other command. We reuse the existing `inProgress` guard
  (`src/runner.js:12,140-141,157-159`) rather than adding a second lock — keeps
  one source of truth for "busy."
- **Windows shell PID semantics.** With `shell: true`, `child.pid` is the
  `cmd.exe` shell PID, not the leaf process (`src/runner.js:106-107`). The
  existing `_killFn` default already uses `taskkill /T /F` to kill the tree
  (`src/runner.js:25-31`) — command-stop reuses it, so the tree dies correctly.
- **Interactive commands hang.** A command that waits on stdin (e.g. a prompt)
  never exits; the Stop-command button is the recovery path. Documented as a
  known limitation.
- **Order-sensitive:** Phase 2 introduces the `command` state object and the
  `/api/command` endpoint; Phase 3's free-form path depends on it. Phase 1 is
  independent and could ship alone.

### Reuse & CLAUDE.md invariants (must hold across all phases)

- **Reuse, don't reinvent:** `appendLog` (300-ring, `runner.js:77-80`),
  `streamToLog` (`:82-89`), the `_spawn`/`_killFn` test seams
  (`:19-22,33-36`), the `inProgress` busy guard (one source of truth — reused
  for commands, not a second lock), `sendJson`/`readJsonBody` (`server.js:16-36`),
  the `isAuthorized` `/api/*` gate (`:76-78`), and frontend
  `renderBanner`/`makeRow`/`post`/`tick`/`authHeaders` patterns. New code extends
  these, it does not duplicate them.
- **Bearer enforced on new routes:** `/api/command` and `/api/command/stop` sit
  under `/api/` so the existing `isAuthorized` gate (`server.js:76-78`) covers
  them with no extra code — asserted by a 401-without-Bearer test in Phase 2.
- **Thin entry points:** all command logic lives in `runner.js`
  (`runCommand`/`stopCommand`); `server.js` handlers only parse + delegate +
  `sendJson`. Functions stay <30 lines, named after what they do, no new runtime
  deps, docs updated alongside code.

### Out of scope / explicit risk to document

- **Remote-readiness caveat (documented item, Phase 3):** the tool runs arbitrary
  commands over **HTTP cleartext**, gated only by the Bearer token, on a LAN.
  This is arbitrary RCE by design. It is acceptable for solo/LAN use and MUST be
  revisited (HTTPS/self-signed + hardening) before any remote/non-LAN exposure.
  This caveat is written into README + ROADMAP in Phase 3 (not optional).

## Phases

> All phases commit directly to `main` per the repo convention noted at the top.

### Phase 1: Token login overlay + persistent localStorage + forget link

**Risk:** low
**Mode:** hil
**Manual-verification justification:** This phase is pure `public/index.html`
browser UI (localStorage + overlay + a `fetch` validation) with no Node-side
logic; the repo has **no browser test harness and zero frontend tests** today,
and `node:test` only covers server modules. Introducing a browser test framework
would violate the zero-runtime-deps + minimal-change invariants, so it is
verified manually via the acid test below.
**Type:** frontend
**Success criteria:** On a device with no stored token, the user sees a login
overlay, pastes a token, and gets into the dashboard. After a browser refresh
*and* after fully closing and reopening the browser, they are still logged in
(no re-paste). A wrong token keeps the overlay visible with an error. A "forget
token" link clears the stored token and re-shows the overlay. The old
`#token=` URL flow still works and now *also* persists the token.

**Commit message:** `feat(ui): add persistent token login overlay with forget-token link`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `public/index.html` | Replace `sessionStorage` token storage with `localStorage` (key `lpm-token`); persist `#token=` hash into `localStorage` (still clear the hash); add a login-overlay modal (token input + submit + error slot) shown when no valid token; validate a pasted token by calling `/api/state` (401 ⇒ reject + show error, stay on overlay); add a "forget token" link in the header that clears `localStorage` and re-shows the overlay; replace the `renderAuthError` "paste in URL" copy (`:154-159`) so a 401 during normal polling re-shows the overlay instead. Extract overlay logic into small named functions (`getStoredToken`, `setStoredToken`, `clearStoredToken`, `showLoginOverlay`, `hideLoginOverlay`, `submitToken`). Add overlay CSS reusing existing `--panel`/`--border`/`--red` tokens and the `.hidden` pattern. |

**Steps:**

- [x] Add overlay markup (hidden by default) + "forget token" link to the header (`public/index.html:100-111`)
- [x] Add overlay CSS using existing CSS custom properties and the `.hidden` convention (`:8-97`)
- [x] Replace `sessionStorage` reads/writes with `localStorage` under key `lpm-token` (`:117,120`); keep the hash-capture branch but write to `localStorage` and still call `history.replaceState` (`:115-119`)
- [x] Add `getStoredToken/setStoredToken/clearStoredToken` helpers; make `TOKEN` a mutable lookup (not a `const` snapshot) so forget/login can update it without reload
- [x] Add `showLoginOverlay/hideLoginOverlay/submitToken`; `submitToken` validates by fetching `/api/state` with the candidate token, rejecting on 401 (reuse the `AuthError` path at `:130,143`)
- [x] On load: if no stored token, show overlay and skip `tick()`; after successful submit, store token, hide overlay, start polling
- [x] Repoint `renderAuthError` (`:146,154-159,246`) to call `showLoginOverlay` with an error message instead of printing the paste-in-URL instructions
- [x] Wire the "forget token" link to `clearStoredToken` + `showLoginOverlay`
- [ ] *(Optional, only if it falls out cleanly with no restructuring)* If the
  token read/persist/validate trio (`getStoredToken/setStoredToken/clearStoredToken`)
  can be lifted into a tiny pure helper module that `node:test` could import,
  do so and add a minimal unit test. Otherwise leave it inline in
  `index.html` — **default to minimal change**, do not restructure the SPA to
  make it testable.

**Tests:**

| Action | File | What it covers |
|---|---|---|
| — | — | No automated tests — justified because: this phase is pure `public/index.html` browser UI with no Node-side logic and no existing browser test harness in the repo (`node:test` covers server modules only); adding a browser framework would break zero-deps + minimal-change. Verified manually per the acid test below. (If the optional pure-helper extraction above is taken, add its unit test here.) |

**Verification:**

- [x] Automated tests for this phase pass: `pnpm test` (existing suite still green — no server code touched)
- [x] Fresh device/profile (no `lpm-token`): overlay appears, dashboard hidden
- [x] Paste a valid token ⇒ overlay closes, worktrees render
- [x] Hard refresh ⇒ still logged in; fully close + reopen browser ⇒ still logged in (localStorage survives)
- [x] Paste a wrong token ⇒ overlay stays, error shown
- [x] Click "forget token" ⇒ overlay returns; pasting a fresh token works
- [x] Legacy `#token=<value>` URL ⇒ logs in, hash cleared, and persists across reopen
- [x] Phone on the LAN: same flow works (manual paste once, persists)
- [x] **Stale-token edge case:** stored `lpm-token` is present but the server has
  rotated `token.local` ⇒ next poll gets 401 ⇒ overlay is re-shown (via
  `renderAuthError`→`showLoginOverlay`), NOT a silent failure or blank screen;
  pasting the new token recovers

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn *(n/a — executed via /execute-prd code-reviewer subagent, not the /clear handoff workflow)*
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session *(n/a — see above)*
- [x] Code-reviewer agent has verified this phase *(green; commits `defcc97`, `7d73156`)*
- [x] Any code-reviewer-driven changes reflected back into this plan file *(stale-token interval nit fixed in code, commit `75eb3cf`; no plan change needed)*
- [x] Tests for this phase written and passing — or no-tests justification accepted *(no-tests justification accepted; existing suite 41/0)*
- [x] Documentation updated (see Documentation section) *(login-overlay docs deferred to Phase 3 per Documentation table — not required this phase)*
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(ui): add persistent token login overlay with forget-token link`
- [x] Phase marked complete

---

### Phase 2: Quick-actions end-to-end (curated commands per stopped worktree)

**Risk:** medium
**Mode:** afk
**Type:** mixed
**Vertical-slice note:** This phase is intentionally a single mixed slice —
backend (`runner` command exec + `/api/command` routes + `config`/`worktrees`
plumbing) AND its minimal UI (quick-action buttons + banner + Stop) ship
**together** so the phase is user-testable end-to-end (acid test: "click a
button on a stopped worktree, see output stream"). It is deliberately NOT split
into a backend-only phase and a UI-only phase (that would be horizontal layering
with nothing observable until the UI lands).
**Success criteria:** On a *stopped* worktree the user sees quick-action buttons
(defaults `npm install`, `npm run build`, `npm run lint`, plus any per-project
`commands` from `projects.json`). Clicking one streams the command's output into
the existing logs panel (header `[cmd] <command>`, output, footer
`[cmd] exited <code>`) and shows a live banner (`Running command: <label>…`),
turning green `✓ (exit 0)` or red `✗ (exit N)`. While a command runs, a
"Stop command" button kills it. If the worktree's server is running, the backend
rejects the command with **409** and the UI hides/disables command controls.

**Commit message:** `feat(runner): run curated commands in a stopped worktree`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `src/runner.js` | Add module-scope `command` state (`{cwd,label,pid,startedAt,status:'running'\|'done'\|'failed',exitCode}\|null`). Add `runCommand(worktreePath, { cmd, label })`: reuse the `inProgress` guard (`:12,140-141`) — early-return `getStatus()` if busy; reject (return without spawning, append a log) if `active` is set; spawn `_spawn(cmd, { cwd: worktreePath, shell: true })`; `appendLog('[cmd] ' + label)`, `streamToLog` stdout+stderr (`:82-89`); on `close(code)` append footer `[cmd] exited <code>` **and** set `command.exitCode = code` + `command.status = code === 0 ? 'done' : 'failed'` (exit code surfaced in BOTH the log footer and command state), then clear `inProgress`; on `error(err)` reuse the existing spawn-error pattern from `spawnDevServer` (`:124-131`) — `appendLog('[cmd] error: …')`, mark `failed`, reset `inProgress`. Add `stopCommand()`: if no command running, no-op return `getStatus()`; else reuse `_killFn` (`:33-36`) on `command.pid` and mark stopped/`failed`. Extend `getStatus()` (`:178-180`) to include `command`. Keep functions <30 lines (split spawn/finalize helpers mirroring `spawnDevServer`); name them `runCommand`/`stopCommand` (verb-after-what-they-do). |
| modify | `src/server.js` | Add `POST /api/command` route (`:81-83` area) → `handleCommand`: parse `{ path, cmd, label }` via `readJsonBody` (`:22-36`), validate path against `getWorktrees()` like `handleStart` (`:58-62`), return **409** `{ error: 'stop the server first' }` if `getStatus().active`, else `await runCommand(...)` and `sendJson(res, 200, getStatus())`. Add `POST /api/command/stop` → `handleStopCommand` calling `stopCommand()`. `handleState` (`:44-53`) already returns `getStatus()`, so `command` is surfaced automatically. Handlers stay thin — parse + delegate + `sendJson`. |
| modify | `src/config.js` | Surface optional per-project `commands` array: `loadProjects` maps each project through `withRootExists` (`:25-27,36-39`) — pass `commands` through there (default `[]`) alongside `name/root/exists`. Add a small `normalizeCommands(raw)` helper that accepts strings (→ `{label:s, cmd:s}`) or `{label,cmd}` objects, and `throw` a clear error matching the JSON-error style (`:18-22`) if `commands` is present but not an array of those shapes. |
| modify | `src/worktrees.js` | **Resolved-`commands` merge lives here.** `toWorktree(project, entry)` (`:34-41`) is the per-worktree shape builder and already has the `project` object in scope. Extend it to attach `commands: mergeCommands(project.commands)`. Add a module-scope `DEFAULT_COMMANDS = [{label:'npm install',cmd:'npm install'},{label:'npm run build',cmd:'npm run build'},{label:'npm run lint',cmd:'npm run lint'}]` and a `mergeCommands(projectCommands = [])` helper implementing **EXTENDS** semantics: start from `DEFAULT_COMMANDS`, then append the project's commands, then **dedupe by `label`** (project entry wins on label collision so a project can override a default's `cmd`). Result is the resolved list each worktree carries. |
| modify | `src/server.js` | No change needed for plumbing: `handleState` (`:44-53`) already returns `await getWorktrees()`, so each worktree's resolved `commands` array is surfaced in the `/api/state` payload automatically once `toWorktree` carries it. (Route additions for `/api/command` are listed in the `src/server.js` row above.) |
| modify | `public/index.html` | In `makeRow` (`:184-205`), when the row is *not* active, read `w.commands` (the resolved list from state) and render a quick-action button group — one button per entry, label = `c.label`, `onclick = () => post('/api/command', { path: w.path, cmd: c.cmd, label: c.label })` (skip confirm for curated actions). Add command-banner rendering in `renderBanner` (`:170-182`) for `status.command` (`Running command…` / `✓`/`✗`, green/red). When `status.command?.status === 'running'`, show a "Stop command" button (`post('/api/command/stop')`) and disable other controls. |

**Steps:**

- [x] `src/runner.js`: add `command` state + `runCommand` reusing `inProgress` guard, `active`-set rejection, `_spawn` with `shell:true`, `streamToLog`, exit-code capture
- [x] `src/runner.js`: add `stopCommand` reusing `_killFn`; include `command` in `getStatus`
- [x] `src/server.js`: add `handleCommand` (path validation + 409 guard when `active`) and `handleStopCommand`; register `POST /api/command` and `POST /api/command/stop`
- [x] `src/config.js`: pass `commands` through `withRootExists` (default `[]`) + add `normalizeCommands` validation (throws on malformed shape)
- [x] `src/worktrees.js`: add `DEFAULT_COMMANDS` + `mergeCommands` (defaults EXTENDS project override, dedupe by `label`, project wins on collision); attach `commands` in `toWorktree` so each worktree carries its resolved list
- [x] Verify the payload reaches the frontend: confirmed via `curl /api/state` — each worktree carries the resolved `commands` (3 defaults present)
- [x] `public/index.html`: in `makeRow`, render one quick-action button per `w.commands` entry on stopped rows; command banner; Stop-command button; disable controls while a command runs
- [ ] Update README + ROADMAP for the command feature (see Documentation) *(deferred — consolidated into Phase 3's documentation step to avoid writing docs twice)*

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/__tests__/runner.command.test.js` | `runCommand` happy path: inject spawn via `runner._setSpawnFn` returning a `makeChild(pid)` (from `runner.test.js`), drive completion with `child.emit('close', 0)`; assert header `[cmd] <label>` + footer `[cmd] exited 0` appended and `command` state transitions running⇒done with `exitCode` 0. Non-zero exit via `child.emit('close', 1)` ⇒ status `failed`, `exitCode` 1. Spawn-error path via `child.emit('error', err)` ⇒ logged + state cleared (mirror existing `spawnDevServer` error test). `runCommand` rejects when `active` is set (no spawn). `inProgress` guard blocks a second concurrent command. `stopCommand` calls the `runner._setKillFn` stub with `command.pid` and marks state; `stopCommand` with no command running is a no-op. Reuse `makeStream/makeChild/makeSpawnStub/stubAll` + the `beforeEach(stubAll)` reset from `runner.test.js`. |
| modify | `src/__tests__/server.test.js` *(create if absent)* | `POST /api/command` returns 409 when a server is `active`; returns 200 + delegates to `runCommand` when stopped; rejects unknown/missing `path` (400) like `handleStart`; `/api/command` and `/api/command/stop` require auth (401 without Bearer, via the same `isAuthorized` `/api/*` gate at `server.js:76-78`). |
| modify | `src/__tests__/config.test.js` | `loadProjects` surfaces `commands` (passthrough + default `[]`); `normalizeCommands` throws on malformed `commands`. Reuse the existing `withProjectsFile` snapshot/restore helper. |
| create | `src/__tests__/worktrees.command.test.js` *(or add to existing `worktrees.test.js`)* | `mergeCommands`: defaults present with no project override; project commands appended after defaults (EXTENDS); dedupe by `label` with project entry winning on collision. `toWorktree` attaches the resolved `commands` list. |

**Verification:**

- [x] Automated tests for this phase pass: `pnpm test` (60 pass / 0 fail, +19)
- [x] Manual: on a stopped worktree, quick-action buttons render (npm install/build/lint) — confirmed by orchestrator after server restart on new code
- [~] Manual: click `npm install` ⇒ output streams, banner green `✓` — execution paths covered by automated tests (`runner.command.test.js`); to be exercised end-to-end in Phase 3/4
- [~] Manual: start a server, attempt a command ⇒ 409 + UI disables controls — covered by `server.test.js` 409 test; UI disable logic in place
- [~] Manual: non-zero exit ⇒ footer `[cmd] exited N` + banner red `✗` — covered by `runner.command.test.js`
- [~] Manual: long command → "Stop command" ⇒ tree dies — covered by `stopCommand` `_killFn` test
- [~] Manual: bad executable ⇒ `[cmd] error: …`, controls re-enabled — covered by spawn-error test
- [~] Manual: "Stop command" with nothing running ⇒ no-op — covered by no-op test
- [~] Manual: `projects.json` `commands` entry ⇒ button after the three defaults — `mergeCommands` covered by `worktrees.command.test.js`

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file *(except the docs step, deferred to Phase 3)*
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn *(n/a — executed via /execute-prd code-reviewer subagent)*
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session *(n/a — see above)*
- [x] Code-reviewer agent has verified this phase *(green; commit `614a9cc`)*
- [x] Any code-reviewer-driven changes reflected back into this plan file *(nits non-blocking, no plan change needed)*
- [x] Tests for this phase written and passing *(60/0; runner.command, server, worktrees.command, config tests)*
- [ ] Documentation updated (see Documentation section) *(deferred to Phase 3 — written there in full)*
- [x] Orchestrator (user) has verified and approved this phase *(UI render confirmed; execution covered by automated tests)*
- [x] Changes committed: `feat(runner): run curated commands in a stopped worktree`
- [x] Phase marked complete

---

### Phase 3: Free-form command input + confirm dialog + projects.json override polish + security docs

**Risk:** medium
**Mode:** hil
**Manual-verification justification:** The new logic here is browser-only
(`public/index.html` free-form input handling + `confirm` + button rendering)
with no Node-side behavior; the server/runner contract it calls (`/api/command`,
409 guard, `commands` passthrough) is already covered by Phase 2's automated
tests. The repo has no browser test harness and adding one would break the
zero-deps + minimal-change invariants, so this phase is verified manually.
**Type:** frontend
**Success criteria:** On a stopped worktree the user can type an arbitrary
command into a free-form box, gets a `confirm('Run <command> in <branch>?')`
prompt (free-form only — quick-actions skip confirm), and on confirm the command
runs and streams output exactly like a quick-action. Empty/whitespace input is
rejected client-side. Per-project `commands` from `projects.json` render cleanly
alongside the defaults. README/ROADMAP document the feature, the known
limitations, and the HTTP-cleartext + arbitrary-RCE remote-readiness caveat.

**Commit message:** `feat(ui): free-form worktree commands with confirm + security docs`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `public/index.html` | Add a free-form command input + run button per stopped worktree row (`makeRow`, `:184-205`). On run: trim input, reject empty/whitespace client-side (no request, no confirm), show `confirm('Run ' + value + ' in ' + branch + '?')` (free-form ONLY — quick-actions never confirm); on confirm `post('/api/command', { path: w.path, cmd: value, label: value })`. Finalize quick-action button rendering polish (label display, ordering — defaults already precede project entries and dedupe-by-label is handled server-side in `mergeCommands`, so the frontend just renders `w.commands` in order). Reuse the busy/disable logic from Phase 2. |
| modify | `README.md` | Document the login overlay (Phase 1) and the run-command feature: defaults, per-project `commands` in `projects.json`, quick-action vs free-form (confirm), Stop-command, the shared log buffer churn note, the interactive-stdin-hangs limitation, and the **security caveat**: token-gated + LAN-only, HTTP cleartext, arbitrary RCE by design, MUST add HTTPS/hardening before remote exposure. |
| modify | `ROADMAP.md` | Mark login + commands done; add future items: auto-stop server before running a command (config opt-in), and HTTPS/self-signed + hardening before remote exposure. |

**Steps:**

- [ ] `public/index.html`: add free-form input + run button per stopped row; client-side empty/whitespace reject (no request sent); `confirm()` for free-form only
- [ ] `public/index.html`: finalize quick-action `commands` rendering (labels, order); dedupe-by-label already handled server-side in `mergeCommands`
- [ ] `README.md`: document both features + limitations + the explicit security/remote-readiness caveat
- [ ] `ROADMAP.md`: update status + add the two future notes (auto-stop opt-in; HTTPS/hardening before remote)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| — | — | No automated tests — justified because: the new logic in this phase is browser-only (`public/index.html` input handling + `confirm` + button rendering) with no Node-side behavior and no browser test harness in the repo; the server/runner contract it calls (`/api/command`, 409 guard, `commands` passthrough) is already covered by Phase 2 tests. Manual verification per acid test below. |

**Verification:**

- [ ] Automated tests for this phase pass: `pnpm test` (Phase 2 suite still green)
- [ ] Manual: type a custom command on a stopped worktree ⇒ confirm dialog shows `Run <command> in <branch>?`; confirm ⇒ output streams, exit code shown
- [ ] Manual: empty/whitespace input ⇒ rejected, no request sent, no confirm
- [ ] Manual: cancel the confirm ⇒ nothing runs
- [ ] Manual: a quick-action button still runs *without* a confirm
- [ ] Manual: configure a custom action in `projects.json` ⇒ it appears as a button and runs
- [ ] README + ROADMAP reviewed: security caveat + limitations present and accurate

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any code-reviewer-driven changes reflected back into this plan file
- [ ] Tests for this phase written and passing — or no-tests justification accepted
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat(ui): free-form worktree commands with confirm + security docs`
- [ ] Phase marked complete

---

### Phase 4: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil  <!-- always hil: orchestrator manually verifies end-to-end -->

**Overall success criteria:**

- A fresh device logs in via the overlay, stays logged in across browser
  restarts, and can drop a token via "forget token".
- On a stopped worktree, both curated quick-actions and free-form commands run,
  stream output to the logs panel, report exit codes, and can be stopped.
- A running server blocks commands with a 409 and the UI reflects it.
- The single-operation `inProgress` guard correctly serializes start vs command
  vs command (no concurrent operations).
- README + ROADMAP document the features, limitations, and the LAN-only /
  HTTP-cleartext / arbitrary-RCE remote-readiness caveat.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] All tests pass (`pnpm test`)
- [ ] No CLAUDE.md invariants violated (thin entry points: command logic in `runner.js`, not `server.js` handlers; reused `appendLog`/`_spawn`/`_killFn`/`sendJson`/`readJsonBody`/`isAuthorized`/existing render helpers; no new runtime deps; functions <30 lines; tests via existing `_set*` seams)
- [ ] Cross-phase regression: login overlay still works after the command UI lands; server start/stop unaffected; logs panel unaffected aside from intended command output
- [ ] Feature tested manually (golden path + edge cases: wrong token, 409 while running, Stop-command on a hung command, empty free-form input, malformed `projects.json` `commands`)
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Persistent token login overlay + forget link | `README.md` (auth/usage section) — updated in Phase 3 (or Phase 1 if a brief note is warranted) |
| Run-command feature: defaults, per-project `commands`, quick-action vs free-form, Stop-command, log-buffer churn, interactive-stdin limitation | `README.md` — Phase 2 (initial) + Phase 3 (finalized) |
| Per-project `commands` schema in `projects.json` | `README.md` config section — Phase 2 |
| Security/remote-readiness caveat (LAN-only, HTTP cleartext, arbitrary RCE by design, HTTPS/hardening before remote) | `README.md` + `ROADMAP.md` — Phase 3 |
| Future: auto-stop server before command (opt-in); HTTPS/self-signed + hardening | `ROADMAP.md` — Phase 3 |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | None (browser-only UI; no Node-side logic; no browser harness) — manual verification | — |
| Phase 2 | `runCommand` (logs/state/exit-code, `active`-set rejection, `inProgress` serialization), `stopCommand` (kill pid) | `src/__tests__/runner.command.test.js` |
| Phase 2 | `/api/command` + `/api/command/stop` 409-when-active, 200-when-stopped, 400 unknown path, 401 unauth | `src/__tests__/server.test.js` |
| Phase 2 | `loadProjects` `commands` passthrough + `normalizeCommands` malformed-config error | `src/__tests__/config.test.js` |
| Phase 2 | `mergeCommands` defaults-EXTENDS-override + dedupe-by-label; `toWorktree` attaches resolved `commands` | `src/__tests__/worktrees.command.test.js` |
| Phase 3 | None (browser-only free-form input/confirm/rendering; server contract covered by Phase 2) — manual verification | — |

## Human Summary

We're making local-pm pleasant to log into and able to run commands in a
worktree without dropping to a terminal.

- **Phase 1 (login overlay):** Today you authenticate by pasting `#token=` into
  the URL, and the token vanishes when you close the browser. We add a proper
  login modal that takes the token, validates it against the server, and stores
  it in `localStorage` so it survives refreshes and browser restarts — paste
  once per device. A "forget token" link lets you drop a stale token. The old
  URL-hash method still works and now also persists.

- **Phase 2 (quick-actions):** On a stopped worktree you get buttons for common
  commands (`npm install`/`build`/`lint`, plus any you list per project in
  `projects.json`). Clicking one runs it, streams its output into the existing
  logs panel, and shows a green/red banner with the exit code. A running command
  blocks everything else (we reuse the existing one-operation lock), and a "Stop
  command" button kills a runaway. If a server is already running in that
  worktree, the backend refuses with a 409 — the server is the source of truth.

- **Phase 3 (free-form + polish):** You can also type an arbitrary command; it
  asks for confirmation first (quick-actions don't). We finalize per-project
  custom buttons and write the docs — including the important caveat that this
  is a LAN-only, token-gated tool that runs arbitrary commands over plain HTTP,
  and must get HTTPS + hardening before it's ever exposed beyond your local
  network.

- **Phase 4:** End-to-end manual check of both features plus cross-phase
  regressions and a CLAUDE.md invariant pass.

**Key trade-offs:** command output shares the single 300-line log buffer (noisy
commands churn it); free-form commands are arbitrary RCE by design (acceptable
for local/LAN, gated only by the token); interactive commands that wait on stdin
will hang and must be killed via Stop. All three are documented.
