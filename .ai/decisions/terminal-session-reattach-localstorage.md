# Per-worktree console descriptor persists in browser localStorage

**Decision:** One console descriptor `{ sessionId, kind }` per worktree path lives in the browser's `localStorage` under the key `localpm.termSessions`, managed by the leaf module `public/js/term-sessions.js`. No API endpoint, no server-side store, no daemon involvement.

**Why:** The backend already keeps PTY sessions alive after a WebSocket disconnect (`pty.js` `detachClient`/`attachClient`, `ws.js` known-`sessionId` routing). The only missing piece was persisting the `sessionId` across browser refreshes. A localStorage leaf mirrors the exact pattern already used for terminal macros (`term-macros.js`) and quick-nav MRU (`keynav/mru.js`): zero backend involvement, tolerant reads, swallowed write errors, no circular imports, ships without touching the daemon or its REST surface.

**`kind` IS stored alongside `sessionId`:** The server ignores `kind` on reattach (a known `sessionId` routes to `attachClient` which never reads `kind`), but the client needs it to label the recreated tab correctly and to send an honest `&kind=` on the reconnect URL. Without it, every reattached console would be relabeled "Claude" regardless of whether it was a shell. Storing `{ sessionId, kind }` (instead of bare `sessionId`) fixes this at no cost — still one entry per worktree.

**Reconnect is one-shot at first tick, lazy thereafter:** `reconnectActiveWorktree` is called once in `main.js` `tick()` after the first successful state fetch + `render()`, using the selection resolved at that moment. A module-level `reattached` guard prevents it from refiring on the 2 s poll. Only the active worktree (the one selected when the page loads) is reconnected eagerly; navigating to a different worktree reconnects it lazily through the normal `openTerminal` path. This avoids reconnecting every worktree's session on load.

**`closeTab` clears the key before group deletion:** `closeTab` is invoked exclusively from the per-tab `✕` `onclick` handler — there are no `unload`/`beforeunload`/`pagehide` handlers in `public/js`. A browser refresh therefore does NOT call `closeTab`, so the key survives a reload (correct: reconnect). Explicitly closing a tab calls `closeTab`, which calls `removeSession` before tearing down the group (correct: no resurrection). No unload guard is needed.

**Stale/reaped key is a no-error fresh spawn:** `ws.js` treats an unknown `sessionId` as a fresh spawn (`getSession` → `null` → `spawnSession`). After the 30-min idle reaper or a daemon restart, a saved key yields a brand-new console with no scrollback and no error. This is accepted behavior — documented in the plan.

**Rejected alternatives:**
- *Server-side persistence via a new `/api/*` endpoint:* buys cross-device sync at the cost of a new route, auth surface, and a schema for a key that only the browser needs. Rejected — contradicts the zero-backend principle for frontend-only state.
- *Per-tab granularity (multiple descriptors per worktree):* the app enforces one-console-per-worktree and the last `connectSession` call wins. Multi-tab tracking would add complexity with no benefit under the locked single-console model.
- *Bare `sessionId` store (no `kind`):* would mislabel every reattached shell console as "Claude" in the tab UI. Rejected in favor of the `{ sessionId, kind }` descriptor at negligible extra cost.

**Constraints it creates:**
- Sessions are per-device — they do not sync across browsers or machines.
- `term-sessions.js` must stay a leaf: no DOM, no app imports, no circular dependencies.
- The single-console assumption is locked: one descriptor per worktree path; if two tabs are open in the same worktree, the last `connectSession` call overwrites the descriptor and a single `closeTab` clears the shared key.
