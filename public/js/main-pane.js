// Renders the main pane for the selected item (Phase 2: worktree view only).
// Owns the three persistence invariants under the new render path:
//   1. #terminals is a SIBLING of #selectionView, never wiped — terminal groups
//      survive; updateTerminalVisibility toggles display only.
//   2. console <pre data-console> nodes captured (text+scroll) and re-attached.
//   3. focused free-form input value/caret captured + restored; the open edit
//      form is reseeded across the poll.
// Shared control helpers were MOVED VERBATIM from views-legacy.js.
import { post, projectsByName } from './api.js';
import { lanUrlForPort, runningPaths } from './grouping.js';
import { openConsoles, toggleConsole, makeConsolePanel } from './console-panel.js';
import { openTerminal } from './terminals.js';
import {
  getOpenEditRoot,
  setOpenEditRoot,
  captureEditValues,
  renderEditForm,
  openEditForm,
  removeProject,
} from './add-project.js';
import { selectItem } from './selection.js';

export { makeConsolePanel };

// --- Moved verbatim from views-legacy.js --------------------------------

export function makeCommandButton(w, c, busy) {
  const btn = document.createElement('button');
  btn.textContent = c.label;
  btn.onclick = () => post('/api/command', { path: w.path, cmd: c.cmd, label: c.label });
  btn.disabled = busy;
  return btn;
}

export function makeFreeFormInput(w, busy) {
  const form = document.createElement('div');
  form.className = 'cmd-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'custom command…';
  input.disabled = busy;
  input.dataset.cmdPath = w.path;
  const btn = document.createElement('button');
  btn.textContent = 'Run';
  btn.disabled = busy;
  function runFreeForm() {
    const value = input.value.trim();
    if (!value) return;
    if (!confirm('Run ' + value + ' in ' + w.branch + '?')) return;
    post('/api/command', { path: w.path, cmd: value, label: value });
  }
  btn.onclick = runFreeForm;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') runFreeForm(); });
  form.appendChild(input);
  form.appendChild(btn);
  return form;
}

export function makeOpenLink(lanUrl) {
  const link = document.createElement('a');
  link.className = 'open';
  link.href = lanUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open';
  link.title = lanUrl;
  return link;
}

// Extracted from views-legacy's makeRow ＋Shell/＋Claude block.
export function makeShellButtons(w) {
  const wrap = document.createElement('span');
  wrap.className = 'shell-buttons';
  const shellBtn = document.createElement('button');
  shellBtn.textContent = '＋ Shell';
  shellBtn.onclick = () => openTerminal(w.path, 'shell');
  const claudeBtn = document.createElement('button');
  claudeBtn.textContent = '＋ Claude';
  claudeBtn.onclick = () => openTerminal(w.path, 'claude');
  wrap.append(shellBtn, claudeBtn);
  return wrap;
}

function captureFocusedFreeForm(container) {
  const el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.cmdPath) return null;
  if (!container.contains(el)) return null;
  return {
    path: el.dataset.cmdPath,
    value: el.value,
    start: el.selectionStart,
    end: el.selectionEnd,
  };
}

function restoreFocusedFreeForm(container, saved) {
  if (!saved) return;
  const el = container.querySelector(`[data-cmd-path="${CSS.escape(saved.path)}"]`);
  if (!el) return;
  el.value = saved.value;
  el.focus();
  if (saved.start != null) el.setSelectionRange(saved.start, saved.end);
}

// --- Worktree view ------------------------------------------------------

function makeRunningControls(state, srv, w) {
  const frag = document.createDocumentFragment();
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  meta.innerHTML =
    `<span class="port">● ${srv.port != null ? 'port ' + srv.port : 'starting…'}</span>`;
  frag.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.appendChild(makeOpenLink(lanUrlForPort(state, srv.port)));
  const consoleBtn = document.createElement('button');
  consoleBtn.textContent = openConsoles.has(w.path) ? 'Hide console' : 'Open console';
  consoleBtn.onclick = () => toggleConsole(w.path);
  actions.appendChild(consoleBtn);
  const stop = document.createElement('button');
  stop.className = 'stop';
  stop.textContent = 'Stop';
  stop.onclick = () => post('/api/stop', { path: w.path });
  actions.appendChild(stop);
  actions.appendChild(makeShellButtons(w));
  frag.appendChild(actions);

  frag.appendChild(makeFreeFormInput({ path: w.path, branch: w.branch ?? w.path }, false));
  return frag;
}

function makeStoppedControls(w, busy) {
  const frag = document.createDocumentFragment();
  const project = projectsByName.get(w.project);
  const devCmd = project?.devCmd ?? 'npm run dev';
  const devSpan = document.createElement('div');
  devSpan.className = 'detail-meta devcmd';
  devSpan.innerHTML = `starts: <code>${devCmd}</code>`;
  frag.appendChild(devSpan);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const start = document.createElement('button');
  start.className = 'start';
  start.textContent = 'Start';
  start.onclick = () => post('/api/start', { path: w.path });
  start.disabled = busy;
  actions.appendChild(start);
  for (const c of w.commands ?? []) actions.appendChild(makeCommandButton(w, c, busy));
  actions.appendChild(makeShellButtons(w));
  frag.appendChild(actions);

  frag.appendChild(makeFreeFormInput(w, busy));
  return frag;
}

export function renderWorktreeView(container, state, selected, busy, savedConsoles) {
  const worktrees = state.worktrees ?? [];
  const w = worktrees.find((x) => x.path === selected.path);
  if (!w) return;
  const srv = (state.running ?? []).find((r) => r.path === w.path);

  const head = document.createElement('div');
  head.className = 'detail-head';
  head.innerHTML =
    `<span class="detail-branch">${w.branch ?? w.path}</span>` +
    `<span class="detail-path" title="${w.path}">${w.path}</span>`;
  container.appendChild(head);

  container.appendChild(srv ? makeRunningControls(state, srv, w) : makeStoppedControls(w, busy));

  // Re-attach the open console panel for this worktree (capture happens in
  // renderMain before the wipe, so it does not flash empty or lose scroll).
  if (srv && openConsoles.has(w.path)) {
    const saved = savedConsoles?.get(w.path);
    const pre = saved ? saved.pre : makeConsolePanel(w.path);
    container.appendChild(pre);
    if (saved) pre.scrollTop = saved.atBottom ? pre.scrollHeight : saved.scrollTop;
  }
}

// --- Project overview view ----------------------------------------------

// Compact worktree summary row: branch + status, click drills into the
// worktree view via selection.js.
function makeProjectWorktreeRow(w, running) {
  const row = document.createElement('div');
  row.className = 'row link';
  const branch = document.createElement('span');
  branch.className = 'branch';
  branch.textContent = w.branch ?? w.path;
  row.appendChild(branch);
  const status = document.createElement('span');
  const isRunning = running.has(w.path);
  status.className = isRunning ? 'running' : 'devcmd';
  status.textContent = isRunning ? '● running' : 'stopped';
  row.appendChild(status);
  const path = document.createElement('span');
  path.className = 'path';
  path.title = w.path;
  path.textContent = w.path;
  row.appendChild(path);
  row.onclick = () => selectItem({ type: 'worktree', path: w.path });
  return row;
}

// Project header: name + status dot + Edit/Remove icons. Edit/Remove wiring
// reuses add-project.js (openEditForm/removeProject) — the DELETE+confirm logic
// is NOT duplicated here.
function makeProjectHead(container, project, projectName, anyRunning) {
  const head = document.createElement('div');
  head.className = 'detail-head';
  const dot = document.createElement('span');
  dot.className = 'dot' + (anyRunning ? ' on' : '');
  head.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'detail-branch';
  name.textContent = projectName;
  head.appendChild(name);
  if (!project) return head;
  const icons = document.createElement('span');
  icons.className = 'row-icons';
  icons.style.marginLeft = 'auto';
  const edit = document.createElement('button');
  edit.className = 'icon';
  edit.title = 'Edit project';
  edit.textContent = '✎';
  edit.onclick = () => openEditForm(container, project);
  const remove = document.createElement('button');
  remove.className = 'icon remove';
  remove.title = 'Remove project';
  remove.textContent = '×';
  remove.onclick = () => removeProject(project);
  icons.append(edit, remove);
  head.appendChild(icons);
  return head;
}

function renderProjectView(container, state, selected, editSeed) {
  const projectName = selected.path;
  const worktrees = (state.worktrees ?? []).filter((w) => w.project === projectName);
  const running = runningPaths(state);
  const configured = projectsByName.get(projectName);
  const anyRunning = worktrees.some((w) => running.has(w.path));

  container.appendChild(makeProjectHead(container, configured, projectName, anyRunning));
  for (const w of worktrees) container.appendChild(makeProjectWorktreeRow(w, running));

  // Re-render an open Edit form so a poll-driven rebuild does not wipe it.
  if (configured && getOpenEditRoot() === configured.root) renderEditForm(container, configured, editSeed);
}

export function renderMain(state, selected, busy) {
  const container = document.getElementById('selectionView');
  // Invariant 2: capture open console panels (node + scroll) before the wipe.
  const savedConsoles = new Map();
  for (const pre of container.querySelectorAll('pre[data-console]')) {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    savedConsoles.set(pre.dataset.console, { pre, scrollTop: pre.scrollTop, atBottom });
  }
  // Invariant 3: capture the focused free-form input value/caret before the wipe.
  const focused = captureFocusedFreeForm(container);
  // Preserve in-progress edits across the rebuild below (project view only).
  const editSeed = getOpenEditRoot() ? captureEditValues(container) : null;

  container.innerHTML = '';
  if (selected && selected.type === 'worktree') {
    renderWorktreeView(container, state, selected, busy, savedConsoles);
  } else if (selected && selected.type === 'project') {
    renderProjectView(container, state, selected, editSeed);
  } else {
    const empty = document.createElement('div');
    empty.className = 'detail-empty';
    empty.textContent = (state.worktrees ?? []).length
      ? 'Select a worktree from the sidebar.'
      : 'No projects yet. Add one to get started.';
    container.appendChild(empty);
  }

  // Drop the edit tracker if its form no longer renders.
  if (getOpenEditRoot() && !container.querySelector('.setup-form')) setOpenEditRoot(null);
  restoreFocusedFreeForm(container, focused);
}

// Show only the selected worktree's terminal group; hide all others. Never
// rebuilds or disposes a group — toggles style.display so streaming sessions
// survive selection changes and mid-stream polls (invariant 1). The group's
// worktree path is read from its label's title (set in terminals.js), so no
// change to terminals.js is needed.
export function updateTerminalVisibility(selectedPath) {
  const container = document.getElementById('terminals');
  for (const group of container.children) {
    const label = group.querySelector('.group-label');
    const groupPath = label ? label.title : null;
    group.style.display = groupPath === selectedPath ? '' : 'none';
  }
}
