// Global keydown handler scaffold + initKeynav().
// Attached as a capture-phase listener only on desktop (isDesktop()).
// Routes render requests through app-events.js — never imports main.js.

import { MODE, getMode, setMode, handleEscPress, clearEscPending } from './mode.js';
import { isDesktop } from './desktop-gate.js';
import { assertBadge } from './mode-badge.js';
import { focusTerminalForPath, blurActiveTerminal } from '../terminals.js';
import { selected } from '../selection.js';

// Returns true if the event target is an editable field (login/add-project modal
// inputs must type normally). Checked before any interception.
function isEditableTarget(target) {
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

function handleNavMode(e) {
  // In NAV mode: Enter or i on selected worktree → focus terminal + enter WRITING.
  // Other NAV-mode bindings (gt/gT, arrows) are added in Phase 2.
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
