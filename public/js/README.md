# Frontend modules (`public/js`)

Native ESM, no build step. Served by `serveStatic` from `src/server.js` under
`/js/*`. The import graph is a DAG — no module imports `main.js`.

| Module | Responsibility |
|---|---|
| `app-events.js` | Leaf cycle-breaker: shared mutable state (`lastState`, `inFlight`) + registerable `onRender`/`onAuthError` callback slots with `requestRender`/`signalAuthError` wrappers. |
| `api.js` | Auth/token storage, `fetchState`/`fetchProjects`, `post`/`apiSend`/`apiSendChecked`/`refreshAfterMutation`, `projectsByName`/`projectsByRoot`. Calls `app-events.js` callbacks, never `main.js`. |
| `grouping.js` | Pure helpers: `groupByProject`, `runningPaths`, `lanUrlForPort`. Unit-tested. |
| `console-panel.js` | Lazy console log polling: `openConsoles`, `refreshConsole`, `toggleConsole`, `makeConsolePanel`. |
| `terminals.js` | xterm terminal-group lifecycle (open/connect/activate/close) + per-group mobile input toolbar (quick keys + macro chips); imports `api.js` + `term-macros.js`. |
| `term-macros.js` | Leaf: localStorage CRUD for global user text macros (`loadMacros`/`addMacro`/`removeMacro`). No DOM, no app imports. |
| `add-project.js` | Add/browse/setup + edit-project flows; `openAddModal`/`closeAddModal` (the top-bar add-project `.overlay` modal); `openEditRoot` state; `removeProject` (DELETE+confirm, clears selection via `selection.js`). |
| `selection.js` | Pure-ish sidebar selection/collapse state: `selected`, `collapsedProjects`, `selectItem`/`isSelected`/`toggleProjectCollapse`, and pure `resolveSelection`. Unit-tested. |
| `sidebar.js` | Left nav tree: `renderSidebar` + collapsible project rows + worktree rows + green status dots. Imports `selection.js` + `grouping.js`. |
| `main-pane.js` | Main pane for the selected item: `renderMain` branches on selection (worktree view / project overview / empty), owns the three persistence invariants, `renderWorktreeView`, `renderProjectView` (header + dot + Edit/Remove + clickable worktree rows), `updateTerminalVisibility`, plus control helpers moved from the old `views-legacy.js`. |
| `main.js` | Bootstrap: registers `app-events` callbacks, login wiring, `render` (resolve→sidebar→main→terminals), `tick`/`startPolling`, top-bar + DOM listeners. |
| `keynav/mode.js` | Leaf: NAV/WRITING mode enum + get/set + double-Esc detector (`handleEscPress`, `isDoubleEsc`, `clearEscPending`). No DOM, no app imports. Unit-tested. |
| `keynav/desktop-gate.js` | Leaf: `isDesktop(matchMediaFn?)` — true iff viewport ≥ 769px. Accepts a matchMedia stub for unit tests. Unit-tested. |
| `keynav/mode-badge.js` | Fixed-position NAV/WRITING badge on `document.body`: `assertBadge(mode)` / `removeBadge()`. Idempotent, survives 2s poll. |
| `keynav/keynav.js` | Global capture-phase keydown scaffold: `initKeynav()` (desktop-only). NAV mode: `Enter`/`i` focuses terminal + switches to WRITING; `gt`/`gT` move to next/prev project; `↑`/`↓` move between worktrees within current project (arrows prevent page scroll). WRITING mode: double-Esc blurs terminal + returns to NAV; lone Esc propagates to xterm. |
| `keynav/traversal.js` | Pure index math over the grouped tree: `nextProject`/`prevProject`/`nextWorktree`/`prevWorktree`. Boundaries wrap. Empty tree → null. No DOM. Imports `grouping.js` only. Unit-tested. |
