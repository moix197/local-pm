// Quick-nav command palette: top-center overlay, fuzzy worktree search, MRU-first.
// Mounted on document.body OUTSIDE the re-rendered sidebar/main subtree so the
// 2s poll never tears it down or steals focus from the open input.
//
// DAG: imports fuzzy.js, mru.js, selection.js, grouping.js, app-events.js.
// Nothing here imports main.js.

import { score } from './fuzzy.js';
import { loadMru, recordMru } from './mru.js';
import { selectItem, expandProject } from '../selection.js';
import { runningPaths } from '../grouping.js';
import * as appEvents from '../app-events.js';

// ── DOM references (created once, reused) ───────────────────────────────────
let _overlay = null;
let _input = null;
let _list = null;
let _highlightIndex = 0;
let _rows = []; // current built row data: [{path, label, running}]

// ── Build the overlay DOM once ───────────────────────────────────────────────
function ensureOverlay() {
  if (_overlay) return;

  _overlay = document.createElement('div');
  _overlay.id = 'paletteOverlay';
  _overlay.className = 'overlay palette-overlay hidden';
  // Stop clicks on the backdrop from propagating and triggering anything.
  _overlay.addEventListener('mousedown', (e) => {
    if (e.target === _overlay) closePalette();
  });

  const panel = document.createElement('div');
  panel.className = 'overlay-panel palette-panel';

  _input = document.createElement('input');
  _input.type = 'text';
  _input.className = 'palette-input';
  _input.placeholder = 'Jump to worktree…';
  _input.setAttribute('autocomplete', 'off');
  _input.setAttribute('spellcheck', 'false');
  _input.addEventListener('input', onInputChange);
  _input.addEventListener('keydown', onInputKeydown);

  _list = document.createElement('ul');
  _list.className = 'palette-list';

  panel.appendChild(_input);
  panel.appendChild(_list);
  _overlay.appendChild(panel);
  document.body.appendChild(_overlay);
}

// ── Build candidate rows from latest state ───────────────────────────────────
function buildCandidates() {
  const state = appEvents.lastState;
  if (!state) return [];
  const worktrees = state.worktrees ?? [];
  const running = runningPaths(state);
  return worktrees.map((w) => ({
    path: w.path,
    label: `${w.project} / ${w.branch}`,
    running: running.has(w.path),
  }));
}

// ── Order candidates: MRU-first on empty query, fuzzy-ranked on non-empty ───
function orderedRows(candidates, query) {
  if (!query.trim()) {
    // Empty query: MRU-first, then remaining in stable order.
    const mru = loadMru();
    // Filter out stale MRU paths not in current candidates.
    const existingPaths = new Set(candidates.map((c) => c.path));
    const mruPaths = mru.filter((p) => existingPaths.has(p));
    const mruSet = new Set(mruPaths);
    // Rows referenced in MRU come first, in MRU order.
    const mruRows = mruPaths.map((p) => candidates.find((c) => c.path === p)).filter(Boolean);
    // Remaining rows (not in MRU) keep stable order.
    const rest = candidates.filter((c) => !mruSet.has(c.path));
    return [...mruRows, ...rest];
  }

  // Non-empty query: fuzzy-rank, omit zero-score rows.
  return candidates
    .map((c) => ({ ...c, _score: score(query, c.label) }))
    .filter((c) => c._score > 0)
    .sort((a, b) => b._score - a._score);
}

// ── Render the list ──────────────────────────────────────────────────────────
function renderList() {
  const query = _input ? _input.value : '';
  const candidates = buildCandidates();
  _rows = orderedRows(candidates, query);
  _list.innerHTML = '';

  if (_rows.length === 0) {
    const hint = document.createElement('li');
    hint.className = 'palette-empty';
    hint.textContent = candidates.length === 0
      ? 'No worktrees. Add a project first.'
      : 'No matches.';
    _list.appendChild(hint);
    _highlightIndex = -1;
    return;
  }

  // Clamp highlight index in case the list shrank.
  if (_highlightIndex >= _rows.length) _highlightIndex = 0;
  if (_highlightIndex < 0) _highlightIndex = 0;

  _rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'palette-row' + (i === _highlightIndex ? ' palette-row-active' : '');
    li.dataset.index = String(i);

    if (row.running) {
      const dot = document.createElement('span');
      dot.className = 'dot on palette-dot';
      li.appendChild(dot);
    } else {
      const dot = document.createElement('span');
      dot.className = 'dot palette-dot';
      li.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = row.label;
    li.appendChild(label);

    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent input blur
      _highlightIndex = i;
      jumpToHighlighted();
    });

    _list.appendChild(li);
  });
}

function updateHighlight(newIndex) {
  _highlightIndex = newIndex;
  const items = _list.querySelectorAll('.palette-row');
  items.forEach((el, i) => {
    el.classList.toggle('palette-row-active', i === _highlightIndex);
  });
  // Scroll highlighted item into view.
  if (items[_highlightIndex]) {
    items[_highlightIndex].scrollIntoView({ block: 'nearest' });
  }
}

// ── Input handlers ───────────────────────────────────────────────────────────
function onInputChange() {
  _highlightIndex = 0;
  renderList();
}

function onInputKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (_rows.length > 0) updateHighlight((_highlightIndex + 1) % _rows.length);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (_rows.length > 0) updateHighlight((_highlightIndex - 1 + _rows.length) % _rows.length);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    jumpToHighlighted();
    return;
  }
}

// ── Jump to selection ────────────────────────────────────────────────────────
function jumpToHighlighted() {
  if (_highlightIndex < 0 || _highlightIndex >= _rows.length) return;
  const row = _rows[_highlightIndex];
  if (!row) return;

  closePalette();

  // Find the project for this worktree to auto-expand.
  const state = appEvents.lastState;
  if (state) {
    const wt = (state.worktrees ?? []).find((w) => w.path === row.path);
    if (wt) expandProject(wt.project);
  }

  selectItem({ type: 'worktree', path: row.path });
  recordMru(row.path);
}

// ── Open / close ─────────────────────────────────────────────────────────────
export function openPalette() {
  ensureOverlay();
  _input.value = '';
  _highlightIndex = 0;
  renderList();
  _overlay.classList.remove('hidden');
  // Focus the input AFTER the overlay is visible.
  requestAnimationFrame(() => _input.focus());
}

export function closePalette() {
  if (!_overlay) return;
  _overlay.classList.add('hidden');
  _input.blur();
}

export function isPaletteOpen() {
  return _overlay !== null && !_overlay.classList.contains('hidden');
}

// Called by the 2s poll (requestRender callback) while the palette is open:
// rebuilds rows without closing or stealing focus.
export function refreshPaletteIfOpen() {
  if (!isPaletteOpen()) return;
  renderList();
}
