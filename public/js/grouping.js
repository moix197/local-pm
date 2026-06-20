// Pure grouping/derivation helpers over /api/state. No DOM, no fetch — unit-tested.

export function groupByProject(worktrees) {
  const map = new Map();
  for (const w of worktrees) {
    if (!map.has(w.project)) map.set(w.project, []);
    map.get(w.project).push(w);
  }
  return map;
}

export function runningPaths(state) {
  return new Set((state.running ?? []).map((r) => r.path));
}

// Assumes state.lanUrl is a non-null string; only called for running servers
// (callers guard on anyRunning), so state.lanUrl is always populated here.
export function lanUrlForPort(state, port) {
  if (port == null) return state.lanUrl;
  return state.lanUrl.replace(/:\d+$/, ':' + port);
}
