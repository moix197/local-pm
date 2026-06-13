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

test('parseWorktreePorcelain: bare worktree yields (bare)', () => {
  const stdout = ['worktree C:/proyectos/app', 'bare', ''].join('\n');
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: 'C:/proyectos/app', branch: '(bare)' },
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

test('getWorktrees: empty project list yields empty result', async () => {
  assert.deepEqual(await getWorktrees([]), []);
});

test('getWorktrees: non-existent project root contributes nothing (no throw)', async () => {
  const projects = [
    { name: 'ghost', root: 'C:/this/path/does/not/exist', exists: false },
  ];
  const result = await getWorktrees(projects);
  assert.deepEqual(result, []);
});

test('getWorktrees: groups worktrees per project and skips missing roots', async () => {
  const projects = [
    { name: 'present', root: 'C:/proyectos/local_pm', exists: true },
    { name: 'absent', root: 'C:/nope', exists: false },
  ];
  const result = await getWorktrees(projects);
  assert.ok(Array.isArray(result));
  // No worktree may originate from the project whose root is missing.
  assert.ok(result.every((w) => w.project !== 'absent'));
  // Every entry carries the expected, fully-resolved shape.
  for (const w of result) {
    assert.equal(w.project, 'present');
    assert.equal(typeof w.branch, 'string');
    assert.equal(typeof w.path, 'string');
    assert.equal(typeof w.hasNodeModules, 'boolean');
  }
});
