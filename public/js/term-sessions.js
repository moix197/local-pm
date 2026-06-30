// Leaf module: localStorage CRUD for per-worktree terminal session descriptors.
// Mirrors term-macros.js / keynav/mru.js tolerance exactly:
//   - corrupt/missing data → {} (never throws)
//   - quota errors on write are swallowed
// One descriptor { sessionId, kind } per worktree path, keyed by path.
// No DOM, no app imports — keeps the graph a DAG.

const STORAGE_KEY = 'localpm.termSessions';

// Tolerant read: anything that doesn't parse into a map of path → { sessionId, kind }
// string-string descriptors → {} on corrupt/missing. Malformed entries are dropped.
export function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (
        typeof k === 'string' &&
        v &&
        typeof v === 'object' &&
        typeof v.sessionId === 'string' &&
        typeof v.kind === 'string'
      ) {
        result[k] = { sessionId: v.sessionId, kind: v.kind };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    /* storage unavailable — descriptor just won't persist this session */
  }
}

// Returns the descriptor { sessionId, kind } for path, or null if not found.
export function getSession(path) {
  const sessions = loadSessions();
  return sessions[path] ?? null;
}

// Overwrites the descriptor for path. One descriptor per worktree path.
export function setSession(path, sessionId, kind) {
  const sessions = loadSessions();
  sessions[path] = { sessionId, kind };
  saveSessions(sessions);
}

// Removes the descriptor for path. No-op if not present.
export function removeSession(path) {
  const sessions = loadSessions();
  delete sessions[path];
  saveSessions(sessions);
}
