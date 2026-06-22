import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextProject, prevProject, nextInTree, prevInTree } from './traversal.js';

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

test('empty tree: nextInTree returns null', () => {
  assert.equal(nextInTree(state([]), null), null);
});

test('empty tree: prevInTree returns null', () => {
  assert.equal(prevInTree(state([]), null), null);
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

// ─── worktree traversal across the whole tree (crosses project boundaries) ───
test('nextInTree moves to next worktree within a project', () => {
  const sel = { type: 'worktree', path: '/alpha/main' };
  assert.equal(nextInTree(threeProjects, sel), '/alpha/feat');
});

test('nextInTree crosses into the next project at a project boundary', () => {
  const sel = { type: 'worktree', path: '/alpha/feat' };
  assert.equal(nextInTree(threeProjects, sel), '/beta/main');
});

test('nextInTree wraps from the last worktree to the first', () => {
  const sel = { type: 'worktree', path: '/gamma/main' };
  assert.equal(nextInTree(threeProjects, sel), '/alpha/main');
});

test('prevInTree crosses back into the previous project', () => {
  const sel = { type: 'worktree', path: '/beta/main' };
  assert.equal(prevInTree(threeProjects, sel), '/alpha/feat');
});

test('prevInTree wraps from the first worktree to the last', () => {
  const sel = { type: 'worktree', path: '/alpha/main' };
  assert.equal(prevInTree(threeProjects, sel), '/gamma/main');
});

test('nextInTree from null selection lands on the first worktree', () => {
  assert.equal(nextInTree(threeProjects, null), '/alpha/main');
});

test('prevInTree from null selection lands on the last worktree', () => {
  assert.equal(prevInTree(threeProjects, null), '/gamma/main');
});

test('nextInTree with an unknown selection starts at the first worktree', () => {
  const sel = { type: 'worktree', path: '/vanished/path' };
  assert.equal(nextInTree(threeProjects, sel), '/alpha/main');
});

// ─── single worktree in the whole tree ───────────────────────────────────────
test('single worktree: nextInTree wraps to same worktree', () => {
  const s = state([wt('p', '/p/main')]);
  const sel = { type: 'worktree', path: '/p/main' };
  assert.equal(nextInTree(s, sel), '/p/main');
});

test('single worktree: prevInTree wraps to same worktree', () => {
  const s = state([wt('p', '/p/main')]);
  const sel = { type: 'worktree', path: '/p/main' };
  assert.equal(prevInTree(s, sel), '/p/main');
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

