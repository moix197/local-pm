import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assignPort, releasePort } from '../ports.js';

const POOL_START = 3100;
const POOL_END = 3199;

// Tracks paths assigned within a test so afterEach can free the shared pool.
const assignedInTest = new Set();

function assign(path) {
  assignedInTest.add(path);
  return assignPort(path);
}

afterEach(() => {
  for (const path of assignedInTest) releasePort(path);
  assignedInTest.clear();
});

describe('assignPort', () => {
  it('allocates distinct ports for distinct paths', () => {
    const a = assign('C:\\wt\\a');
    const b = assign('C:\\wt\\b');
    const c = assign('C:\\wt\\c');
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
    for (const port of [a, b, c]) {
      assert.ok(port >= POOL_START && port <= POOL_END, `port ${port} within pool`);
    }
  });

  it('returns the same port when called again for an already-assigned path', () => {
    const first = assign('C:\\wt\\same');
    const second = assign('C:\\wt\\same');
    assert.equal(first, second);
  });

  it('throws a descriptive error when the pool is exhausted', () => {
    // Fill every slot.
    for (let i = 0; i <= POOL_END - POOL_START; i += 1) assign('C:\\wt\\fill-' + i);
    assert.throws(
      () => assign('C:\\wt\\overflow'),
      /pool exhausted/i,
      'exhausted pool must throw',
    );
  });
});

describe('releasePort', () => {
  it('frees the slot so the same port can be reassigned', () => {
    const path = 'C:\\wt\\release';
    const port = assign(path);
    releasePort(path);
    assignedInTest.delete(path);
    // After release, a brand-new path should be able to take that exact port
    // (it is the lowest free slot again once nothing else is allocated).
    const reclaimed = assign('C:\\wt\\reclaim');
    assert.equal(reclaimed, port, 'released port is reusable');
  });

  it('is a no-op for an unknown path', () => {
    assert.doesNotThrow(() => releasePort('C:\\wt\\never-assigned'));
  });
});
