# Plan: Desktop Keyboard Navigation (Vim-style modal nav + quick-nav palette)

**Created:** 2026-06-22
**Branch:** feat/desktop-keyboard-nav
**Status:** not started

## Context

The local-pm dashboard is keyboard-hostile on desktop: every traversal of the
project/worktree tree and every terminal focus is a mouse click. Power users on
desktop want Vim-style modal navigation plus a VS Code-style quick-nav palette
to jump between worktrees by typing. This adds a **desktop-only** modal
keyboard layer (mobile already has its touch toolbar and focus mode):

- A two-mode state machine — **Navigation** (default) and **Writing** (a terminal
  is focused) — driven by a single global `keydown` handler, with a persistent
  `NAV`/`WRITING` badge.
- Vim-style traversal: `gt`/`gT` across projects, `↑`/`↓` across worktrees,
  `Enter`/`i`/click to enter a terminal, double-`Esc` to leave it.
- A `ctrl+shift+p` quick-nav palette: a top-center overlay with a built-from-scratch
  vanilla fuzzy matcher over `project / branch`, MRU-first ordering persisted to
  localStorage, running-server markers, and select-to-jump.

All within the no-build, native-ESM, no-framework, no-new-deps invariants
([frontend-native-esm-modules](../.ai/decisions/frontend-native-esm-modules.md)).

## Risk: medium

Net-new global input layer is the main risk: a greedy global `keydown` handler
can swallow keystrokes meant for terminals, forms, or vim/nano running *inside* a
terminal. The mode gating and single-Esc passthrough are the load-bearing
correctness details. No backend, no schema, no auth surface touched — keeps blast
radius frontend-only.

## Dependencies & Risks

- **Single-Esc passthrough is non-negotiable.** Writing mode must let a lone `Esc`
  reach xterm untouched (vim/nano depend on it). Only a *double*-`Esc` within ~300ms
  exits to nav mode. Getting this wrong breaks editing inside terminals.
- **Global handler must not hijack form inputs.** Login/add-project modal inputs and
  the palette's own input must keep normal typing. Gate on `event.target` /
  active-element being an editable field.
- **Desktop gate must match existing detection.** Reuse the codebase's existing
  responsive/mobile detection (≤768px breakpoint and/or `pointer:fine`) rather than
  inventing a new one — the feature must be fully inert on mobile.
- **Persistence invariants.** The badge and the palette overlay must survive the 2s
  poll re-render (`requestRender`). They must mount **outside** the re-rendered
  sidebar/main-pane subtree (e.g. as fixed-position children of `document.body`, like the
  existing persistent components) so the poll never tears them down. The badge re-asserts
  idempotently in the render callback; an open palette is never inside the re-rendered tree,
  so a mid-open poll re-renders the sidebar underneath without closing or stealing focus
  from it.
- **Empty / degenerate state.** All entry points must no-op gracefully: zero projects or
  zero worktrees → `gt`/`gT`/arrows do nothing (selection stays null), the palette opens
  with an empty list and an empty-state hint. Single project → `gt`/`gT` is a no-op (or
  self-wraps). A project with zero worktrees is never a landing target (the project-scoped
  landing helper returns null for it). A selection whose path vanished after a poll falls
  back through `resolveSelection()` on the next render.
- **DAG must hold.** New modules route render requests through `app-events.js`; nothing
  imports `main.js`. MRU/localStorage helper stays a leaf (mirror `term-macros.js`, and
  follow the [terminal-macros-localstorage](../.ai/decisions/terminal-macros-localstorage.md)
  decision as the pattern for the localStorage leaf).
- **Reuse the existing landing heuristic.** When a project is selected (via `gt`/`gT` or a
  palette jump), it lands on "running worktree if any, else first worktree". This mirrors the
  existing `resolveSelection()` precedent in `public/js/selection.js` (running-first, then
  first worktree). `resolveSelection` resolves globally; the project-scoped variant is the
  same rule narrowed to one project's worktrees — factor a shared helper rather than
  duplicating the rule.
- **No test harness for DOM.** `node:test` runs against pure ESM helpers
  (`grouping.js`, `selection.js` are unit-tested). Pure logic (fuzzy matcher, MRU
  store, mode reducer, traversal index math) must be extracted into pure modules and
  unit-tested there; integration/UI behavior is verified manually in the browser.
- **Order-sensitive:** Phase 1 (mode machine + handler scaffold) must land before
  Phases 2 and 3, which both attach key bindings onto it.

## Phases

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Create a git worktree for this plan's branch. Always confirm worktree creation with
the user before running.

**Steps:**

- [ ] Confirm branch name (`feat/desktop-keyboard-nav`) and base ref (`main`) with the user
- [ ] Run `git worktree add ../local_pm-desktop-keyboard-nav -b feat/desktop-keyboard-nav main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: Mode state machine + desktop gate + NAV/WRITING badge + writing-mode entry/exit

**Risk:** medium
**Mode:** hil  <!-- terminal-focus + double-Esc-vs-vim-passthrough behavior must be eyeballed live in the browser -->
**Type:** frontend
**Success criteria:** On desktop, a corner badge shows `NAV` by default and survives
the 2s poll. Pressing `Enter` or `i` on the selected worktree (or clicking its
terminal) focuses that terminal and flips the badge to `WRITING`. A single `Esc`
inside the terminal still reaches vim/nano (cursor moves, modes change). A
double-`Esc` within ~300ms returns to `NAV` and blurs the terminal. On mobile the
badge never appears and no global key handling occurs.
**Commit message:** `feat(ui): desktop modal keyboard nav — mode machine + NAV/WRITING badge`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `public/js/keynav/mode.js` | Pure mode reducer/state: `MODE.NAV`/`MODE.WRITING`, `getMode`/`setMode`, double-Esc detector (timestamp-based, ~300ms window). Leaf — no DOM, no app imports. |
| create | `public/js/keynav/desktop-gate.js` | `isDesktop()` reusing existing breakpoint/`pointer:fine` detection. Leaf. |
| create | `public/js/keynav/keynav.js` | Global `keydown` handler scaffold + `initKeynav()`: registers a single capture-phase listener on `document` only when `isDesktop()`, ignores events targeting editable fields, dispatches by current mode. In NAV mode it intercepts (preventDefault/stopPropagation) the keys it owns *before* they reach the terminal; in WRITING mode it intercepts nothing except the double-`Esc` (so `ctrl+shift+p` and all other keys reach xterm). Imports `mode.js`, `desktop-gate.js`, `terminals.js`, `app-events.js`. |
| create | `public/js/keynav/mode-badge.js` | Renders/updates the persistent `NAV`/`WRITING` corner badge, mounted as a fixed-position child of `document.body` (outside the re-rendered sidebar/main-pane subtree); idempotent create/update so it survives `requestRender`. |
| modify | `public/js/main.js` | Call `initKeynav()` at bootstrap (after `app-events` callbacks registered); re-assert the badge in the `render` callback (persistence invariant). Wiring only — no key/mode logic in `main.js`. |
| modify | `public/js/terminals.js` | Expose a focus/blur hook the handler can call to enter/exit writing mode; wire terminal `click`/focus to set `WRITING`. |
| modify | `public/css/app.css` | Badge styles (corner-fixed, small, NAV vs WRITING variant); reuse existing color tokens. |
| modify | `public/js/README.md` | Add `keynav/*` module rows. |

**Steps:**

- [x] `mode.js`: mode enum + get/set + pure `isDoubleEsc(prevTs, nowTs)` helper (~300ms window). On a lone `Esc`, record its timestamp and let it pass; only when a second `Esc` lands inside the window is it a double — a single `Esc` followed by silence stays a single `Esc` (never swallowed).
- [x] `desktop-gate.js`: `isDesktop()` mirroring existing mobile detection (find and reuse it; do not invent a new breakpoint)
- [x] `keynav.js`: `initKeynav()` attaches a single capture-phase `keydown` on `document` only when desktop; early-return when target is an editable input/textarea/contenteditable (login/add-project modal inputs)
- [x] In NAV mode: `Enter`/`i` on the selected worktree → focus its terminal + `setMode(WRITING)`. If nothing is selected (empty state), no-op.
- [x] In WRITING mode: only the double-`Esc` is intercepted; the first `Esc` and every other key (including `ctrl+shift+p`) propagate to xterm untouched. Two `Esc` within window → blur terminal + `setMode(NAV)`.
- [x] `terminals.js`: terminal click/focus → `setMode(WRITING)`; expose focus/blur helpers consumed by `keynav.js` (writing-mode entry must actually `.focus()` the xterm instance, not just flip the badge)
- [x] `mode-badge.js`: create + update badge mounted on `document.body`; called on mode change and on each `render` (idempotent — never duplicates)
- [x] `main.js`: `initKeynav()` at bootstrap; re-assert badge in render callback
- [x] Update `public/js/README.md` with `keynav/*` rows

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `public/js/keynav/mode.test.js` | `mode.js`: mode transitions, `isDoubleEsc` window boundaries (inside/outside ~300ms), single-Esc is not double |
| create | `public/js/keynav/desktop-gate.test.js` | `isDesktop()` true/false against stubbed matchMedia/width (inject the matcher so it's pure-testable) |

**Verification:**

- [x] Automated tests for this phase pass: `pnpm test` (Node `node:test`)
- [ ] Desktop browser: badge shows `NAV`, survives several 2s polls without disappearing/duplicating
- [ ] `Enter` and `i` on selected worktree both focus the terminal and flip badge to `WRITING`; clicking a terminal also flips to `WRITING`
- [ ] Run `vim` (or `nano`) in a terminal: single `Esc` works normally (insert→normal mode, no nav-mode flip); two `Esc` slower than ~300ms apart are treated as two single Escs (still no flip); two within ~300ms exit to `NAV` and blur
- [ ] Typing in login/add-project modal inputs is unaffected
- [ ] Mobile viewport (≤768px): no badge, no global key capture
- [ ] In WRITING mode, `ctrl+shift+p` reaches the terminal (is NOT intercepted) — confirms capture handler only owns it in NAV mode

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat(ui): desktop modal keyboard nav — mode machine + NAV/WRITING badge`
- [ ] Phase marked complete

---

### Phase 2: Navigation-mode traversal keys (`gt`/`gT`, `↑`/`↓`, auto-expand)

**Risk:** medium
**Mode:** hil  <!-- keyboard traversal of the live tree must be exercised by hand -->
**Type:** frontend
**Success criteria:** In NAV mode on desktop, `gt`/`gT` move the selection to the
next/previous project (landing on that project's running-else-first worktree, per the
shared `resolveSelection` rule), and `↑`/`↓` move between worktrees within the selected
project, wrapping at boundaries. Selection updates the sidebar and main pane via the
existing flow. Landing on a worktree inside a collapsed project auto-expands that project.
The full tree is traversable by keyboard alone. Degenerate states are safe: empty tree →
no-op; single project → `gt`/`gT` no-op; a pending `g` aborts on any non-`t`/`T` key and
times out after ~700ms.
**Commit message:** `feat(ui): nav-mode tree traversal — gt/gT projects, arrows worktrees, auto-expand`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `public/js/keynav/traversal.js` | Pure index math over the grouped tree: `nextProject`/`prevProject`, `nextWorktree`/`prevWorktree`, given grouped state + current selection → next selection target. Returns null on empty tree. Boundaries **wrap** (last project→first, last worktree→first) for both projects and worktrees. No DOM. Imports `grouping.js`. |
| modify | `public/js/selection.js` | Factor the running-first-else-first landing rule out of `resolveSelection()` into a shared helper (e.g. `firstRunningOrFirst(worktrees, running)`) and add `resolveProjectLanding(state, project)` that applies it to one project's worktrees (returns null for a project with zero worktrees). `resolveSelection` is refactored to call the shared helper — no behavior change. Also expose `expandProject(name)` if not derivable from `toggleProjectCollapse` (reuse existing collapse state; do not duplicate). |
| modify | `public/js/keynav/keynav.js` | NAV-mode bindings: `g`-prefix sequence detector for `gt`/`gT` (with timeout/abort — see steps); `↑`/`↓` arrows → traversal; route results through `selection.js` `selectItem()` + `requestRender()`; project landing via `resolveProjectLanding()`; auto-expand collapsed target via `selection.js`. |
| modify | `public/js/README.md` | Add `keynav/traversal.js` row; note arrow/`gt` bindings. |

**Steps:**

- [ ] `traversal.js`: pure next/prev project + next/prev worktree resolution from grouped state (reuse `groupByProject`); **wrap** at both boundaries; return null on empty tree
- [ ] `selection.js`: factor `firstRunningOrFirst()` out of `resolveSelection()` and add project-scoped `resolveProjectLanding(state, project)` — this is the "running worktree if any, else first worktree" rule (mirrors `resolveSelection`'s precedent, narrowed to one project). Project with zero worktrees → null.
- [ ] Selecting a project (via `gt`/`gT`) lands on `resolveProjectLanding()`; if it returns null (empty project), skip to the next non-empty project
- [ ] `keynav.js`: `g`-prefix sequential combo detector (`gt` next, `gT` prev project). Pending `g` resets on: any non-`t`/`T` key (abort, and let that key dispatch normally), and a ~700ms timeout so a stale `g` never lingers
- [ ] Single project: `gt`/`gT` is a no-op (or self-wraps to the same project) — never throws
- [ ] `keynav.js`: `↑`/`↓` move between worktrees within the selected project only (wrap at top/bottom)
- [ ] Empty tree (no projects / no worktrees): all traversal keys no-op, selection stays null
- [ ] Route every move through `selectItem()` + `requestRender()` (no bespoke DOM mutation)
- [ ] Auto-expand the target project if collapsed before/at selection
- [ ] Arrows do not scroll the page while in NAV mode with a tree selection (preventDefault appropriately)
- [ ] Update `public/js/README.md`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `public/js/keynav/traversal.test.js` | `traversal.js`: next/prev project wrap behavior, next/prev worktree wrap within project, boundaries (top/bottom wrap), empty-tree → null, single-project no-op/self-wrap |
| modify | `public/js/selection.test.js` | `resolveProjectLanding()`: running-first then first worktree within a project, zero-worktree project → null; `resolveSelection` unchanged after the `firstRunningOrFirst` refactor (regression) |

**Verification:**

- [ ] Automated tests for this phase pass: `pnpm test`
- [ ] Desktop: `gt`/`gT` cycle through projects (wrapping at ends); each lands on the project's running-else-first worktree
- [ ] `↑`/`↓` move within the selected project's worktrees and wrap at top/bottom; sidebar highlight + main pane follow
- [ ] Landing on a worktree in a collapsed project auto-expands it
- [ ] Whole tree reachable by keyboard alone; page does not scroll on arrow nav
- [ ] `g` then a non-`t`/`T` key does not get stuck in a pending state (sequence resets and the second key dispatches normally); a lone `g` clears after ~700ms
- [ ] Empty state (no projects/worktrees): `gt`/`gT`/arrows no-op, nothing throws
- [ ] Single project: `gt`/`gT` is a harmless no-op; a project with zero worktrees is skipped, never landed on

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat(ui): nav-mode tree traversal — gt/gT projects, arrows worktrees, auto-expand`
- [ ] Phase marked complete

---

### Phase 3: Quick-nav command palette (`ctrl+shift+p`, fuzzy filter, MRU, jump)

**Risk:** medium
**Mode:** hil  <!-- overlay UX, fuzzy ranking quality, and MRU persistence need live eyeballing -->
**Type:** frontend
**Success criteria:** In NAV mode on desktop (not in WRITING mode), `ctrl+shift+p`
opens a top-center overlay with a pre-focused input. Typing fuzzy-filters worktree
rows by `project / branch`; an empty query shows MRU-first ordering with running
servers marked. `↑`/`↓` move the highlight, `Enter` (or click) jumps to the worktree
via `selectItem()` + `requestRender()`, auto-expanding its project. `Esc` closes the
palette. MRU order persists across reloads (localStorage, same store as the token).
**Commit message:** `feat(ui): quick-nav palette — fuzzy worktree search, MRU, jump`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `public/js/keynav/fuzzy.js` | Pure vanilla subsequence match + scoring over a string: returns match boolean + score (favor contiguous/start-of-word matches). No deps, no DOM. |
| create | `public/js/keynav/mru.js` | Leaf localStorage CRUD for MRU worktree order (single key under the existing localStorage namespace, mirrors `term-macros.js` tolerance: corrupt/missing → empty, quota errors swallowed). Follows the [terminal-macros-localstorage](../.ai/decisions/terminal-macros-localstorage.md) decision. No DOM, no app imports. |
| create | `public/js/keynav/palette.js` | Palette overlay component, mounted on `document.body` outside the re-rendered subtree so a 2s poll mid-open never tears it down or steals input focus. Open/close, input handling, builds rows from the latest state (`project / branch`), applies `fuzzy.js` ranking, empty-query MRU ordering via `mru.js`, running markers from `grouping.js` `runningPaths`, empty-state hint when no worktrees, keyboard highlight, select → `selectItem()`+expand+`requestRender()`, record MRU on jump. Imports `fuzzy.js`,`mru.js`,`selection.js`,`grouping.js`,`app-events.js`. |
| modify | `public/js/keynav/keynav.js` | Bind `ctrl+shift+p` in NAV mode only → `openPalette()`; ensure it's inert in WRITING mode. |
| modify | `public/index.html` | Add the palette overlay markup (reuse `.overlay`/`.overlay-panel` + `.hidden` pattern). |
| modify | `public/css/app.css` | Top-center positioning variant of the overlay; row highlight + running-marker dot/badge (reuse existing dot styles). |
| modify | `public/js/README.md` | Add `keynav/fuzzy.js`, `keynav/mru.js`, `keynav/palette.js` rows. |

**Steps:**

- [ ] `fuzzy.js`: subsequence matcher with scoring (contiguous + word-boundary bonuses); pure function `score(query, target)`
- [ ] `mru.js`: load/record MRU list of worktree paths under the existing localStorage namespace; tolerant reads/writes (mirror `term-macros.js`)
- [ ] `palette.js`: build candidate rows `{path, label: "project / branch", running}` from the latest state's worktrees + `runningPaths`; rebuild rows on a poll while open so the list stays fresh without closing
- [ ] Empty query → MRU-first ordering (most recent first), then remaining by stable order; non-empty → fuzzy-ranked
- [ ] No worktrees → palette still opens, shows an empty-state hint, `Enter` is a no-op
- [ ] Render running marker (dot/badge) on running rows; reuse existing green-dot style
- [ ] `ctrl+shift+p` opens (NAV mode only — inert in WRITING), input pre-focused; `↑`/`↓` move highlight; `Enter`/click jumps; `Esc` closes the palette only (does not change mode; the global double-Esc detector is not armed while the palette input has focus)
- [ ] MRU entries whose worktree path no longer exists are filtered out at open time (stale paths after a project removal)
- [ ] On jump: `selectItem()`, auto-expand project, `requestRender()`, and `mru.record(path)`
- [ ] Reuse `.overlay`/`.overlay-panel`/`.hidden`; add top-center CSS variant only
- [ ] Update `public/js/README.md`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `public/js/keynav/fuzzy.test.js` | `fuzzy.js`: subsequence match hits/misses, scoring orders contiguous/start-of-word matches above scattered ones, case-insensitivity |
| create | `public/js/keynav/mru.test.js` | `mru.js`: record moves path to front, dedupe, corrupt/missing storage → empty list, write errors swallowed (stub localStorage) |

**Verification:**

- [ ] Automated tests for this phase pass: `pnpm test`
- [ ] Desktop NAV mode: `ctrl+shift+p` opens top-center overlay with focused input
- [ ] WRITING mode (terminal focused): `ctrl+shift+p` does NOT open the palette
- [ ] Typing filters `project / branch` rows sensibly (closer matches rank higher)
- [ ] Empty query lists MRU-first; running worktrees visibly marked
- [ ] `Enter`/click jumps to the worktree, expands its project if collapsed, closes palette
- [ ] Reload the page: MRU ordering persists (most recently jumped appears first on next empty-query open)
- [ ] `Esc` closes the palette without exiting any mode unexpectedly (still in NAV after close)
- [ ] No-worktree state: palette opens with an empty-state hint; `Enter` does nothing
- [ ] Open the palette and wait through a 2s poll: it stays open, keeps input focus, and the row list reflects any state change (no tear-down/duplication)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat(ui): quick-nav palette — fuzzy worktree search, MRU, jump`
- [ ] Phase marked complete

---

### Phase 4: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil  <!-- orchestrator manually verifies end-to-end -->

**Overall success criteria:**

- On desktop, the full feature works end-to-end: NAV is default with a persistent
  badge; `gt`/`gT` and `↑`/`↓` traverse the whole tree with auto-expand; `Enter`/`i`/click
  enter WRITING mode and focus the terminal; lone `Esc` reaches vim/nano while
  double-`Esc` returns to NAV; `ctrl+shift+p` (NAV only) opens the fuzzy palette with
  MRU-first + running markers and jumps on select; MRU persists across reloads.
- Mobile is completely unaffected (no badge, no key capture, touch toolbar intact).
- No CLAUDE.md invariants violated (no build step, no framework, no new deps, DAG holds).
- `.ai/` knowledge base reflects the new keynav layer.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] All tests pass (`pnpm test`)
- [ ] No CLAUDE.md invariants violated (verify: no new deps in `package.json`, no build artifacts, import graph still a DAG — nothing imports `main.js`)
- [ ] Feature tested manually on desktop (golden path + edge cases: empty project list, single project, all-collapsed tree, terminal running vim)
- [ ] Feature confirmed inert on mobile viewport
- [ ] `.ai/` knowledge base synced via the `sync-knowledge` skill (see Knowledge Base Impact)
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
| ------ | ---------------------- |
| New `keynav/*` modules (mode machine, gate, handler, badge, traversal, fuzzy, mru, palette) | `public/js/README.md` (per-module rows) |
| New keyboard layer concept + desktop-only modal decision | `.ai/` (see Knowledge Base Impact) |

Documentation is added as a step within each relevant phase, not as a separate phase.

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
| --------------- | ------ | ---------------- |
| `decisions/desktop-modal-keyboard-nav.md` | create | Why a Vim-style two-mode keyboard layer, desktop-only; single-Esc passthrough vs double-Esc exit rationale; rejected alternatives (always-on global hotkeys without modes; mobile parity; a keybinding library) |
| `decisions/quicknav-mru-localstorage.md` (or extend `terminal-macros-localstorage.md`) | create/extend | MRU worktree order persisted client-side under the existing localStorage namespace; why frontend-only (no new route/schema). Follows the [terminal-macros-localstorage](../.ai/decisions/terminal-macros-localstorage.md) decision as the pattern for the localStorage leaf. **The create-vs-extend choice is deferred to the Phase 4 KB-sync step** (`sync-knowledge` owns that call) — extend if the two share enough rationale, otherwise create a sibling. |
| `index.md` | update | `dashboard` row: link the new keynav decision doc(s); note the `keynav/*` subtree under `public/js/` |
| `architecture.md` | update | Note the desktop keyboard layer + palette as part of the dashboard module's responsibilities and the DAG (keynav routes through `app-events.js`, never imports `main.js`) |

`execute-prd` syncs `.ai/` at closeout via the `sync-knowledge` skill, which owns the rules.

## Tests

| Phase | Logic under test | Test file |
| ----- | ---------------- | --------- |
| Phase 1 | Mode transitions + `isDoubleEsc` window | `public/js/keynav/mode.test.js` |
| Phase 1 | `isDesktop()` gate against stubbed matcher | `public/js/keynav/desktop-gate.test.js` |
| Phase 2 | Tree traversal index math (next/prev project + worktree wrap, boundaries, empty/single) | `public/js/keynav/traversal.test.js` |
| Phase 2 | `resolveProjectLanding()` running-first/first/zero-worktree + `resolveSelection` regression | `public/js/selection.test.js` |
| Phase 3 | Fuzzy subsequence match + scoring order | `public/js/keynav/fuzzy.test.js` |
| Phase 3 | MRU record/dedupe/tolerant storage | `public/js/keynav/mru.test.js` |

DOM/overlay/handler-wiring behavior (Phases 1–3) is verified manually in the browser:
no DOM test harness exists; `node:test` covers only pure ESM helpers
(`grouping.js`/`selection.js` are the precedent). All non-trivial logic above is
extracted into pure leaf modules precisely so it is unit-testable.

## Human Summary

We're adding a **desktop-only, Vim-style keyboard layer** to the local-pm dashboard
so you can drive the whole UI without a mouse — and it stays pure vanilla ESM with
no build step, no framework, and no new dependencies.

- **Phase 1** builds the brain: a two-mode state machine (Navigation vs Writing), a
  small corner badge telling you which mode you're in, and the rules for getting in
  and out of a terminal — `Enter`/`i`/click to start typing, double-`Esc` to leave
  (a single `Esc` still goes to vim/nano so editors keep working). It's switched off
  entirely on phones.
- **Phase 2** wires up movement: `gt`/`gT` jump between projects, arrow keys move
  between worktrees, and collapsed projects auto-open when you land in them.
- **Phase 3** adds a VS Code-style quick-open palette on `ctrl+shift+p`: type to fuzzy
  search worktrees by `project / branch`, see your most-recently-used ones first with
  running servers marked, and hit Enter to jump. Your recent order is remembered across
  reloads.
- **Phase 4** is a full manual run-through plus updating the `.ai/` knowledge base.

The key trade-off: the global key handler must be a careful guest — it never steals
keystrokes from forms, the palette input, or editors running inside a terminal. That's
why exiting a terminal needs a deliberate double-`Esc`, and why the whole layer is
gated to desktop only (mobile already has its touch toolbar).
