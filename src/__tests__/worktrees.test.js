import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreePorcelain, getWorktrees } from '../worktrees.js';

test('parseWorktreePorcelain: normal branch strips refs/heads/ prefix', () => {
  const stdout = ['worktree C:/proyectos/app', 'HEAD abc123', 'branch refs/heads/main', ''].join(
    '\n',
  );
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: 'C:/proyectos/app', branch: 'main' },
  ]);
});

test('parseWorktreePorcelain: detached HEAD yields (detached)', () => {
  const stdout = ['worktree C:/proyectos/app', 'HEAD abc123', 'detached', ''].join('\n');
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: 'C:/proyectos/app', branch: '(detached)' },
  ]);
});

test('parseWorktreePorcelain: bare worktree (no branch line) yields null branch', () => {
  const stdout = ['worktree C:/proyectos/app', 'bare', ''].join('\n');
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: 'C:/proyectos/app', branch: null },
  ]);
});

test('parseWorktreePorcelain: multiple worktrees', () => {
  const stdout = [
    'worktree C:/proyectos/app',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree C:/proyectos/app-feature',
    'HEAD def456',
    'branch refs/heads/feature/x',
    '',
    'worktree C:/proyectos/app-detached',
    'HEAD ghi789',
    'detached',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: 'C:/proyectos/app', branch: 'main' },
    { path: 'C:/proyectos/app-feature', branch: 'feature/x' },
    { path: 'C:/proyectos/app-detached', branch: '(detached)' },
  ]);
});

test('parseWorktreePorcelain: empty output yields empty list', () => {
  assert.deepEqual(parseWorktreePorcelain(''), []);
});

test('getWorktrees: missing project root degrades gracefully (no throw)', async () => {
  // The placeholder projects.json points at a non-existent root, so getWorktrees
  // must resolve to an array without throwing rather than crashing.
  const result = await getWorktrees();
  assert.ok(Array.isArray(result));
});
