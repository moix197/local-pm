import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByProject, runningPaths, lanUrlForPort } from './grouping.js';

test('groupByProject groups worktrees by project, preserving order', () => {
  const worktrees = [
    { project: 'alpha', path: '/a/1' },
    { project: 'beta', path: '/b/1' },
    { project: 'alpha', path: '/a/2' },
  ];
  const map = groupByProject(worktrees);
  assert.deepEqual([...map.keys()], ['alpha', 'beta']);
  assert.deepEqual(map.get('alpha').map((w) => w.path), ['/a/1', '/a/2']);
  assert.deepEqual(map.get('beta').map((w) => w.path), ['/b/1']);
});

test('groupByProject returns an empty map for empty input', () => {
  const map = groupByProject([]);
  assert.equal(map.size, 0);
});

test('runningPaths returns a Set of running paths', () => {
  const set = runningPaths({ running: [{ path: '/a/1' }, { path: '/b/1' }] });
  assert.ok(set.has('/a/1'));
  assert.ok(set.has('/b/1'));
  assert.ok(!set.has('/c/1'));
  assert.equal(set.size, 2);
});

test('runningPaths returns an empty Set when state.running is missing', () => {
  const set = runningPaths({});
  assert.equal(set.size, 0);
});

test('lanUrlForPort swaps the port when a port is given', () => {
  const state = { lanUrl: 'http://192.168.1.5:7420' };
  assert.equal(lanUrlForPort(state, 3000), 'http://192.168.1.5:3000');
});

test('lanUrlForPort returns state.lanUrl unchanged when port is null', () => {
  const state = { lanUrl: 'http://192.168.1.5:7420' };
  assert.equal(lanUrlForPort(state, null), 'http://192.168.1.5:7420');
});
