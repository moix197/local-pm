# Frontend modules (`public/js`)

Native ESM, no build step. Served by `serveStatic` from `src/server.js` under
`/js/*`. The import graph is a DAG — no module imports `main.js`.

| Module | Responsibility |
|---|---|
| `app-events.js` | Leaf cycle-breaker: shared mutable state (`lastState`, `inFlight`) + registerable `onRender`/`onAuthError` callback slots with `requestRender`/`signalAuthError` wrappers. |
| `api.js` | Auth/token storage, `fetchState`/`fetchProjects`, `post`/`apiSend`/`apiSendChecked`/`refreshAfterMutation`, `projectsByName`/`projectsByRoot`. Calls `app-events.js` callbacks, never `main.js`. |
| `grouping.js` | Pure helpers: `groupByProject`, `runningPaths`, `lanUrlForPort`. Unit-tested. |
| `console-panel.js` | Lazy console log polling: `openConsoles`, `refreshConsole`, `toggleConsole`, `makeConsolePanel`. |
| `terminals.js` | xterm terminal-group lifecycle (open/connect/activate/close); imports only `api.js`. |
| `add-project.js` | Add/browse/setup + edit-project flows; `openEditRoot` state. |
| `selection.js` | Pure-ish sidebar selection/collapse state: `selected`, `collapsedProjects`, `selectItem`/`isSelected`/`toggleProjectCollapse`, and pure `resolveSelection`. Unit-tested. |
| `sidebar.js` | Left nav tree: `renderSidebar` + collapsible project rows + worktree rows + green status dots. Imports `selection.js` + `grouping.js`. |
| `main-pane.js` | Main pane for the selected item: `renderMain` (owns the three persistence invariants), `renderWorktreeView`, `updateTerminalVisibility`, plus control helpers moved from the old `views-legacy.js`. |
| `main.js` | Bootstrap: registers `app-events` callbacks, login wiring, `render` (resolve→sidebar→main→terminals), `tick`/`startPolling`, top-bar + DOM listeners. |
