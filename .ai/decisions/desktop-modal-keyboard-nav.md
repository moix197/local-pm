# Desktop keyboard nav is a two-mode (NAV/WRITING) modal layer, desktop-only

**Decision:** The dashboard ships a Vim-style modal keyboard layer (`public/js/keynav/*`): a single capture-phase `keydown` handler on `document` with two modes — **NAV** (default; `gt`/`gT` across projects, `↑`/`↓` across worktrees, `ctrl+shift+p` quick-nav palette, `Enter`/`i` to enter a terminal) and **WRITING** (a terminal is focused; the handler intercepts nothing except a double-`Esc`). A corner `NAV`/`WRITING` badge shows the mode. The whole layer is gated to desktop (`isDesktop()`, the `min-width:769px` complement of the existing `≤768px` mobile breakpoint) and is fully inert on mobile.

**Why:** A global key handler is a greedy guest — it can swallow keystrokes meant for terminals, forms, or editors (vim/nano) running *inside* a terminal. Modes make the handler a careful guest: in WRITING it owns almost nothing, so xterm/vim behave normally. The load-bearing rule is **single-`Esc` passthrough**: a lone `Esc` reaches xterm untouched (vim/nano depend on it); only a *double*-`Esc` within ~300ms exits to NAV and blurs. Editable-target detection (INPUT/TEXTAREA/contenteditable) early-returns so login/add-project modal inputs and the palette input type normally. Mobile already has its touch toolbar + focus mode, so the modal layer would only conflict there — hence desktop-only.

All non-trivial logic (mode reducer + `isDoubleEsc`, desktop gate, traversal index math, fuzzy matcher) is extracted into pure leaf modules so it is unit-testable; there is no DOM test harness, so DOM/handler-wiring behavior is verified manually in the browser.

**Rejected:**
- *Always-on global hotkeys without modes* — simplest, but guarantees keystroke collisions with terminals/forms/vim. Modes are the whole point.
- *Mobile parity* — mobile already solves keyboard-free use with the touch toolbar + focus mode; a second input layer there adds conflict, not value.
- *A keybinding library (mousetrap/hotkeys-js)* — violates the no-new-deps / no-build native-ESM invariant ([frontend-native-esm-modules](frontend-native-esm-modules.md)) for a small, bespoke handler we control.
- *Palette markup in `index.html`* — the palette builds its own overlay node in JS (`ensureOverlay()`) and appends to `document.body`, so no static markup was added. Self-contained and satisfies the mount-outside-the-re-rendered-subtree invariant.

**Constraints it creates:**
- `keynav/*` must route render requests through `app-events.js` (`requestRender`/`lastState`); nothing imports `main.js`. `mode.js`, `desktop-gate.js`, `fuzzy.js`, `mru.js` stay pure leaves (no DOM, no app imports) so the graph stays a DAG and they remain unit-testable.
- The badge and the palette mount on `document.body` (outside the poll-rebuilt sidebar/main subtree) so the 2s `requestRender` never tears them down or steals focus; the badge re-asserts idempotently by id in the render callback, and an open palette rebuilds its rows in the render callback (`refreshPaletteIfOpen`) without closing or refocusing.
- WRITING mode must keep intercepting only the double-`Esc`; any future binding added to NAV must verify it stays inert in WRITING (passes to xterm).
