// Pure index math over the grouped project/worktree tree. No DOM, no side effects.
// Imports grouping.js only — keeps the DAG clean.

import { groupByProject } from '../grouping.js';

// Build an ordered list of [projectName, worktrees[]] pairs from state.
// Filters out projects with zero worktrees so they never surface as targets.
function nonEmptyProjects(state) {
  const worktrees = state.worktrees ?? [];
  const grouped = groupByProject(worktrees);
  return Array.from(grouped.entries()).filter(([, wts]) => wts.length > 0);
}

// Find which project the current selection belongs to. Returns the project index
// in the nonEmptyProjects list, or -1 if not found.
function currentProjectIndex(projects, sel) {
  if (!sel) return -1;
  if (sel.type === 'project') return projects.findIndex(([name]) => name === sel.path);
  // worktree: find which project it belongs to
  return projects.findIndex(([, wts]) => wts.some((w) => w.path === sel.path));
}

// Advance an index by delta with wrapping.
function wrap(index, len, delta) {
  return ((index + delta) % len + len) % len;
}

// Move to the next project (+1) or previous project (-1).
// Returns the project name, or null if tree is empty.
export function adjacentProject(state, sel, delta) {
  const projects = nonEmptyProjects(state);
  if (projects.length === 0) return null;

  let idx = currentProjectIndex(projects, sel);
  // If nothing selected, delta=+1 starts at 0, delta=-1 starts at last.
  if (idx === -1) idx = delta > 0 ? projects.length - 1 : 0;
  const next = wrap(idx, projects.length, delta);
  return projects[next][0];
}

// Move to the next worktree (+1) or previous worktree (-1) within the selected
// project. Wraps at both ends. Returns a worktree path, or null if no project
// is selected or the project has no worktrees.
export function adjacentWorktree(state, sel, delta) {
  const projects = nonEmptyProjects(state);
  if (projects.length === 0) return null;
  if (!sel) return null;

  const projectIdx = currentProjectIndex(projects, sel);
  if (projectIdx === -1) return null;

  const [, worktrees] = projects[projectIdx];
  if (worktrees.length === 0) return null;

  let wtIdx = -1;
  if (sel.type === 'worktree') {
    wtIdx = worktrees.findIndex((w) => w.path === sel.path);
  }
  // If selection is on the project itself or worktree not found, start at edge.
  if (wtIdx === -1) wtIdx = delta > 0 ? worktrees.length - 1 : 0;
  const next = wrap(wtIdx, worktrees.length, delta);
  return worktrees[next].path;
}

// Convenience wrappers used by keynav.js for readability.
export function nextProject(state, sel) { return adjacentProject(state, sel, +1); }
export function prevProject(state, sel) { return adjacentProject(state, sel, -1); }
export function nextWorktree(state, sel) { return adjacentWorktree(state, sel, +1); }
export function prevWorktree(state, sel) { return adjacentWorktree(state, sel, -1); }
