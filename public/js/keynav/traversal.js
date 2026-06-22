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

// Flatten every worktree across all non-empty projects into one ordered list,
// matching the sidebar's top-to-bottom order.
function flattenWorktrees(state) {
  const flat = [];
  for (const [, wts] of nonEmptyProjects(state)) flat.push(...wts);
  return flat;
}

// Move to the next (+1) or previous (-1) worktree across the WHOLE tree, crossing
// project boundaries. Wraps at both ends. With no worktree selected, the first
// move lands on the first (down) or last (up) worktree. Returns a worktree path,
// or null if the tree is empty.
export function adjacentInTree(state, sel, delta) {
  const flat = flattenWorktrees(state);
  if (flat.length === 0) return null;

  let idx = -1;
  if (sel && sel.type === 'worktree') idx = flat.findIndex((w) => w.path === sel.path);
  if (idx === -1) return delta > 0 ? flat[0].path : flat[flat.length - 1].path;
  return flat[wrap(idx, flat.length, delta)].path;
}

// Convenience wrappers used by keynav.js for readability.
export function nextProject(state, sel) { return adjacentProject(state, sel, +1); }
export function prevProject(state, sel) { return adjacentProject(state, sel, -1); }
export function nextInTree(state, sel) { return adjacentInTree(state, sel, +1); }
export function prevInTree(state, sel) { return adjacentInTree(state, sel, -1); }
