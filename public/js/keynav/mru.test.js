// Unit tests for mru.js
// Run with: pnpm test (node:test)
// Stubs globalThis.localStorage so the module doesn't touch the real browser store.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Stub localStorage before importing the module under test ─────────────────
// The module reads `localStorage` from globalThis at call time, so patching
// globalThis.localStorage before the first import is sufficient.

let _store = {};
let _throwOnSet = false;

globalThis.localStorage = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(_store, key) ? _store[key] : null; },
  setItem(key, value) {
    if (_throwOnSet) throw new DOMException('QuotaExceededError');
    _store[key] = value;
  },
  removeItem(key) { delete _store[key]; },
  clear() { _store = {}; },
};

// Import AFTER the stub is in place.
const { loadMru, recordMru } = await import('./mru.js');

const KEY = 'localpm.navMru';

function reset() {
  _store = {};
  _throwOnSet = false;
}

describe('mru.loadMru', () => {
  beforeEach(reset);

  it('returns [] when key is absent', () => {
    assert.deepEqual(loadMru(), []);
  });

  it('returns [] for corrupt JSON', () => {
    _store[KEY] = '{{not json}}';
    assert.deepEqual(loadMru(), []);
  });

  it('returns [] when stored value is not an array', () => {
    _store[KEY] = JSON.stringify({ foo: 'bar' });
    assert.deepEqual(loadMru(), []);
  });

  it('returns [] when stored array contains non-string entries (filters them)', () => {
    _store[KEY] = JSON.stringify([1, null, true]);
    assert.deepEqual(loadMru(), []);
  });

  it('returns only string entries from a mixed array', () => {
    _store[KEY] = JSON.stringify(['/a/b', 42, '/c/d', null]);
    assert.deepEqual(loadMru(), ['/a/b', '/c/d']);
  });

  it('returns stored list when valid', () => {
    _store[KEY] = JSON.stringify(['/path/one', '/path/two']);
    assert.deepEqual(loadMru(), ['/path/one', '/path/two']);
  });
});

describe('mru.recordMru', () => {
  beforeEach(reset);

  it('prepends a new path to an empty list', () => {
    recordMru('/path/a');
    assert.deepEqual(loadMru(), ['/path/a']);
  });

  it('moves an existing path to the front (deduplication)', () => {
    _store[KEY] = JSON.stringify(['/path/a', '/path/b', '/path/c']);
    recordMru('/path/c');
    assert.deepEqual(loadMru(), ['/path/c', '/path/a', '/path/b']);
  });

  it('prepends a new path before existing entries', () => {
    _store[KEY] = JSON.stringify(['/path/a', '/path/b']);
    recordMru('/path/new');
    assert.deepEqual(loadMru(), ['/path/new', '/path/a', '/path/b']);
  });

  it('moves path at index 0 to front (no-op positionally, dedupe still works)', () => {
    _store[KEY] = JSON.stringify(['/path/a', '/path/b']);
    recordMru('/path/a');
    assert.deepEqual(loadMru(), ['/path/a', '/path/b']);
  });

  it('write errors are swallowed — does not throw on QuotaExceededError', () => {
    _throwOnSet = true;
    assert.doesNotThrow(() => recordMru('/path/x'));
  });

  it('does nothing for empty string path', () => {
    recordMru('');
    assert.deepEqual(loadMru(), []);
  });

  it('does nothing for non-string path', () => {
    recordMru(null);
    recordMru(undefined);
    recordMru(42);
    assert.deepEqual(loadMru(), []);
  });

  it('caps the list at 50 entries', () => {
    const existing = Array.from({ length: 50 }, (_, i) => `/path/${i}`);
    _store[KEY] = JSON.stringify(existing);
    recordMru('/path/new');
    const result = loadMru();
    assert.equal(result.length, 50);
    assert.equal(result[0], '/path/new');
  });
});
