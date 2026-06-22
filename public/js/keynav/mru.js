// Leaf module: localStorage CRUD for MRU worktree order.
// Mirrors term-macros.js tolerance exactly:
//   - corrupt/missing data → empty list (never throws)
//   - quota errors on write are swallowed
// Single key under the existing localStorage namespace.
// No DOM, no app imports — keeps the graph a DAG.

const STORAGE_KEY = 'localpm.navMru';
const MAX_MRU = 50; // cap so the list never grows unbounded

// Tolerant read: anything that doesn't parse into an array of strings → [].
export function loadMru() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p === 'string');
  } catch {
    return [];
  }
}

function saveMru(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — MRU just won't persist this session */
  }
}

// Record a worktree path as the most recently used.
// Moves existing entry to the front (deduplication) or prepends a new one.
// Caps at MAX_MRU entries.
export function recordMru(path) {
  if (!path || typeof path !== 'string') return;
  const list = loadMru().filter((p) => p !== path);
  list.unshift(path);
  saveMru(list.slice(0, MAX_MRU));
}
