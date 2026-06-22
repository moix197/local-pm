// Leaf: modal keyboard-nav mode state + double-Esc detector.
// No DOM, no app imports — keeps the import graph a DAG.

export const MODE = Object.freeze({ NAV: 'NAV', WRITING: 'WRITING' });

let _mode = MODE.NAV;

export function getMode() { return _mode; }
export function setMode(m) { _mode = m; }

// Timestamp of the last lone Esc keydown (ms). Null = no pending Esc.
let _lastEscTs = null;

// ~300ms window for double-Esc. Returns true if a second Esc within the window
// is detected and consumes the pending timestamp. A lone Esc records its
// timestamp and returns false — it is never swallowed.
export function handleEscPress(nowTs) {
  if (_lastEscTs !== null && nowTs - _lastEscTs <= 300) {
    _lastEscTs = null;
    return true; // double-Esc confirmed
  }
  _lastEscTs = nowTs;
  return false;
}

// Pure predicate for tests: no side effects.
export function isDoubleEsc(prevTs, nowTs) {
  return prevTs !== null && nowTs - prevTs <= 300;
}

// Reset the pending Esc timestamp (called on any non-Esc keydown in WRITING mode
// so a stale pending doesn't linger across unrelated keystrokes).
export function clearEscPending() { _lastEscTs = null; }
