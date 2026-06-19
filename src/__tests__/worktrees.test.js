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

test('getWorktrees: plain (non-git) project yields exactly one synthetic root row', async () => {
  // A path that exists but is not a git repo → `git worktree list` fails, so the
  // project must contribute a single synthetic row at its own root.
  const root = 'C:/Windows';
  const projects = [{ name: 'plainy', root, type: 'plain', exists: true }];
  const result = await getWorktrees(projects);
  assert.equal(result.length, 1, 'exactly one synthetic row');
  const [row] = result;
  assert.equal(row.project, 'plainy');
  assert.equal(row.path, root);
  assert.equal(row.branch, 'plain', 'branch label falls back to project type');
  assert.equal(typeof row.hasNodeModules, 'boolean');
  assert.ok(Array.isArray(row.commands));
});

test('getWorktrees: git project with worktrees is unchanged (no synthetic row added)', async () => {
  // This repo IS a git worktree, so it yields real rows — none synthetic, none
  // labelled with the project type, and never duplicated to a single root row.
  const projects = [{ name: 'self', root: 'C:/proyectos/local_pm', type: 'plain', exists: true }];
  const result = await getWorktrees(projects);
  assert.ok(result.length >= 1);
  assert.ok(result.some((w) => w.branch !== 'plain'), 'real branch labels present, not the synthetic type');
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
