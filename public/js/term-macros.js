// Leaf module: localStorage CRUD for user-defined terminal text macros.
// No DOM, no imports of other app modules — keeps the graph a DAG.
// Macros are a global list shared across all terminal groups, stored as a JSON
// array of { label, text } under one key.

const STORAGE_KEY = 'localpm.termMacros';

// Tolerant of corrupt/missing data: anything that doesn't parse into an array of
// {label, text} strings yields an empty list rather than throwing.
export function loadMacros() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m) => m && typeof m.label === 'string' && typeof m.text === 'string')
      .map((m) => ({ label: m.label, text: m.text }));
  } catch {
    return [];
  }
}

// Tolerant of disabled/full storage (e.g. Safari private mode, quota) so adding
// a macro from a button handler never throws — parity with loadMacros.
function saveMacros(macros) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(macros));
  } catch {
    /* storage unavailable — macro just won't persist this session */
  }
}

// Returns the updated list. No-op (returns current list) when the label is empty
// after trimming or the text is empty/whitespace-only. The label is stored
// trimmed; the text is stored verbatim (only its emptiness check trims).
export function addMacro(label, text) {
  const trimmedLabel = (label ?? '').trim();
  if (!trimmedLabel || !(text ?? '').trim()) return loadMacros();
  const macros = loadMacros();
  macros.push({ label: trimmedLabel, text });
  saveMacros(macros);
  return macros;
}

// Identity-based delete: re-reads storage and removes the FIRST entry whose
// label AND text both match, so a concurrent change to the list can't delete the
// wrong macro by stale index. Returns the updated list.
export function removeMacro(macro) {
  const macros = loadMacros();
  const i = macros.findIndex((m) => m.label === macro.label && m.text === macro.text);
  if (i < 0) return macros;
  macros.splice(i, 1);
  saveMacros(macros);
  return macros;
}
