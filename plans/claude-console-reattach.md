# Plan: Claude console reattach across browser refresh

**Created:** 2026-06-30
**Branch:** feat/claude-console-reattach
**Status:** complete

## Context

Claude consoles embedded per git-worktree in the local-pm UI lose their
conversation on browser refresh, and the orphaned PTY makes `/resume`
unhelpful. The backend **already** keeps the PTY+claude alive after WS close and
supports reattach + scrollback replay (`pty.js` `detachClient`/`attachClient`,
`ws.js` known-`sessionId` routing). The only gap is on the client: the reattach
key (`sessionId`) is browser-memory-only — minted fresh in `openTerminal`
(`terminals.js:252`) with no persistence and no reconnect-on-load — so a refresh
discards it, orphans the live PTY (until the 30-min reaper), and spawns a
brand-new claude.

This plan closes that gap in two vertical slices:

1. Persist one console **descriptor** (`{ sessionId, kind }`) per worktree in
   `localStorage` (mirroring the `term-macros` / `keynav/mru` leaf-module
   precedent) and, on load, reconnect the active worktree's console to its
   still-running PTY so the conversation + scrollback come back with no new
   claude spawned, and the recreated tab is **labeled with the saved `kind`**
   (not blindly "Claude").
2. Make backend session teardown graceful so claude finalizes its session JSONL
   on app/console close, hardening native `/resume`.

**Explicitly out of scope (verified, do not re-litigate):** cwd normalization
(claude already canonicalizes the forward-slash git cwd into the same
per-worktree `~/.claude/projects/<bucket>` a normal terminal uses — sessions are
already on disk and resumable; **do not touch `src/worktrees.js`**); any
`--session-id` / auto-resume / continuity flags (the user runs `/resume`
themselves).

## Risk: medium

Phase 1 is low-risk additive frontend work on a well-isolated pattern. Phase 2
touches process-kill semantics on Windows ConPTY where a graceful path must still
**guarantee** the process dies and must not stall daemon shutdown — that is the
medium-risk part.

## Dependencies & Risks

- **`closeTab` clears the saved key — verified safe.** `closeTab`
  (`terminals.js:227-248`) is invoked from exactly one place: the per-tab `✕`
  `closeX.onclick` (`terminals.js:279`). A grep of `public/js` finds **no**
  `unload` / `beforeunload` / `pagehide` handler anywhere, so a browser reload
  does **not** call `closeTab`. Therefore clearing the saved `sessionId` inside
  `closeTab` correctly distinguishes explicit close (key removed → no
  resurrection) from reload (key survives → reconnect). No unload guard needed.
- **Stale/reaped `sessionId` is tolerated by design.** `ws.js:124` treats an
  unknown `sessionId` as a fresh spawn (`getSession` → `null` → `spawnSession`),
  so a dead key yields a fresh console (scrollback lost, no error). Accepted
  behavior — documented in the decision doc.
- **Single-console assumption (locked).** One descriptor is persisted per
  worktree. If a user opens two tabs in the same worktree, the last connect wins
  and a single `closeTab` clears the shared key. Accepted per the locked
  "one console per worktree" decision.
- **Reconnect must target the active worktree *at fire time* and fire once.**
  `reconnectActiveWorktree` is dispatched from `tick()` only **after the first
  successful state fetch + `render()`** resolves the selection and worktree paths
  (`main.js:116-127`). A module-level one-shot guard ensures it never refires on
  the 2 s poll. Because the user may navigate before/after that first tick, the
  one-shot reads the **currently-resolved** selection (`selected`) at dispatch
  and no-ops unless it's a `worktree`. Navigating to a *different* worktree later
  does **not** reattach — the normal open path calls `openTerminal` with a fresh
  `newSessionId()` and never consults the store, so it spawns a new console
  (load-time bootstrap is the only reattach trigger; later-navigation reattach
  was out of scope). No timing window resurrects the wrong worktree's console.
- **Group-deletion cleanup (no dangling key).** `closeTab` removes the persisted
  descriptor *before* it deletes the group on last-tab close (`terminals.js:236-244`),
  so the `localpm.termSessions` entry never outlives its group.
- **`kind` IS persisted alongside `sessionId` (resolved).** The server
  **ignores `kind` on reattach** — a known `sessionId` routes to `attachClient`
  (`ws.js:125-129`), which never reads kind, while the *client* still labels the
  recreated tab and sends `&kind=` on the reconnect URL. A bare-`sessionId` store
  would therefore force every reconnected console to `kind: 'claude'`,
  mislabeling a reattached shell as "Claude" in the tab. The store value is
  therefore the descriptor `{ sessionId, kind }` (still exactly **one entry per
  worktree** — richer value, same single-console shape), and reconnect passes the
  saved `kind` straight into `openTerminal`. This keeps the recreated tab's label
  truthful and its `&kind=` query honest; on the backend it's inert (reattach
  ignores it) but it costs nothing and avoids a future shell-console regression.
- **Shutdown-path location correction.** The prompt referenced "the daemon
  shutdown path in `server.js`" — there is **none**. The kill paths all live in
  `pty.js`: `killSession` (`pty.js:145-150`), the 60s reaper
  (`pty.js:163-177`, calls `killSession` at 169), and `shutdown()`
  (`pty.js:189-197`, loops `killSession` at 195, wired to SIGINT/SIGTERM at
  199-200). Phase 2 therefore routes graceful teardown through `pty.js` only;
  `server.js` is untouched.
- **SIGINT timing risk (Phase 2).** Graceful exit needs an async grace period
  (write exit sequence → wait → force-kill if alive). On SIGINT/SIGTERM
  `shutdown()` must still terminate promptly and **guarantee** every PTY dies
  (Windows ConPTY zombies are the failure mode). Mitigation in Phase 2: keep a
  hard force-kill fallback; on process-exit shutdown, attempt the graceful write
  but do not block indefinitely.
- **Reaper must stay bounded (Phase 2).** Graceful teardown must not leak
  pending timers or leave a session in the map past its kill; track and clear
  any pending grace timer so `MAX_SESSIONS = 10` stays enforceable.

## Phases

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Create a git worktree for this plan's branch. Always confirm worktree creation
with the user before running.

**Steps:**

- [ ] Confirm branch name (`feat/claude-console-reattach`) and base ref (`main`) with the user
- [ ] Run `git worktree add ../local_pm-claude-console-reattach -b feat/claude-console-reattach main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: Refresh continuity via persisted reattach

**Risk:** low
**Mode:** afk
**Type:** frontend
**Success criteria:** With a live Claude console open in the selected worktree,
the user refreshes the browser and the **same** conversation + scrollback return
in the same worktree, with **no** new claude process spawned. Explicitly closing
the tab (`✕`) and then reloading does **not** resurrect the console.
**Commit message:** `feat(ui): persist + reconnect per-worktree console sessionId across refresh`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `public/js/term-sessions.js` | Leaf localStorage module (key `localpm.termSessions`); `{ [worktreePath]: { sessionId, kind } }` map with `loadSessions`/`getSession`/`setSession`/`removeSession`, tolerant try/catch, no app imports |
| modify | `public/js/terminals.js` | `openTerminal` accepts optional `sessionId`; persist `{ sessionId, kind }` on connect in `connectSession`; clear in `closeTab` (before group deletion); new exported `reconnectActiveWorktree(worktreePath)` that replays with the saved `kind` |
| modify | `public/js/main.js` | One-shot call to `reconnectActiveWorktree` after the first successful `tick` render, using the resolved selection's path |
| create | `public/js/term-sessions.test.js` | Unit tests for the leaf store (mirrors `term-macros.test.js`) |
| create | `.ai/decisions/terminal-session-reattach-localstorage.md` | Decision doc (mirrors `terminal-macros-localstorage.md`) |
| modify | `.ai/index.md` | Add `term-sessions` to the dashboard row's Related docs / module map |
| modify | `public/js/README.md` | One row documenting `term-sessions.js` responsibility |

**Steps:**

- [x] Create `public/js/term-sessions.js` as a leaf module: `STORAGE_KEY = 'localpm.termSessions'`; `loadSessions()` tolerant read → `{}` on corrupt/missing, keeping only entries whose key is a string path and whose value is a descriptor `{ sessionId: string, kind: string }` (drop anything malformed); `getSession(path)` → descriptor or `null`; `setSession(path, sessionId, kind)` (overwrites — one descriptor per path); `removeSession(path)`; quota/disabled-storage swallowed on write — copy the tolerance shape from `term-macros.js` / `keynav/mru.js` exactly. No DOM, no app imports.
- [x] In `terminals.js`, change `openTerminal(worktreePath, kind)` → `openTerminal(worktreePath, kind, sessionId = newSessionId())` so a caller can supply a saved id; keep the existing `newSessionId()` default for the `+ Shell` / `+ Claude` buttons (`main-pane.js:78-79` unchanged).
- [x] In `terminals.js` `connectSession(group, sessionId)`, after the socket is created, persist via `setSession(group.worktreePath, sessionId, sess.kind)` (`sess.kind` is already on the session object — line 194). This single call covers first-open and the background-tab reattach (`activateTab:217`) — idempotent, single-console, and records the real kind so a reconnected shell is not relabeled "Claude".
- [x] In `terminals.js` `closeTab(group, sessionId)`, call `removeSession(group.worktreePath)` **before** the last-tab `group.root.remove()` / `terminalGroups.delete` branch (`terminals.js:236-244`) so an explicit user close does not resurrect on next load and leaves no descriptor dangling past its group (verified: `closeTab` has no unload caller).
- [x] Add exported `reconnectActiveWorktree(worktreePath)` in `terminals.js`: no-op if `worktreePath` is falsy, a group already exists for it (`terminalGroups.has`), or `getSession(worktreePath)` is empty; otherwise read the saved descriptor and call `openTerminal(worktreePath, saved.kind, saved.sessionId)` so the server replays scrollback into a correctly-labeled tab. Keep it a small focused function; the existing `openTerminal` does the heavy lifting (thin-entry-point principle).
- [x] In `main.js`, add a module-level one-shot guard (`let reattached = false`) and, inside `tick()` after `render(lastState)`, fire the reconnect **once** against the **currently-resolved** selection at that moment: `if (!reattached) { reattached = true; reconnectActiveWorktree(selected?.type === 'worktree' ? selected.path : null); }` (`selected` is already imported from `selection.js`). This runs after the first successful tick when worktree paths + the resolved selection are known (`main.js:116-127`), targets whatever worktree is active *at fire time*, and never refires on the 2 s poll. No business logic inline — `main.js` only invokes the helper.
- [x] Write `public/js/term-sessions.test.js` (node:test + node:assert/strict, localStorage stub copied from `term-macros.test.js`).
- [x] Author `.ai/decisions/terminal-session-reattach-localstorage.md` and update `.ai/index.md` + `public/js/README.md` (see Documentation / Knowledge Base Impact).

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `public/js/term-sessions.test.js` | `loadSessions`/`getSession`/`setSession`/`removeSession`: descriptor round-trip (`{ sessionId, kind }`), overwrite (single descriptor per path), `removeSession` clears, corrupt/missing → `{}`, malformed entries (bare string, missing `kind`) dropped on load, write swallowed when `setItem` throws |

The `openTerminal`/`connectSession`/`reconnectActiveWorktree` DOM+WS
orchestration is verified manually (acid test) — consistent with the existing
untested DOM-heavy `terminals.js`; all extractable logic lives in the tested
leaf `term-sessions.js`.

**Verification:**

- [x] Automated tests for this phase pass: `pnpm test`
- [ ] Manual acid test: open a Claude console in a worktree, hold a short conversation, refresh the browser → same conversation + scrollback return in that worktree
- [ ] Confirm via Task Manager / process list that **no** duplicate/orphaned claude was spawned by the refresh (the pre-refresh PID is reused)
- [ ] Confirm reload does **not** clear the key but explicit `✕` close **does**: reload keeps the conversation; closing the tab then reloading does **not** resurrect (`localpm.termSessions` no longer has that path, and the entry is gone immediately on last-tab close — no dangling descriptor)
- [ ] Confirm a reconnected **shell** console keeps its label (open a `+ Shell`, refresh) — proves `kind` is persisted, not defaulted to "Claude"
- [ ] Confirm a stale/reaped key is a no-error fresh spawn: after the 30-min reaper (or a daemon restart) reload yields a brand-new console with **no scrollback and no error** (accepted behavior — `ws.js:124` treats the unknown id as a fresh spawn)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase (verdict: green; 3 nits, none blocking)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (corrected "lazy reconnect" wording → load-time bootstrap only)
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(ui): persist + reconnect per-worktree console sessionId across refresh`
- [x] Phase marked complete

---

### Phase 2: Graceful session finalize on exit

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** After a conversation, the user closes the console/app;
reopening a console in that worktree and running `/resume` lists the session and
resumes cleanly. The PTY process actually terminates (no zombie ConPTY), and the
idle reaper stays bounded.
**Commit message:** `feat(pty): graceful claude exit before force-kill to finalize session JSONL`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `src/pty.js` | Replace immediate `ptyProcess.kill()` in `killSession` with a graceful finalize: write exit sequence (`\x03` then `/exit\r`), wait a short grace, force-kill if still alive; add injectable `setTimeout` seam; track/clear pending grace timer so the reaper + `shutdown()` stay bounded and guarantee death |
| modify | `src/__tests__/pty.test.js` | Cases for the graceful path (write-then-force-kill, force on grace expiry, shutdown still terminates) |
| modify | `.ai/architecture.md` | Update the Terminal-lifecycle paragraph for graceful finalize-on-kill |
| modify | `.ai/index.md` | Touch the `pty` row note if its one-liner now omits the graceful behavior |

**Steps:**

- [x] Add a `_setTimeoutFn` injectable seam in `pty.js` mirroring the existing `_setTimerFn` (`pty.js:36-38`) so the grace delay is test-controllable.
- [x] Extract a small `finalizeSession(session)` (~<30 lines, single focused function) that: writes the exit sequence (`\x03` then `/exit\r`) to `session.ptyProcess`, then schedules an **unconditional** force `ptyProcess.kill()` via `_setTimeoutFn` after a short grace (e.g. 1500 ms). The force-kill is the guarantee — it fires **regardless** of whether claude honored `\x03`/`/exit`, so a claude that ignores the exit sequence still dies. Each pty op is individually `try/catch`-swallowed (a write to an already-exited pty must not throw past the kill). Store the returned timer handle on the session (`session._graceTimer`) so shutdown can settle it.
- [x] Rewire `killSession(id)` (`pty.js:145-150`) to: delete from the map immediately (so caps/listing/`MAX_SESSIONS` stay correct the instant kill is requested), then run `finalizeSession`. Preserve the `try/catch` swallow around all pty operations. Idempotency: a second `killSession` for the same id is a no-op (already removed from the map).
- [x] Keep the pending grace timer bounded: the reaper (`pty.js:163-177`) keeps calling `killSession` (now graceful) — the unconditional force-kill fallback guarantees the session leaves memory within the grace window, so the reaper never accumulates live sessions. `shutdown()` must not wait on grace timers (see next step).
- [x] In `shutdown()` (`pty.js:189-197`, SIGINT/SIGTERM at 199-200), iterate every session and **force-kill synchronously in bounded time** — best-effort write of the exit sequence, then an immediate, unconditional `ptyProcess.kill()` (do **not** await the async grace window on process exit), and `clearTimeout(session._graceTimer)` for any timer a prior `killSession` already scheduled, so no timer leaks and the daemon never hangs waiting on a graceful path. Net effect: clean console close gets the graceful grace window; SIGINT/SIGTERM gets an immediate guaranteed kill. (Note for reviewer: `server.js` has **no** kill path; all teardown — `killSession`, the reaper, `shutdown()` — lives in `pty.js`.)
- [x] Frame honestly in code comments + KB: claude already writes its session JSONL **incrementally** as the conversation progresses, so this change **hardens the last-turn flush + a clean `/resume` listing** on close — it is *not* the primary fix for refresh continuity (Phase 1 is). Do not oversell it as the mechanism that "saves" the conversation.

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `src/__tests__/pty.test.js` | Graceful path writes `\x03` + `/exit\r` before kill; force-kill fires **unconditionally** when grace elapses even if the pty never exited on its own (drive via `_setTimeoutFn`, assert `ptyProcess.kill` called); session removed from the map immediately on `killSession`; second `killSession` is a no-op; `shutdown()` force-kills every session synchronously and clears any pending `_graceTimer` (no leaked timers) |

**Verification:**

- [x] Automated tests for this phase pass: `pnpm test`
- [ ] Manual: hold a conversation, close the console/app, reopen a console in that worktree, run `/resume` → the session is listed and resumes cleanly
- [ ] Confirm **no zombie PTY/claude processes remain after console close**: close the tab, then check the process list (Task Manager / `Get-Process`) — the `claude`/`conhost`/pwsh PTY child for that session is gone within the grace window
- [ ] Confirm **no zombie processes remain after daemon stop**: Ctrl-C / SIGTERM the daemon with a live console open → every PTY child terminates promptly (shutdown does not hang on grace timers)
- [ ] Confirm the idle reaper still bounds sessions (no leaked grace timers; `MAX_SESSIONS` still enforceable)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase (verdict: green; 2 nits, none blocking)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (gated /exit sequence to kind==='claude'; commit 2b5d708)
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(pty): graceful claude exit before force-kill to finalize session JSONL`
- [x] Phase marked complete

---

### Phase 3: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- Refresh with a live Claude console returns the same conversation + scrollback, no new claude spawned (Phase 1).
- Explicit `✕` close then reload does not resurrect; stale/reaped key yields a clean fresh console (Phase 1).
- Close app/console → reopen → `/resume` lists and resumes the session; no zombie PTYs; reaper still bounded (Phase 2).
- No regression to multi-worktree terminal visibility, focus-mode, macros, or keynav.

**Steps:**

- [x] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent reviews the entire change end-to-end
- [x] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [x] All tests pass (`pnpm test`)
- [x] No CLAUDE.md invariants violated (pnpm only; thin entry points — logic in `term-sessions.js`/`pty.js` helpers, not inline in `main.js` bootstrap; reused the existing localStorage leaf pattern; small focused functions; no new dependencies; `src/worktrees.js` cwd untouched; all PTY kill paths stay in `pty.js`, `server.js` untouched)
- [x] Cross-phase manual test: console open → refresh (Phase 1 reconnect) → close app → reopen → `/resume` (Phase 2 finalize) in one session
- [x] Regression sweep: switch worktrees, open multiple consoles, toggle focus mode, use macros + desktop keynav — all still work
- [x] Overall success criteria met
- [x] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
| ------ | ---------------------- |
| New `term-sessions.js` leaf module + responsibility | `public/js/README.md` |
| Persisted-reattach decision + constraints | `.ai/decisions/terminal-session-reattach-localstorage.md` (new) |
| Index the new decision/module | `.ai/index.md` (dashboard row Related docs) |
| Graceful finalize-on-kill terminal lifecycle | `.ai/architecture.md` (Terminal-lifecycle paragraph) |

Documentation is added as a step within each relevant phase, not as a separate phase.

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
| --------------- | ------ | ---------------- |
| `decisions/terminal-session-reattach-localstorage.md` | create | Why one console descriptor `{ sessionId, kind }`/worktree lives in `localStorage` (mirrors macros store); reconnect = active worktree at first-tick fire time only, lazy for others; one-shot guard (no refire on poll); `closeTab` clears the key before group deletion; stale-id tolerated as a no-error fresh spawn; **`kind` IS persisted** so a reattached shell isn't relabeled "Claude" (server ignores `kind` on reattach but the client labels the tab); rejected alternatives (server-side persistence, per-tab granularity, bare-`sessionId` store) |
| `index.md` | update | Add the new decision link (and `term-sessions.js`) to the dashboard module row |
| `architecture.md` | update | Terminal-lifecycle paragraph: graceful exit-sequence-then-**unconditional**-force-kill before teardown so claude flushes its last-turn JSONL for a clean `/resume`; `shutdown()` force-kills synchronously and clears pending grace timers so no ConPTY zombie survives and the daemon never hangs |

## Tests

| Phase | Logic under test | Test file |
| ----- | ---------------- | --------- |
| Phase 1 | `term-sessions` load/get/set/remove tolerance + single-descriptor-per-path (`{ sessionId, kind }`, malformed entries dropped) | `public/js/term-sessions.test.js` |
| Phase 1 | `openTerminal`/`connectSession`/`reconnectActiveWorktree` DOM+WS orchestration | Manual acid test — DOM/WS-bound, no harness; all extractable logic is in the tested leaf (consistent with untested `terminals.js`) |
| Phase 2 | Graceful kill: write exit seq → **unconditional** force-kill on grace expiry; immediate map removal; idempotent re-kill; `shutdown()` synchronous + clears pending grace timers | `src/__tests__/pty.test.js` (extend) |

## Human Summary

We're fixing the bug where refreshing the local-pm browser tab kills your live
Claude conversation. The backend already keeps the Claude process and its
scrollback alive after the websocket drops — the browser just throws away the key
needed to reconnect.

- **Phase 1 (the real fix):** save that key — one console descriptor
  (`{ sessionId, kind }`) per worktree — in the browser's `localStorage`, using
  the same tiny leaf-module pattern the app already uses for terminal macros and
  nav history. On page load, the active worktree automatically reconnects to its
  running console and replays the backlog, and the recreated tab keeps its real
  label (Shell vs Claude). Other worktrees reconnect lazily when you navigate to
  them. Closing a tab on purpose forgets the key (so it won't come back), but a
  reload keeps it. If the saved session is already gone, you just get a clean new
  console — no error.
- **Phase 2 (a safety net):** when a console/app closes, ask Claude to exit
  cleanly before we force-kill it, so its conversation file is fully flushed and
  reliably shows up when you run `/resume` later. Claude already saves as it
  goes, so this hardens the last-turn flush rather than being the primary fix —
  and it must still guarantee the process dies on Windows.

**Trade-offs:** one console per worktree is persisted (matches how the feature is
used). We persist the console's **type** (shell vs Claude) alongside its id so a
reconnected console is labeled truthfully — a richer stored value but still the
same single-console-per-worktree shape; the server itself ignores type on
reattach, but the browser uses it to label the tab. We deliberately did **not**
touch cwd handling or add any auto-resume flags — the user runs `/resume`
themselves.
