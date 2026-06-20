// Selection + collapse state for the sidebar/main-pane split. The pure
// `resolveSelection` is unit-tested; the mutating helpers drive a re-render via
// app-events.js so this module never imports main.js (keeps the graph a DAG).
import { requestRender } from './app-events.js';

// Currently selected item: { type: 'project' | 'worktree', path } or null.
// For a project, `path` is the project name (the sidebar grouping key); for a
// worktree it is the worktree path.
export let selected = null;

// Set of project names whose worktree list is collapsed in the sidebar.
export const collapsedProjects = new Set();

export function setSelected(value) {
  selected = value;
}

export function selectItem(item) {
  selected = item;
  requestRender();
}

export function isSelected(item) {
  return (
    selected != null &&
    item != null &&
    selected.type === item.type &&
    selected.path === item.path
  );
}

export function toggleProjectCollapse(project) {
  if (collapsedProjects.has(project)) collapsedProjects.delete(project);
  else collapsedProjects.add(project);
  requestRender();
}

// Pick a valid selection for the current state: keep an explicit selection if it
// still exists, otherwise default to the first running worktree, else the first
// worktree, else null. Pure — no side effects, so it is unit-testable.
export function resolveSelection(state, sel) {
  const worktrees = state.worktrees ?? [];
  if (sel) {
    if (sel.type === 'worktree' && worktrees.some((w) => w.path === sel.path)) return sel;
    if (sel.type === 'project' && worktrees.some((w) => w.project === sel.path)) return sel;
  }
  const running = state.running ?? [];
  const firstRunning = running.find((r) => worktrees.some((w) => w.path === r.path));
  if (firstRunning) return { type: 'worktree', path: firstRunning.path };
  if (worktrees.length > 0) return { type: 'worktree', path: worktrees[0].path };
  return null;
}
