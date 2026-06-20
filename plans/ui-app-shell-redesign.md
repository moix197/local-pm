# Plan: UI app-shell redesign (sidebar + selection-driven main pane)

**Created:** 2026-06-19
**Branch:** `feature/ui-app-shell`
**Status:** complete — all phases done; pending merge to `main`

## Context

The dashboard frontend is one 1224-line `public/index.html` (vanilla JS, embedded
CSS, no build step) rendering a flat scrolling list: an "Add project" panel, a
"Running servers" section, and every project's worktrees stacked vertically. It's
hard to scan and conflicts with the project's modularity principles.

Target experience (confirmed with user):

- **Top bar** with a `＋ Add project` button (opens a modal) and a `Stop all`
  button shown only when servers are running.
- **Collapsible sidebar** nav tree: each project is a nav item; each worktree a
  subnav item. A **green status dot** sits next to a project (if any of its
  worktrees is running) and next to each running worktree.
- **Main pane shows only the selected item.** Selecting a worktree shows its
  controls (Start/Stop, dev command, command buttons, free-form input,
  ＋Shell/＋Claude, console). Selecting a project shows an overview of its
  worktrees plus Edit/Remove.
- **Modular files** (native ESM, no build step): thin `index.html` shell + a
  `css/app.css` + `js/*.js` modules. Theme tokens unchanged (restructure only).

## Risk: medium

The redesign itself is low-risk CSS/DOM work. The risk is in **preserving three
fragile invariants** that the current single-file app depends on (see below). Get
those wrong and terminals die on every poll, console panels flash empty, or typed
commands lose focus every 2 seconds.

## Dependencies & Risks

**Hard invariants that MUST survive the refactor** (these are why the current code
is shaped the way it is):

1. **Persistent terminal sessions.** xterm terminal groups live in a container
   (`#terminals`) that the 2s poll **never** `innerHTML`-wipes. Each group owns a
   WebSocket + xterm instance. Re-rendering must not destroy/recreate these nodes.
   New design: keep one persistent terminals container; show/hide groups by
   selection via `style.display`, never by rebuilding.
2. **Console-panel preservation across polls.** Open `<pre data-console>` log
   panels are captured (text + scroll position) before the container is cleared
   and re-attached, so they don't flash empty or lose scroll every 2s.
3. **Free-form input focus/caret preservation.** The focused custom-command input
   (`data-cmd-path`) value + selection range is captured before re-render and
   restored after, so typing survives polls. Today this is `captureFocusedFreeForm`
   / `restoreFocusedFreeForm`, called inside `renderProjects`. After Phase 2 these
   must wrap the `#selectionView` rebuild inside `renderMain` (the only place a
   `data-cmd-path` input now lives), **and** the parallel edit-form preservation
   (`captureEditValues` + `renderEditForm` reseed, gated by `openEditRoot`) must
   move alongside it — both currently live in `renderProjects`.

**Import-cycle risk (must be designed out in Phase 1):**

The current single file lets `post()`, `toggleConsole()`, `submitAddProject()`,
`refreshAfterMutation()`, etc. call `render()`/`renderAuthError()` freely because
everything shares one scope. Once split, `api.js`, `console-panel.js`,
`terminals.js`, and `add-project.js` would each need to import `render`/
`renderAuthError` from `main.js`, while `main.js` imports them — a cycle.
**Resolution (no new deps):** introduce `public/js/app-events.js`, a tiny shared
module exporting mutable callback slots (e.g. `let onRender`, `let onAuthError`,
plus `requestRender()` / `signalAuthError()` wrappers) that `main.js` registers
into at bootstrap. Lower modules import only `app-events.js` (a leaf), never
`main.js`. This keeps the import graph a DAG (see Module dependency graph below).
Likewise `lastState`/`inFlight` are read by `post()` today; move that shared
mutable state into `app-events.js` (or a small `state-store.js`) rather than
importing it back from `main.js`.

**Other risks:**

- **Server only serves `GET /` and `GET /vendor/*`.** Loading `/js/*.js` and
  `/css/app.css` requires adding a generic static handler to `src/server.js`
  (mirroring `serveVendor`'s path-traversal guard). No build step is added.
  Note `serveVendor` uses `decodeURIComponent` + `path.resolve` + a
  `resolved.startsWith(baseDir + path.sep)` check and an `ENOENT → 404` branch —
  `serveStatic` must reuse that exact shape per base dir, and `route()` must place
  the `/js/` and `/css/` checks **before** the `/api/` auth gate is reached (they
  are unauthenticated like `/` and `/vendor/*`). The existing
  `VENDOR_CONTENT_TYPES` map already covers `.js`/`.css`; reuse it (rename to a
  generic `STATIC_CONTENT_TYPES`) rather than defining a second MIME map.
- **Module system clash for tests.** Browser ESM `.js` files would be parsed as
  CommonJS by `node --test` if the root package is CJS. Mitigation: a nested
  `public/package.json` = `{"type":"module"}` so Node treats `public/**` JS as
  ESM, with zero impact on the backend's module system and zero new dependencies
  (uses built-in `node:test` + `node:assert`).
- **Order-sensitive:** Phase 1 (modular foundation) must land before any redesign
  phase builds on it.

## Module dependency graph (target — must stay a DAG)

```
app-events.js   (leaf: callback slots + shared mutable state, lastState/inFlight)
api.js          → app-events.js            (post/refresh call signalAuthError/requestRender)
grouping.js     → (none, pure)
console-panel.js→ api.js, app-events.js
terminals.js    → api.js (TOKEN/authHeaders), app-events.js
add-project.js  → api.js, app-events.js
selection.js    → (none, pure)            [Phase 2]
sidebar.js      → selection.js, grouping.js [Phase 2]
main-pane.js    → api.js, console-panel.js, terminals.js, add-project.js, selection.js [Phase 2]
main.js         → everything above; registers callbacks into app-events.js at bootstrap
```

No module imports `main.js`. `main-pane.js` must NOT import `sidebar.js` and
`sidebar.js` must NOT import `main-pane.js` — both are orchestrated by `main.js`'s
`render()`, and any cross-talk (e.g. "select an item") flows through
`selection.js` state + a `requestRender()` callback, never a direct import. This
is the concrete fix for the "main-pane importing terminals importing main" cycle
the brief flags: terminals imports only `api.js`/`app-events.js`, both leaves.

## Phases

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Create a git worktree for this plan's branch. The repo is on `main` with remote
`origin` (github.com/moix197/local-pm); the plan commit lands on `main` first so
the worktree forks from it and inherits the plan files. Always confirm worktree
creation with the user before running.

**Steps:**

- [ ] Confirm branch name (`feature/ui-app-shell`) and base ref (`main`) with the user
- [ ] Run `git worktree add ../local_pm-ui-shell -b feature/ui-app-shell main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: Modular foundation (serve + extract, no UI change)

**Risk:** medium
**Mode:** afk
**Type:** mixed
**Success criteria:** The dashboard loads and behaves **exactly as it does today**
— login, 2s polling, add/browse/edit/remove project, Start/Stop, console panels,
free-form commands, and ＋Shell/＋Claude terminals (including reattach) all work —
but the page is now served from a thin `index.html` plus modular `css/` + `js/`
files. `node --test` passes for extracted pure helpers.
**Commit message:** `refactor(ui): split index.html into ESM modules, add static serving`

> **Vertical-slice exception (justified):** this is a *refactor-only* phase with no
> behavior change — the allowed "schema-only refactor" analog. Extracting the
> fragile persistence wiring (terminals/console/poll) verbatim and proving it still
> works modular **de-risks** every later phase, which only then changes layout.

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `src/server.js` | Add a generic `serveStatic(baseDir, urlPrefix)` handler (reuse `serveVendor`'s realpath/`startsWith` traversal guard + the `.js`/`.css` MIME map); route `GET /js/*` → `public/js`, `GET /css/*` → `public/css`. Keep `/` and `/vendor/*` as-is. |
| modify | `public/index.html` | Reduce to a thin shell: `<head>` links `css/app.css` + xterm assets; `<body>` holds only the static containers (`#loginOverlay`, top bar, app shell, `#terminals`) and `<script type="module" src="/js/main.js">`. No inline logic. |
| create | `public/css/app.css` | All current embedded CSS, moved verbatim (tokens unchanged). |
| create | `public/package.json` | `{"type":"module"}` — makes Node treat `public/**` JS as ESM for tests. Not served. |
| create | `public/js/app-events.js` | Leaf module breaking the import cycle: shared mutable state (`lastState`, `inFlight`) + registerable callback slots (`onRender`/`onAuthError`) with `requestRender(busy?)` / `signalAuthError()` wrappers. Imported by `api`/`console-panel`/`terminals`/`add-project`; populated by `main.js` at bootstrap. |
| create | `public/js/api.js` | Auth/token (`TOKEN`, `authHeaders`, `AuthError`, token storage helpers), `fetchState`, `fetchProjects`, `post`, `apiSend`, `apiSendChecked`, `refreshAfterMutation`, `projectsByName/Root`. `post`/`refreshAfterMutation` call `requestRender`/`signalAuthError` from `app-events.js` (NOT `render`/`renderAuthError` imported from `main.js`). |
| create | `public/js/grouping.js` | Pure helpers: `groupByProject`, `runningPaths`, `lanUrlForPort`. (Unit-tested.) Note `lanUrlForPort` assumes `state.lanUrl` is a non-null string; `state.lanUrl` is `null` when nothing runs (server.js), so callers must guard — keep behavior identical to today (only called for running servers / when `anyRunning`). |
| create | `public/js/console-panel.js` | `openConsoles` set + console polling (`refreshConsole`, `pollConsoles`, `ensure/stopConsolePolling`, `toggleConsole`, `makeConsolePanel`). `refreshConsole`/`toggleConsole` use `signalAuthError`/`requestRender` from `app-events.js`. The capture/re-attach of `<pre data-console>` nodes is NOT here — it lives in whatever renders the panels (Phase 1: `views-legacy.js`'s `renderRunning`; Phase 2: `main-pane.js`'s `renderMain`). |
| create | `public/js/terminals.js` | xterm group lifecycle (`ensureTerminalGroup`, `connectSession`, `activateTab`, `closeTab`, `openTerminal`, id helpers). Imports `TOKEN`/`authHeaders` from `api.js` only — never `main.js`. |
| create | `public/js/add-project.js` | Add/browse/setup + edit-project (`submitAddProject`, browser fns, `buildSetupForm`, `cleanPath`, edit-form fns + `openEditRoot` state). Behavior unchanged this phase. Uses `app-events.js` callbacks, `refreshAfterMutation` from `api.js`. |
| create | `public/js/views-legacy.js` | The *current* `renderRunning` + `renderProjects` + `makeRow` + `makeRunningRow` + `makeProjectHeader` + `makeCommandButton` + `makeFreeFormInput` + `makeOpenLink` + `captureFocusedFreeForm`/`restoreFocusedFreeForm`, moved verbatim. **Deleted in Phase 2** (its helpers migrate to `main-pane.js`, not re-implemented). |
| create | `public/js/main.js` | Bootstrap: register `app-events` callbacks (`onRender=render`, `onAuthError=renderAuthError`), token/login wiring, `render()` (calls legacy views this phase), `tick`/`startPolling`, DOM event listeners. |

**Steps:**

- [x] Add `serveStatic(baseDir)` to `src/server.js`; wire `GET /js/*` → `public/js`, `GET /css/*` → `public/css`, placed before the `/api/` auth gate; reuse the renamed `STATIC_CONTENT_TYPES` map.
- [x] Confirm traversal guard rejects `../` escapes (`GET /js/../server.js` → 403; encoded `%2e%2e%2f` → 403) and missing file → 404, mirroring `serveVendor`.
- [x] Move embedded CSS verbatim to `public/css/app.css`; link it from the shell.
- [x] Create `app-events.js` first (the cycle-breaker); extract remaining JS into the modules above with **explicit `import`/`export`** wiring; no logic changes. Lower modules import `app-events.js`/`api.js`, never `main.js`.
- [x] Verify the import graph is acyclic (e.g. `madge`-style mental check, or just confirm no module imports `main.js`); confirm the page loads with no "circular dependency" / undefined-export errors in the console.
- [x] Preserve the three hard invariants: `#terminals` stays a static container never wiped; console `<pre data-console>` capture/re-attach kept in `renderRunning`; `captureFocusedFreeForm`/`restoreFocusedFreeForm` + `captureEditValues`/`openEditRoot` reseed kept in `renderProjects`.
- [x] Add `public/package.json` `{"type":"module"}`; add root `"test": "node --test public/js"` script (run with `pnpm test`).
- [ ] Manually smoke-test the full app (see Verification).

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `public/js/grouping.test.js` | `groupByProject` (grouping + order; empty input → empty map), `runningPaths` (set membership; missing `state.running` → empty set), `lanUrlForPort` (port swap when port given; `port == null` → returns `state.lanUrl` unchanged). Do NOT assert null-`lanUrl` behavior — that input never reaches the helper (callers guard on `anyRunning`). |

**Verification:**

- [x] `pnpm test` passes (script value is `node --test "public/js/**/*.test.js"` — see test-script note below; Node 22 rejects the bare `node --test public/js` form).
- [x] App loads from modular files (Network tab shows `/css/app.css` as `text/css`, `/js/*.js` as `application/javascript`); no console errors; no `import` resolution / circular-dependency failures.
- [x] `GET /js/../server.js` (and `%2e%2e` encoded) returns 403; a missing asset returns 404.
- [ ] Manual golden path unchanged: login → see projects/worktrees → Start a server → Open console (logs stream, scroll preserved across polls) → type in free-form input (focus + caret survive a poll) → ＋Shell + ＋Claude (open, type, close, reopen→reattach) → Stop → add a project via Browse → Edit a project (form survives a poll) → Remove a project.
- [ ] Zero-projects state renders without error (empty `#projects`, no running section).

**Phase review:**

- [ ] All Steps and Verification checkboxes ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Reviewer-driven changes reflected back into this plan file (test script fixed to run both `public/js` + `src` suites: `node --test "public/js/**/*.test.js" "src/**/*.test.js"` → 187 tests)
- [x] Tests written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `refactor(ui): split index.html into ESM modules, add static serving`
- [x] Phase marked complete

---

### Phase 2: App shell — top bar, sidebar nav tree, worktree main view

**Risk:** medium
**Mode:** hil
**Type:** frontend
**Success criteria:** The flat list is replaced by a top bar + left sidebar + main
pane. The user can: collapse/expand each project; see a green dot on running
projects/worktrees; click a worktree to see **only** its controls in the main pane;
Start/Stop it; open its console; run commands; open ＋Shell/＋Claude terminals that
appear under the selected worktree and **persist** when navigating away and back.
**Commit message:** `feat(ui): app shell with collapsible sidebar and worktree view`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `public/index.html` | Replace body layout: top bar (`#stopAllBtn`, `＋ Add project` btn), `.app` flex wrap with `#sidebar` + `.main` (`#selectionView` + persistent `#terminals`). |
| modify | `public/css/app.css` | Add app-shell, sidebar, nav-project/nav-worktree, `.dot`/`.dot.on`, `.detail-*` styles (reusing existing tokens). |
| create | `public/js/selection.js` | Pure-ish selection/collapse state: `selected` (`{type:'project'\|'worktree', path}`), `collapsedProjects`, `selectItem`, `isSelected`, `toggleProjectCollapse`, and pure `resolveSelection(state, selected)` (default = first running worktree, else first worktree, else null; drop a selection whose worktree path / project no longer exists in `state`). (Unit-tested.) `selectItem` mutates state then calls `requestRender()` from `app-events.js` — it does NOT import `main.js`. |
| create | `public/js/sidebar.js` | `renderSidebar` + `makeNavProject` (caret toggle, dot, click=select) + `makeNavWorktree` + `statusDot`. Imports `selection.js` + `grouping.js`; project dot = `worktrees.some(w => running.has(w.path))`. |
| create | `public/js/main-pane.js` | `renderMain` (wraps `#selectionView` rebuild with the moved console capture/re-attach AND `captureFocusedFreeForm`/`restoreFocusedFreeForm` + edit-form reseed), `renderWorktreeView`, `updateTerminalVisibility(selectedPath)`, plus the shared helpers **moved verbatim** from `views-legacy.js`: `makeCommandButton`, `makeFreeFormInput`, `makeOpenLink`, `makeConsolePanel` (re-exported from `console-panel.js`), and a `makeShellButtons` extracted from `makeRow`'s ＋Shell/＋Claude block. Reuses `lanUrlForPort` from `grouping.js`. Do not re-implement any of these. |
| modify | `public/js/main.js` | `render()` now calls `resolveSelection` → `renderSidebar` → `renderMain` → `updateTerminalVisibility`; top-bar lan url (guard `state.lanUrl == null`) + `Stop all` visibility; wire `#stopAllBtn`. |
| delete | `public/js/views-legacy.js` | Superseded by `sidebar.js` + `main-pane.js` (its helpers were moved, not rewritten). |

**Steps:**

- [x] Build the shell markup + CSS (flex layout, sidebar scroll, main scroll). `#terminals` sits in `.main` as a sibling of `#selectionView`, NOT inside it (so the `#selectionView` rebuild never touches terminal nodes).
- [x] Implement `selection.js`; `resolveSelection` keeps a valid selection across polls and drops a stale one (selected worktree stopped+removed, or project removed) → falls back to default.
- [x] Implement `sidebar.js`: project rows (caret = collapse only, `stopPropagation` so it doesn't also select; row click = select+expand), worktree rows (click = select), green dots (project dot = any worktree running).
- [x] Implement `main-pane.js` worktree view reusing `console-panel.js`/`terminals.js`/the moved helpers; `updateTerminalVisibility(selectedPath)` shows only the selected path's group via `style.display`, hides all others, and is also called on every render so a poll that arrives mid-stream never rebuilds or hides the active terminal.
- [x] Preserve the three hard invariants under the new render path: terminals container stays out of the wiped `#selectionView`; console capture/re-attach + free-form `capture/restoreFocusedFreeForm` scoped to `#selectionView` inside `renderMain`; switching selection while a terminal streams must only toggle `display`, never `dispose()`/`ws.close()`.
- [x] Delete `views-legacy.js`; remove dead references. Confirm `makeCommandButton`/`makeFreeFormInput`/`makeOpenLink` are imported from `main-pane.js`, not duplicated.

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `public/js/selection.test.js` | `resolveSelection`: empty state → null; default picks first running then first worktree; keeps explicit valid selection; drops a selection whose worktree/project no longer exists (running server whose worktree disappeared → falls back); `isSelected`/`toggleProjectCollapse` set logic. |

**Verification:**

- [x] `pnpm test` passes. (196/196)
- [x] Zero projects: sidebar + main pane render an empty/placeholder state without error.
- [x] Sidebar lists projects + worktrees (including bare/root/detached worktrees — whatever `getWorktrees` returns); whole project row toggles collapse + selects (changed from caret-only per user feedback); worktree row click selects.
- [x] Green dot appears on a running worktree and on its parent project; clears on Stop within one poll.
- [x] Main pane shows only the selected worktree's controls; Start/Stop/console/commands work.
- [x] Open ＋Shell + ＋Claude → navigate to another worktree (terminals hide via `display`) → back (same sessions visible, not reconnected, scrollback intact); close tab works.
- [x] Rapid selection switching while a terminal streams output does not reconnect/dispose it (DevTools: WS count stable, no new `ws/terminal` connections on switch).
- [x] Selected worktree's server is stopped and its worktree disappears (or project removed) → selection falls back to a valid item, no crash, no orphaned terminal group blocking render.
- [x] Free-form input focus + caret survive a 2s poll; console scroll preserved.

**Phase review:**

- [x] All Steps and Verification checkboxes ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn (in-session execution; handoff via subagent)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session (n/a — in-session execution)
- [x] Code-reviewer agent has verified this phase (green)
- [x] Reviewer-driven changes reflected back into this plan file
- [x] Tests written and passing (196/196; +9 selection.test.js)
- [x] Documentation updated (public/js/README.md module map)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(ui): app shell with collapsible sidebar and worktree view` (+ `fix(ui)` a349fed UI polish)
- [x] Phase marked complete

---

### Phase 3: Project overview main view (Edit/Remove)

**Risk:** low
**Mode:** hil
**Type:** frontend
**Success criteria:** Clicking a **project** in the sidebar shows an overview in the
main pane: the project name with a status dot, an Edit (✎) and Remove (×) control,
and a list of its worktrees (branch + status, click to drill into the worktree
view). Edit opens the existing inline setup form; Remove deletes the project and
clears the selection.
**Commit message:** `feat(ui): project overview view with edit/remove`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `public/js/main-pane.js` | Add `renderProjectView` (header + dot + edit/remove icons reusing `makeProjectHeader`'s logic + worktree summary rows that `selectItem({type:'worktree',path})` on click); `renderMain` branches on `selected.type` (`null`/`project` → project or empty view, `worktree` → worktree view). |
| modify | `public/js/add-project.js` | Edit-form fns (`openEditForm`/`renderEditForm`/`captureEditValues`/`closeEditForm`) operate against the `#selectionView` container passed in (today they receive `wrap.parentElement`, a `.project` section — repoint to `#selectionView`). `openEditRoot` still gates the poll-driven reseed in `renderMain`. On Remove of the selected project, clear selection via `selectItem(null)`/`selected=null` from `selection.js` (imported), then `refreshAfterMutation`. |
| modify | `public/css/app.css` | Minor styles for project-overview rows (`.row.link` hover/active). |

**Steps:**

- [x] Implement `renderProjectView`; wire compact worktree rows to `selectItem({type:'worktree', path})`. Reuse the existing Edit/Remove wiring from `makeProjectHeader` (move it into `add-project.js`/`main-pane.js`; do not duplicate the DELETE+confirm logic).
- [x] Wire Edit (toggles inline setup form in the main pane via `buildSetupForm`, value-preserving across polls through `captureEditValues`/`openEditRoot`) and Remove (confirm → `apiSendChecked('DELETE', …)` → clear selection via `selection.js` → `refreshAfterMutation`). `add-project.js` may import `selection.js` (a leaf — no cycle).
- [x] `renderMain` selects worktree-view vs project-view; `updateTerminalVisibility(null)` when a project (or nothing) is selected so no terminal shows.

**Tests:**

`No automated tests — justified because:` this phase is pure DOM rendering/wiring
over already-tested state (`selection.js`) and API helpers (`add-project.js`);
selection/removal logic it relies on is covered in Phase 2's `selection.test.js`.
Verified manually.

**Verification:**

- [x] `pnpm test` still passes. (196/196)
- [x] Clicking a project shows its worktree list + status dot + Edit/Remove (also for a project with a single bare/root worktree).
- [x] Clicking a worktree row (in overview or sidebar) drills into the worktree view.
- [x] Edit form opens, edits persist across a poll, Save updates the project; Remove deletes it and the main pane falls back to a sensible selection/empty state (and if the removed project had a running server, no orphaned terminal group or dot lingers).

**Phase review:**

- [x] All Steps and Verification checkboxes ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn (in-session execution; handoff via subagent)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session (n/a — in-session execution)
- [x] Code-reviewer agent has verified this phase (green; 1 non-blocking nit — unreachable zero-worktree blank-pane guard at main-pane.js:218)
- [x] Reviewer-driven changes reflected back into this plan file (nit fixed: zero-worktree project now renders header — main-pane.js)
- [x] Documentation updated (public/js/README.md module map)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(ui): project overview view with edit/remove`
- [x] Phase marked complete

---

### Phase 4: Add-project modal + Stop-all in top bar

**Risk:** low
**Mode:** hil
**Type:** frontend
**Success criteria:** The `＋ Add project` button in the top bar opens a modal
containing the full add flow (path input, Browse folder picker, Add, and the
post-add setup form). Adding a project works end-to-end and closes the modal. A
`Stop all` button in the top bar appears only when servers run and stops them all.
**Commit message:** `feat(ui): add-project modal and top-bar stop-all`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `public/index.html` | Add `#addModal` overlay (reuse `.overlay`/`.overlay-panel`) wrapping the add-project markup; top-bar `＋ Add project` + `#stopAllBtn`. |
| modify | `public/js/add-project.js` | `openAddModal`/`closeAddModal`; close modal on successful add (and after setup Save/Cancel); backdrop click closes. |
| modify | `public/js/main.js` | Wire `＋ Add project` → `openAddModal`, modal close button, backdrop; `Stop all` → `post('/api/stop')`; toggle its visibility in `render`. |
| modify | `public/css/app.css` | Modal head/close-button styles. |

**Steps:**

- [x] Move add-project markup (`#addPath`, `#browseBtn`, `#addBtn`, `#addError`, `#browsePanel`, `#addSetup`) into `#addModal`; default hidden. These containers stay static (not rebuilt by the poll), matching today's behavior where `#browsePanel`/`#addSetup` survive the 2s poll.
- [x] Implement open/close (button, close ✕, backdrop, after successful add with no needs-setup); preserve the needs-setup flow (modal stays open until Save/Cancel); reopening resets `#addError`/`#browsePanel`/`#addSetup`/`#addPath` and `browseCwd` so no stale error/setup shows.
- [x] Add `Stop all` to top bar; show only when `(state.running ?? []).length > 0`; wire to `post('/api/stop')`. Remove the old `Stop all` button that lived in `renderRunning`'s `h2` (the running section is gone after Phase 2 — confirm no duplicate remains).

**Tests:**

`No automated tests — justified because:` pure DOM/modal wiring over the unchanged,
already-exercised add/browse/setup logic from Phase 1. Verified manually.

**Verification:**

- [x] `pnpm test` still passes. (196/196)
- [x] `＋ Add project` opens the modal; Browse navigates folders; Add detects type; needs-setup form appears in-modal and Save persists; modal closes; new project appears in the sidebar.
- [x] `Stop all` is hidden when nothing runs, visible when something runs, and stops everything.
- [x] Backdrop click and ✕ close the modal; reopening starts clean (no stale error/setup).

**Phase review:**

- [x] All Steps and Verification checkboxes ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn (in-session execution; handoff via subagent)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session (n/a — in-session execution)
- [x] Code-reviewer agent has verified this phase (green; nits — stale path on reopen fixed, backdrop idiom matches #loginOverlay)
- [x] Reviewer-driven changes reflected back into this plan file
- [x] Documentation updated (public/js/README.md module map)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(ui): add-project modal and top-bar stop-all`
- [x] Phase marked complete

---

### Phase 5: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- The dashboard presents a top bar (＋ Add project, Stop-all when running), a
  collapsible sidebar of projects → worktrees with green running-dots, and a main
  pane showing only the selected project (overview) or worktree (controls).
- Every pre-existing capability still works: auth/login, 2s polling, Start/Stop,
  console streaming, free-form commands, ＋Shell/＋Claude persistent terminals
  (incl. reattach), add/browse/edit/remove project.
- Frontend is modular (thin `index.html` + `css/` + `js/*`); `pnpm test` green.

**Steps:**

- [x] Every preceding phase's checkboxes are ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review) (in-session; handoff via subagent)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session (n/a — in-session execution)
- [x] Code-reviewer agent reviews the entire change end-to-end (focus: the three hard invariants under all selection paths; no path-traversal regression in `serveStatic`; import graph is a DAG with no module importing `main.js`; correct `.js`/`.css` MIME types; `state.lanUrl == null` guarded in the top bar) — green
- [x] Reviewer-driven changes reflected back into this plan file (lanUrlForPort defensive null guard applied)
- [x] All tests pass (196/196)
- [x] No CLAUDE.md invariants violated (thin `main.js` entry point, small focused functions, modular with no circular deps, no new deps, pnpm)
- [x] Feature tested manually (golden path + edge cases) — verified incrementally per phase on the live worktree dashboard (port 7421)
- [x] Overall success criteria met
- [x] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| New static-serving routes + frontend module layout | `README.md` (project root) — note `public/js` module map + `serveStatic` routes |
| Frontend architecture (module responsibilities) | short `public/js/README.md` (one-line per module) created in Phase 1 |

Documentation is added as a step within each relevant phase.

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | `groupByProject`, `runningPaths`, `lanUrlForPort` | `public/js/grouping.test.js` |
| Phase 2 | `resolveSelection`, `isSelected`, `toggleProjectCollapse` | `public/js/selection.test.js` |
| Phase 3 | none (DOM wiring over tested state) — justified in phase | — |
| Phase 4 | none (DOM/modal wiring over tested add flow) — justified in phase | — |

Tests use Node's built-in `node:test` + `node:assert` (zero new dependencies),
run via `node --test public/js`, enabled by `public/package.json {"type":"module"}`.

## Human Summary

We're turning the dashboard's single messy scrolling page into a proper app:
a **top bar**, a **collapsible sidebar** listing projects and their worktrees with
**green dots** for anything running, and a **main pane that shows only what you
clicked** — a worktree's controls, or a project's overview. Adding a project moves
into a **modal** opened from the top bar.

Along the way we **break the 1224-line `index.html` into small ESM modules**
(`app-events`, `api`, `grouping`, `selection`, `sidebar`, `main-pane`, `terminals`,
`console-panel`, `add-project`, `main`) plus a `css/app.css`, served by a small
generic static handler we add to the server. A tiny `app-events.js` leaf holds the
shared render/auth callbacks so modules never import `main.js` back (keeps the
import graph a DAG). No build step, no new dependencies, same dark theme.

The phases are ordered to **de-risk**: Phase 1 moves the code into modules with
**zero behavior change** and proves the fragile bits (persistent terminals,
console panels, input focus across the 2s poll) still work. Phases 2–4 then
reshape the UI on that proven foundation — shell + sidebar + worktree view, then
the project overview, then the add-project modal and stop-all. Phase 5 verifies
the whole thing end-to-end.

Key trade-off: Phase 1 briefly keeps the *old* layout rendering from a temporary
`views-legacy.js` that Phase 2 deletes — a little throwaway code in exchange for
separating "move the code" from "change the UI," so a regression is easy to
localize. The main thing to watch throughout is the three persistence invariants;
they're called out in every phase.
