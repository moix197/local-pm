import { test } from 'node:test';
import assert from 'node:assert/strict';

// term-sessions.js touches localStorage at call time (not import time), but stub
// it before the dynamic import anyway so the module never sees an undefined
// global. The stub is a minimal Map-backed shim with the three methods used.
const store = new Map();
let setItemThrows = false;
globalThis.localStorage = {
  store,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (setItemThrows) throw new Error('storage unavailable');
    store.set(k, v);
  },
  removeItem: (k) => store.delete(k),
};

const { loadSessions, getSession, setSession, removeSession } = await import('./term-sessions.js');

const KEY = 'localpm.termSessions';
function reset() {
  store.clear();
  setItemThrows = false;
}

test('loadSessions returns {} when storage is empty', () => {
  reset();
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions returns {} on corrupt JSON', () => {
  reset();
  store.set(KEY, '{not json');
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions returns {} when JSON is not an object', () => {
  reset();
  store.set(KEY, JSON.stringify([{ sessionId: 'a', kind: 'claude' }]));
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions returns {} when JSON is null', () => {
  reset();
  store.set(KEY, 'null');
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions drops entry with non-string value (bare string)', () => {
  reset();
  store.set(KEY, JSON.stringify({ '/path/a': 'not-an-object' }));
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions drops entry missing sessionId', () => {
  reset();
  store.set(KEY, JSON.stringify({ '/path/a': { kind: 'claude' } }));
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions drops entry missing kind', () => {
  reset();
  store.set(KEY, JSON.stringify({ '/path/a': { sessionId: 'abc' } }));
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions drops entry with non-string sessionId', () => {
  reset();
  store.set(KEY, JSON.stringify({ '/path/a': { sessionId: 42, kind: 'shell' } }));
  assert.deepEqual(loadSessions(), {});
});

test('loadSessions drops malformed entries, keeping valid descriptors', () => {
  reset();
  store.set(KEY, JSON.stringify({
    '/valid': { sessionId: 'abc', kind: 'claude' },
    '/bad-kind': { sessionId: 'def' },
    '/bad-id': { kind: 'shell' },
    '/null-val': null,
  }));
  assert.deepEqual(loadSessions(), { '/valid': { sessionId: 'abc', kind: 'claude' } });
});

test('setSession stores a descriptor and loadSessions reads it back', () => {
  reset();
  setSession('/repo/main', 'sess-001', 'claude');
  assert.deepEqual(loadSessions(), { '/repo/main': { sessionId: 'sess-001', kind: 'claude' } });
});

test('setSession overwrites an existing descriptor for the same path', () => {
  reset();
  setSession('/repo/main', 'sess-001', 'claude');
  setSession('/repo/main', 'sess-002', 'shell');
  assert.deepEqual(loadSessions(), { '/repo/main': { sessionId: 'sess-002', kind: 'shell' } });
});

test('setSession keeps descriptors for distinct paths independent', () => {
  reset();
  setSession('/repo/a', 'sess-a', 'claude');
  setSession('/repo/b', 'sess-b', 'shell');
  assert.deepEqual(loadSessions(), {
    '/repo/a': { sessionId: 'sess-a', kind: 'claude' },
    '/repo/b': { sessionId: 'sess-b', kind: 'shell' },
  });
});

test('getSession returns descriptor when found', () => {
  reset();
  setSession('/repo/main', 'sess-xyz', 'shell');
  assert.deepEqual(getSession('/repo/main'), { sessionId: 'sess-xyz', kind: 'shell' });
});

test('getSession returns null when path not in store', () => {
  reset();
  assert.equal(getSession('/no/such/path'), null);
});

test('removeSession clears the entry', () => {
  reset();
  setSession('/repo/main', 'sess-001', 'claude');
  removeSession('/repo/main');
  assert.equal(getSession('/repo/main'), null);
  assert.deepEqual(loadSessions(), {});
});

test('removeSession is a no-op when path is absent', () => {
  reset();
  assert.doesNotThrow(() => removeSession('/not/here'));
  assert.deepEqual(loadSessions(), {});
});

test('removeSession removes only the targeted path', () => {
  reset();
  setSession('/repo/a', 'sess-a', 'claude');
  setSession('/repo/b', 'sess-b', 'shell');
  removeSession('/repo/a');
  assert.deepEqual(loadSessions(), { '/repo/b': { sessionId: 'sess-b', kind: 'shell' } });
});

test('setSession never throws when localStorage.setItem throws', () => {
  reset();
  setItemThrows = true;
  assert.doesNotThrow(() => setSession('/repo/main', 'sess-001', 'claude'));
  setItemThrows = false;
  // Nothing was persisted
  assert.deepEqual(loadSessions(), {});
});

test('removeSession never throws when localStorage.setItem throws', () => {
  reset();
  setSession('/repo/main', 'sess-001', 'claude');
  setItemThrows = true;
  assert.doesNotThrow(() => removeSession('/repo/main'));
  setItemThrows = false;
});
