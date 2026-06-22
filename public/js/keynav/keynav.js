// Global keydown handler scaffold + initKeynav().
// Attached as a capture-phase listener only on desktop (isDesktop()).
// Routes render requests through app-events.js — never imports main.js.

import { MODE, getMode, setMode, handleEscPress, clearEscPending } from './mode.js';
import { isDesktop } from './desktop-gate.js';
import { assertBadge } from './mode-badge.js';
import { focusTerminalForPath, blurActiveTerminal } from '../terminals.js';
import { selected, selectItem, expandProject, resolveProjectLanding } from '../selection.js';
import { nextProject, prevProject, nextWorktree, prevWorktree } from './traversal.js';
import * as appEvents from '../app-events.js';
import { openPalette } from './palette.js';

// g-prefix sequence detector state.
// pending = true when a lone `g` was just pressed and we are waiting for t/T.
let _gPending = false;
let _gTimer = null;
const G_TIMEOUT_MS = 700;

function cancelGPending() {
  _gPending = false;
  if (_gTimer !== null) { clearTimeout(_gTimer); _gTimer = null; }
}

function startGPending() {
  cancelGPending();
  _gPending = true;
  _gTimer = setTimeout(cancelGPending, G_TIMEOUT_MS);
}

// Returns true if the event target is an editable field (login/add-project modal
// inputs must type normally). Checked before any interception.
function isEditableTarget(target) {
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

// Land on a project: find its resolveProjectLanding() target, skipping empty
// projects in the given direction until a non-null target is found. Returns null
// if all projects are empty (or tree is empty).
function landOnProject(state, projectName, delta) {
  const worktrees = state.worktrees ?? [];
  // Build ordered unique project list matching traversal.js ordering.
  const seen = new Set();
  const projects = [];
  for (const w of worktrees) {
    if (!seen.has(w.project)) { seen.add(w.project); projects.push(w.project); }
  }
  if (projects.length === 0) return null;

  let idx = projects.indexOf(projectName);
  if (idx === -1) return null;

  // Try up to projects.length times to find a non-null landing (skip empty projects).
  for (let i = 0; i < projects.length; i++) {
    const landing = resolveProjectLanding(state, projects[idx]);
    if (landing) return landing;
    // This project is empty — skip in the direction of travel.
    idx = ((idx + delta) % projects.length + projects.length) % projects.length;
  }
  return null;
}

function handleNavMode(e) {
  // ── g-prefix combo: gt / gT ──────────────────────────────────────────────
  if (_gPending) {
    if (e.key === 't' || e.key === 'T') {
      cancelGPending();
      e.preventDefault();
      e.stopPropagation();
      const state = appEvents.lastState;
      if (!state) return;
      const delta = e.key === 't' ? +1 : -1;
      const targetProject = delta > 0
        ? nextProject(state, selected)
        : prevProject(state, selected);
      if (!targetProject) return;
      const landing = landOnProject(state, targetProject, delta);
      if (!landing) return;
      // Auto-expand the target project if collapsed.
      const landingWt = (state.worktrees ?? []).find((w) => w.path === landing.path);
      if (landingWt) expandProject(landingWt.project);
      selectItem(landing);
      return;
    }
    // Any other key: abort g-pending AND let the key dispatch normally below.
    cancelGPending();
    // fall through to normal key handling
  }

  if (e.key === 'g') {
    // Don't intercept: start pending, wait for next key.
    startGPending();
    // Do NOT preventDefault — `g` itself has no action; it's just the prefix.
    return;
  }

  // ── Arrow keys: ↑/↓ within current project ───────────────────────────────
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const state = appEvents.lastState;
    if (!state || !selected) return;
    e.preventDefault(); // prevent page scroll during tree nav
    e.stopPropagation();
    const targetPath = e.key === 'ArrowDown'
      ? nextWorktree(state, selected)
      : prevWorktree(state, selected);
    if (!targetPath) return;
    const wt = (state.worktrees ?? []).find((w) => w.path === targetPath);
    if (wt) expandProject(wt.project);
    selectItem({ type: 'worktree', path: targetPath });
    return;
  }

  // ── ctrl+shift+p: open quick-nav palette ────────────────────────────────
  if (e.ctrlKey && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    e.stopPropagation();
    openPalette();
    return;
  }

  // ── Enter / i: focus terminal + switch to WRITING ─────────────────────────
  if (e.key === 'Enter' || e.key === 'i') {
    const sel = selected;
    if (!sel || sel.type !== 'worktree') return;
    e.preventDefault();
    e.stopPropagation();
    const entered = focusTerminalForPath(sel.path);
    if (entered) {
      setMode(MODE.WRITING);
      assertBadge(MODE.WRITING);
    }
  }
}

function handleWritingMode(e) {
  // In WRITING mode: only double-Esc is intercepted; all other keys (including
  // lone Esc, ctrl+shift+p) propagate to xterm untouched.
  if (e.key !== 'Escape') {
    // Any non-Esc clears the pending Esc so a stale timestamp never triggers
    // a spurious double-Esc later.
    clearEscPending();
    return; // let all non-Esc keys pass to xterm
  }
  const isDouble = handleEscPress(Date.now());
  if (isDouble) {
    e.preventDefault();
    e.stopPropagation();
    blurActiveTerminal();
    setMode(MODE.NAV);
    assertBadge(MODE.NAV);
  }
  // lone Esc: handleEscPress already recorded the timestamp; do NOT preventDefault —
  // the event propagates to xterm (vim/nano depend on it).
}

function onKeydown(e) {
  if (isEditableTarget(e.target)) return;
  const mode = getMode();
  if (mode === MODE.NAV) handleNavMode(e);
  else handleWritingMode(e);
}

export function initKeynav() {
  if (!isDesktop()) return;
  document.addEventListener('keydown', onKeydown, true); // capture phase
  assertBadge(getMode());
}
