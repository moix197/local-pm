import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextProject, prevProject, nextWorktree, prevWorktree } from './traversal.js';

// ─── helpers ───────────────────────────────────────────────────────────────
function state(worktrees) { return { worktrees, running: [] }; }

function wt(project, path) { return { project, path }; }

// ─── empty tree ─────────────────────────────────────────────────────────────
test('empty tree: nextProject returns null', () => {
  assert.equal(nextProject(state([]), null), null);
});

test('empty tree: prevProject returns null', () => {
  assert.equal(prevProject(state([]), null), null);
});

test('empty tree: nextWorktree returns null', () => {
  assert.equal(nextWorktree(state([]), null), null);
});

test('empty tree: prevWorktree returns null', () => {
  assert.equal(prevWorktree(state([]), null), null);
});

// ─── single project ──────────────────────────────────────────────────────────
test('single project: nextProject wraps to same project', () => {
  const s = state([wt('proj-a', '/a/main')]);
  const sel = { type: 'worktree', path: '/a/main' };
  assert.equal(nextProject(s, sel), 'proj-a');
});

test('single project: prevProject wraps to same project', () => {
  const s = state([wt('proj-a', '/a/main')]);
  const sel = { type: 'worktree', path: '/a/main' };
  assert.equal(prevProject(s, sel), 'proj-a');
});

// ─── multi-project traversal + wrap ─────────────────────────────────────────
const threeProjects = state([
  wt('alpha', '/alpha/main'),
  wt('alpha', '/alpha/feat'),
  wt('beta',  '/beta/main'),
  wt('gamma', '/gamma/main'),
]);

test('nextProject advances to next project', () => {
  const sel = { type: 'worktree', path: '/alpha/main' };
  assert.equal(nextProject(threeProjects, sel), 'beta');
});

test('nextProject wraps from last to first', () => {
  const sel = { type: 'worktree', path: '/gamma/main' };
  assert.equal(nextProject(threeProjects, sel), 'alpha');
});

test('prevProject advances to previous project', () => {
  const sel = { type: 'worktree', path: '/beta/main' };
  assert.equal(prevProject(threeProjects, sel), 'alpha');
});

test('prevProject wraps from first to last', () => {
  const sel = { type: 'worktree', path: '/alpha/main' };
  assert.equal(prevProject(threeProjects, sel), 'gamma');
});

test('nextProject works when selection is a project type', () => {
  const sel = { type: 'project', path: 'alpha' };
  assert.equal(nextProject(threeProjects, sel), 'beta');
});

test('prevProject works when selection is a project type', () => {
  const sel = { type: 'project', path: 'alpha' };
  assert.equal(prevProject(threeProjects, sel), 'gamma');
});

test('nextProject from null selection starts at first project', () => {
  // delta=+1 → idx starts at last, +1 wraps to first
  assert.equal(nextProject(threeProjects, null), 'alpha');
});

// ─── worktree traversal within a project ────────────────────────────────────
const twoWorktrees = state([
  wt('proj', '/p/main'),
  wt('proj', '/p/feat'),
]);

test('nextWorktree moves to next worktree', () => {
  const sel = { type: 'worktree', path: '/p/main' };
  assert.equal(nextWorktree(twoWorktrees, sel), '/p/feat');
});

test('nextWorktree wraps from last to first', () => {
  const sel = { type: 'worktree', path: '/p/feat' };
  assert.equal(nextWorktree(twoWorktrees, sel), '/p/main');
});

test('prevWorktree moves to previous worktree', () => {
  const sel = { type: 'worktree', path: '/p/feat' };
  assert.equal(prevWorktree(twoWorktrees, sel), '/p/main');
});

test('prevWorktree wraps from first to last', () => {
  const sel = { type: 'worktree', path: '/p/main' };
  assert.equal(prevWorktree(twoWorktrees, sel), '/p/feat');
});

test('nextWorktree returns null when no selection', () => {
  assert.equal(nextWorktree(twoWorktrees, null), null);
});

test('prevWorktree returns null when no selection', () => {
  assert.equal(prevWorktree(twoWorktrees, null), null);
});

// ─── project with single worktree ────────────────────────────────────────────
test('single worktree: nextWorktree wraps to same worktree', () => {
  const s = state([wt('p', '/p/main')]);
  const sel = { type: 'worktree', path: '/p/main' };
  assert.equal(nextWorktree(s, sel), '/p/main');
});

test('single worktree: prevWorktree wraps to same worktree', () => {
  const s = state([wt('p', '/p/main')]);
  const sel = { type: 'worktree', path: '/p/main' };
  assert.equal(prevWorktree(s, sel), '/p/main');
});

// ─── projects-only-empty-project is skipped (nonEmptyProjects filter) ────────
test('project with zero worktrees is excluded from nextProject traversal', () => {
  // 'empty-proj' has no worktrees → groupByProject will not include it from
  // worktrees[], so it never appears in nonEmptyProjects. We simulate by giving
  // it no entry in worktrees. The two valid projects should be alpha and beta.
  const s = state([
    wt('alpha', '/a/main'),
    wt('beta',  '/b/main'),
    // 'empty-proj' intentionally has no worktrees in this array
  ]);
  const sel = { type: 'worktree', path: '/a/main' };
  assert.equal(nextProject(s, sel), 'beta');
});

// ─── boundary: worktree selection in a project not matching current ───────────
test('nextWorktree returns null when selected worktree not found in any project', () => {
  const s = state([wt('proj', '/p/main')]);
  const sel = { type: 'worktree', path: '/other/vanished' };
  // currentProjectIndex returns -1 → null
  assert.equal(nextWorktree(s, sel), null);
});
