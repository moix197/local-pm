import { test } from 'node:test';
import assert from 'node:assert/strict';

// app-events.js is imported transitively by selection.js and touches no DOM at
// module load, so it is safe to import under node:test.
import {
  resolveSelection,
  resolveProjectLanding,
  firstRunningOrFirst,
  isSelected,
  toggleProjectCollapse,
  collapsedProjects,
  setSelected,
} from './selection.js';

test('resolveSelection returns null for empty state', () => {
  assert.equal(resolveSelection({ worktrees: [], running: [] }, null), null);
  assert.equal(resolveSelection({}, null), null);
});

test('resolveSelection defaults to the first running worktree', () => {
  const state = {
    worktrees: [{ project: 'a', path: '/a/1' }, { project: 'a', path: '/a/2' }],
    running: [{ path: '/a/2' }],
  };
  assert.deepEqual(resolveSelection(state, null), { type: 'worktree', path: '/a/2' });
});

test('resolveSelection falls back to the first worktree when none run', () => {
  const state = {
    worktrees: [{ project: 'a', path: '/a/1' }, { project: 'a', path: '/a/2' }],
    running: [],
  };
  assert.deepEqual(resolveSelection(state, null), { type: 'worktree', path: '/a/1' });
});

test('resolveSelection keeps an explicit valid worktree selection', () => {
  const state = {
    worktrees: [{ project: 'a', path: '/a/1' }, { project: 'a', path: '/a/2' }],
    running: [{ path: '/a/1' }],
  };
  const sel = { type: 'worktree', path: '/a/2' };
  assert.deepEqual(resolveSelection(state, sel), sel);
});

test('resolveSelection keeps an explicit valid project selection', () => {
  const state = { worktrees: [{ project: 'a', path: '/a/1' }], running: [] };
  const sel = { type: 'project', path: 'a' };
  assert.deepEqual(resolveSelection(state, sel), sel);
});

test('resolveSelection drops a selection whose worktree disappeared, falling back', () => {
  // A running server's worktree vanished from state.worktrees → must not be kept,
  // and must not be chosen as the running default either.
  const state = {
    worktrees: [{ project: 'a', path: '/a/1' }],
    running: [{ path: '/gone' }],
  };
  const sel = { type: 'worktree', path: '/gone' };
  assert.deepEqual(resolveSelection(state, sel), { type: 'worktree', path: '/a/1' });
});

test('resolveSelection drops a selection whose project was removed', () => {
  const state = { worktrees: [{ project: 'a', path: '/a/1' }], running: [] };
  const sel = { type: 'project', path: 'gone' };
  assert.deepEqual(resolveSelection(state, sel), { type: 'worktree', path: '/a/1' });
});

test('isSelected matches on type + path only', () => {
  setSelected({ type: 'worktree', path: '/a/1' });
  assert.ok(isSelected({ type: 'worktree', path: '/a/1' }));
  assert.ok(!isSelected({ type: 'worktree', path: '/a/2' }));
  assert.ok(!isSelected({ type: 'project', path: '/a/1' }));
  setSelected(null);
  assert.ok(!isSelected({ type: 'worktree', path: '/a/1' }));
});

test('toggleProjectCollapse flips set membership', () => {
  collapsedProjects.clear();
  assert.ok(!collapsedProjects.has('a'));
  toggleProjectCollapse('a');
  assert.ok(collapsedProjects.has('a'));
  toggleProjectCollapse('a');
  assert.ok(!collapsedProjects.has('a'));
});

// ─── firstRunningOrFirst ────────────────────────────────────────────────────

test('firstRunningOrFirst returns the first running worktree', () => {
  const wts = [{ project: 'a', path: '/a/1' }, { project: 'a', path: '/a/2' }];
  const running = new Set(['/a/2']);
  assert.deepEqual(firstRunningOrFirst(wts, running), { type: 'worktree', path: '/a/2' });
});

test('firstRunningOrFirst falls back to first when none running', () => {
  const wts = [{ project: 'a', path: '/a/1' }, { project: 'a', path: '/a/2' }];
  assert.deepEqual(firstRunningOrFirst(wts, new Set()), { type: 'worktree', path: '/a/1' });
});

test('firstRunningOrFirst returns null for empty list', () => {
  assert.equal(firstRunningOrFirst([], new Set()), null);
});

// ─── resolveProjectLanding ──────────────────────────────────────────────────

test('resolveProjectLanding returns first running worktree in project', () => {
  const state = {
    worktrees: [
      { project: 'a', path: '/a/1' },
      { project: 'a', path: '/a/2' },
      { project: 'b', path: '/b/1' },
    ],
    running: [{ path: '/a/2' }],
  };
  assert.deepEqual(resolveProjectLanding(state, 'a'), { type: 'worktree', path: '/a/2' });
});

test('resolveProjectLanding falls back to first worktree when none running', () => {
  const state = {
    worktrees: [
      { project: 'a', path: '/a/1' },
      { project: 'a', path: '/a/2' },
    ],
    running: [],
  };
  assert.deepEqual(resolveProjectLanding(state, 'a'), { type: 'worktree', path: '/a/1' });
});

test('resolveProjectLanding returns null for project with zero worktrees', () => {
  const state = { worktrees: [{ project: 'b', path: '/b/1' }], running: [] };
  assert.equal(resolveProjectLanding(state, 'a'), null);
});

test('resolveProjectLanding ignores running servers from other projects', () => {
  const state = {
    worktrees: [
      { project: 'a', path: '/a/1' },
      { project: 'b', path: '/b/1' },
    ],
    running: [{ path: '/b/1' }],
  };
  // project 'a' has no running server → falls back to first
  assert.deepEqual(resolveProjectLanding(state, 'a'), { type: 'worktree', path: '/a/1' });
});
