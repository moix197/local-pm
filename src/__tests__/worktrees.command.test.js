import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCommands, getWorktrees } from '../worktrees.js';

const DEFAULTS = [
  { label: 'npm install', cmd: 'npm install' },
  { label: 'npm run build', cmd: 'npm run build' },
  { label: 'npm run lint', cmd: 'npm run lint' },
];

test('mergeCommands: defaults present with no project override', () => {
  assert.deepEqual(mergeCommands(), DEFAULTS);
  assert.deepEqual(mergeCommands([]), DEFAULTS);
});

test('mergeCommands: project commands appended after defaults (EXTENDS)', () => {
  const result = mergeCommands([{ label: 'test', cmd: 'npm test' }]);
  assert.deepEqual(result, [...DEFAULTS, { label: 'test', cmd: 'npm test' }]);
});

test('mergeCommands: dedupe by label — project entry wins on collision', () => {
  const result = mergeCommands([{ label: 'npm run lint', cmd: 'pnpm lint' }]);
  // Same length as defaults (no new entry), but lint cmd overridden.
  assert.equal(result.length, DEFAULTS.length);
  const lint = result.find((c) => c.label === 'npm run lint');
  assert.equal(lint.cmd, 'pnpm lint');
});

test('toWorktree (via getWorktrees) attaches resolved commands', async () => {
  const projects = [
    { name: 'present', root: 'C:/proyectos/local_pm', exists: true, commands: [{ label: 'test', cmd: 'npm test' }] },
  ];
  const result = await getWorktrees(projects);
  assert.ok(result.length > 0, 'expected at least one worktree for this repo');
  for (const w of result) {
    assert.ok(Array.isArray(w.commands));
    assert.deepEqual(w.commands.slice(0, 3), DEFAULTS);
    assert.deepEqual(w.commands[w.commands.length - 1], { label: 'test', cmd: 'npm test' });
  }
});
