import { test } from 'node:test';
import assert from 'node:assert/strict';

// app-events.js is imported transitively by selection.js and touches no DOM at
// module load, so it is safe to import under node:test.
import {
  resolveSelection,
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
