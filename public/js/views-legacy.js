// Phase-1 throwaway: the CURRENT flat-list renderer moved verbatim out of
// index.html. Deleted in Phase 2 when sidebar.js + main-pane.js replace it.
import { post, projectsByName, apiSendChecked, refreshAfterMutation } from './api.js';
import { groupByProject, runningPaths, lanUrlForPort } from './grouping.js';
import { openConsoles, toggleConsole, makeConsolePanel } from './console-panel.js';
import { openTerminal } from './terminals.js';
import {
  getOpenEditRoot,
  setOpenEditRoot,
  captureEditValues,
  renderEditForm,
  openEditForm,
} from './add-project.js';

function makeRunningRow(state, srv) {
  const row = document.createElement('div');
  row.className = 'row active';
  const url = lanUrlForPort(state, srv.port);
  row.innerHTML =
    `<span class="branch">${srv.branch ?? srv.path}</span>` +
    `<span class="port">● ${srv.port != null ? 'port ' + srv.port : 'starting…'}</span>` +
    `<span class="path" title="${srv.path}">${srv.path}</span>`;
  const open = makeOpenLink(url);
  row.appendChild(open);
  const consoleBtn = document.createElement('button');
  consoleBtn.textContent = openConsoles.has(srv.path) ? 'Hide console' : 'Open console';
  consoleBtn.onclick = () => toggleConsole(srv.path);
  row.appendChild(consoleBtn);
  const stop = document.createElement('button');
  stop.className = 'stop';
  stop.textContent = 'Stop';
  stop.onclick = () => post('/api/stop', { path: srv.path });
  row.appendChild(stop);
  // Per-target ad-hoc command: each running server has its own input, scoped
  // to srv.path, so commanding one server never blocks another.
  row.appendChild(makeFreeFormInput({ path: srv.path, branch: srv.branch ?? srv.path }, false));
  return row;
}

export function renderRunning(state) {
  const container = document.getElementById('running');
  // Preserve open console panels across re-renders: capture their nodes (with
  // text + scroll position) before clearing, then re-attach the same elements
  // so they don't flash empty or lose scroll on every poll.
  const savedConsoles = new Map();
  for (const pre of container.querySelectorAll('pre[data-console]')) {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    savedConsoles.set(pre.dataset.console, { pre, scrollTop: pre.scrollTop, atBottom });
  }
  container.innerHTML = '';
  const running = state.running ?? [];
  if (running.length === 0) return;
  const h2 = document.createElement('h2');
  h2.textContent = 'Running servers';
  const stopAllBtn = document.createElement('button');
  stopAllBtn.className = 'stop';
  stopAllBtn.textContent = 'Stop all';
  stopAllBtn.onclick = () => post('/api/stop');
  h2.appendChild(stopAllBtn);
  container.appendChild(h2);
  for (const srv of running) {
    container.appendChild(makeRunningRow(state, srv));
    if (!openConsoles.has(srv.path)) continue;
    const saved = savedConsoles.get(srv.path);
    const pre = saved ? saved.pre : makeConsolePanel(srv.path);
    container.appendChild(pre);
    if (saved) pre.scrollTop = saved.atBottom ? pre.scrollHeight : saved.scrollTop;
  }
}

function makeCommandButton(w, c, busy) {
  const btn = document.createElement('button');
  btn.textContent = c.label;
  btn.onclick = () => post('/api/command', { path: w.path, cmd: c.cmd, label: c.label });
  btn.disabled = busy;
  return btn;
}

function makeFreeFormInput(w, busy) {
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

function makeOpenLink(lanUrl) {
  const link = document.createElement('a');
  link.className = 'open';
  link.href = lanUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open';
  link.title = lanUrl;
  return link;
}

function makeRow(w, running, busy) {
  const isRunning = running.has(w.path);
  const row = document.createElement('div');
  row.className = 'row' + (isRunning ? ' active' : '');
  row.innerHTML =
    `<span class="branch">${w.branch}</span>` +
    `<span class="path" title="${w.path}">${w.path}</span>`;
  // A running server is controlled from the "Running servers" section above;
  // this row just shows its state. Stopped rows get Start + command controls.
  if (isRunning) {
    row.insertAdjacentHTML('beforeend', '<span class="running">● running</span>');
    return row;
  }
  // Show the command that Start will spawn so it is visible before any spawn.
  const project = projectsByName.get(w.project);
  const devCmd = project?.devCmd ?? 'npm run dev';
  const devSpan = document.createElement('span');
  devSpan.className = 'devcmd';
  devSpan.innerHTML = `starts: <code>${devCmd}</code>`;
  row.appendChild(devSpan);
  for (const c of w.commands ?? []) row.appendChild(makeCommandButton(w, c, busy));
  row.appendChild(makeFreeFormInput(w, busy));
  const btn = document.createElement('button');
  btn.className = 'start';
  btn.textContent = 'Start';
  btn.onclick = () => post('/api/start', { path: w.path });
  btn.disabled = busy;
  row.appendChild(btn);
  const shellBtn = document.createElement('button');
  shellBtn.textContent = '＋ Shell';
  shellBtn.onclick = () => openTerminal(w.path, 'shell');
  row.appendChild(shellBtn);
  const claudeBtn = document.createElement('button');
  claudeBtn.textContent = '＋ Claude';
  claudeBtn.onclick = () => openTerminal(w.path, 'claude');
  row.appendChild(claudeBtn);
  return row;
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

export function renderProjects(state, busy) {
  const container = document.getElementById('projects');
  const focused = captureFocusedFreeForm(container);
  // Preserve in-progress edits across the rebuild below.
  const editSeed = getOpenEditRoot() ? captureEditValues(container) : null;
  const running = runningPaths(state);
  container.innerHTML = '';
  for (const [project, worktrees] of groupByProject(state.worktrees)) {
    const configured = projectsByName.get(project);
    const section = document.createElement('div');
    section.className = 'project';
    section.appendChild(makeProjectHeader(configured, project));
    for (const w of worktrees) section.appendChild(makeRow(w, running, busy));
    // Re-render an open Edit form so a poll-driven rebuild does not wipe it.
    if (configured && getOpenEditRoot() === configured.root) renderEditForm(section, configured, editSeed);
    container.appendChild(section);
  }
  // Drop tracker if its project no longer renders (e.g. removed elsewhere).
  if (getOpenEditRoot() && !container.querySelector('.setup-form')) setOpenEditRoot(null);
  restoreFocusedFreeForm(container, focused);
}

function makeProjectHeader(project, projectName) {
  const h2 = document.createElement('h2');
  h2.textContent = projectName;
  if (!project) return h2;
  const icons = document.createElement('span');
  icons.className = 'row-icons';
  icons.style.marginLeft = 'auto';
  const edit = document.createElement('button');
  edit.className = 'icon';
  edit.title = 'Edit project';
  edit.textContent = '✎';
  const remove = document.createElement('button');
  remove.className = 'icon remove';
  remove.title = 'Remove project';
  remove.textContent = '×';
  icons.append(edit, remove);
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.appendChild(h2);
  wrap.appendChild(icons);
  edit.onclick = () => openEditForm(wrap.parentElement, project);
  remove.onclick = async () => {
    if (!confirm('Remove project ' + project.name + '?')) return;
    const ok = await apiSendChecked('DELETE', '/api/projects', { root: project.root }, 'remove project');
    if (ok) refreshAfterMutation();
  };
  return wrap;
}
