// Renders the left nav tree: each project is a collapsible row, each worktree a
// subrow. Selection + collapse state live in selection.js; running state comes
// from grouping.js. Orchestrated by main.js — never imports main-pane.js.
import { groupByProject, runningPaths } from './grouping.js';
import {
  selectItem,
  isSelected,
  toggleProjectCollapse,
  collapsedProjects,
} from './selection.js';

function statusDot(on) {
  const dot = document.createElement('span');
  dot.className = 'dot' + (on ? ' on' : '');
  return dot;
}

function makeNavWorktree(w, running) {
  const item = { type: 'worktree', path: w.path };
  const row = document.createElement('div');
  row.className = 'nav-worktree' + (isSelected(item) ? ' selected' : '');
  row.title = w.path;
  row.appendChild(statusDot(running.has(w.path)));
  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = w.branch ?? w.path;
  row.appendChild(label);
  row.onclick = () => selectItem(item);
  return row;
}

function makeNavProject(project, worktrees, running) {
  const item = { type: 'project', path: project };
  const collapsed = collapsedProjects.has(project);
  const wrap = document.createElement('div');
  wrap.className = 'nav-project';

  const head = document.createElement('div');
  head.className = 'nav-project-head' + (isSelected(item) ? ' selected' : '');

  const caret = document.createElement('span');
  caret.className = 'caret' + (collapsed ? ' collapsed' : '');
  caret.textContent = '▾';
  // Caret only toggles collapse; stopPropagation so it never also selects.
  caret.onclick = (e) => {
    e.stopPropagation();
    toggleProjectCollapse(project);
  };
  head.appendChild(caret);

  head.appendChild(statusDot(worktrees.some((w) => running.has(w.path))));

  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = project;
  head.appendChild(label);

  // Row click selects the project and expands it (so its worktrees are visible).
  head.onclick = () => {
    collapsedProjects.delete(project);
    selectItem(item);
  };
  wrap.appendChild(head);

  if (!collapsed) {
    const list = document.createElement('div');
    list.className = 'nav-worktrees';
    for (const w of worktrees) list.appendChild(makeNavWorktree(w, running));
    wrap.appendChild(list);
  }
  return wrap;
}

export function renderSidebar(state) {
  const container = document.getElementById('sidebar');
  container.innerHTML = '';
  const running = runningPaths(state);
  for (const [project, worktrees] of groupByProject(state.worktrees ?? [])) {
    container.appendChild(makeNavProject(project, worktrees, running));
  }
}
