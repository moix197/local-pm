// Leaf cycle-breaker. Holds shared mutable state read by lower modules (api,
// console-panel, terminals, add-project) and registerable callback slots that
// main.js populates at bootstrap, so those modules never import main.js back —
// keeping the import graph a DAG.

// Last fetched /api/state, shared so post() can re-render the busy state.
export let lastState = null;
export function setLastState(state) {
  lastState = state;
}

// True while a mutating POST is in flight; gates the 2s poll and disables controls.
export let inFlight = false;
export function setInFlight(value) {
  inFlight = value;
}

// Callback slots registered by main.js at bootstrap.
let onRender = null;
let onAuthError = null;

export function registerRender(fn) {
  onRender = fn;
}

export function registerAuthError(fn) {
  onAuthError = fn;
}

export function requestRender(busy) {
  if (onRender) onRender(lastState, busy);
}

export function signalAuthError() {
  if (onAuthError) onAuthError();
}
