import { test } from 'node:test';
import assert from 'node:assert/strict';

// term-macros.js touches localStorage at call time (not import time), but stub
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

const { loadMacros, addMacro, removeMacro } = await import('./term-macros.js');

const KEY = 'localpm.termMacros';
function reset() {
  store.clear();
  setItemThrows = false;
}

test('loadMacros returns [] when storage is empty', () => {
  reset();
  assert.deepEqual(loadMacros(), []);
});

test('loadMacros returns [] on corrupt JSON', () => {
  reset();
  store.set(KEY, '{not json');
  assert.deepEqual(loadMacros(), []);
});

test('loadMacros returns [] when JSON is not an array', () => {
  reset();
  store.set(KEY, JSON.stringify({ label: 'x', text: 'y' }));
  assert.deepEqual(loadMacros(), []);
});

test('loadMacros drops malformed entries, keeping valid {label,text}', () => {
  reset();
  store.set(KEY, JSON.stringify([{ label: 'a', text: 'b' }, { label: 1 }, null, { text: 'c' }]));
  assert.deepEqual(loadMacros(), [{ label: 'a', text: 'b' }]);
});

test('addMacro trims the label and appends a valid macro', () => {
  reset();
  const list = addMacro('  build  ', 'pnpm build');
  assert.deepEqual(list, [{ label: 'build', text: 'pnpm build' }]);
  assert.deepEqual(loadMacros(), [{ label: 'build', text: 'pnpm build' }]);
});

test('addMacro stores text verbatim (no trim on stored text)', () => {
  reset();
  addMacro('lbl', '  spaced  ');
  assert.deepEqual(loadMacros(), [{ label: 'lbl', text: '  spaced  ' }]);
});

test('addMacro rejects an empty/whitespace-only label', () => {
  reset();
  assert.deepEqual(addMacro('   ', 'x'), []);
  assert.deepEqual(addMacro('', 'x'), []);
  assert.deepEqual(loadMacros(), []);
});

test('addMacro rejects empty or whitespace-only text', () => {
  reset();
  assert.deepEqual(addMacro('lbl', ''), []);
  assert.deepEqual(addMacro('lbl', '   '), []);
  assert.deepEqual(loadMacros(), []);
});

test('addMacro never throws when localStorage.setItem throws', () => {
  reset();
  setItemThrows = true;
  let list;
  assert.doesNotThrow(() => {
    list = addMacro('lbl', 'text');
  });
  // The returned list still contains the new macro even though it never persisted.
  assert.deepEqual(list, [{ label: 'lbl', text: 'text' }]);
  setItemThrows = false;
  assert.deepEqual(loadMacros(), []);
});

test('removeMacro removes the entry matching label AND text', () => {
  reset();
  addMacro('a', '1');
  addMacro('b', '2');
  addMacro('c', '3');
  const list = removeMacro({ label: 'b', text: '2' });
  assert.deepEqual(list, [{ label: 'a', text: '1' }, { label: 'c', text: '3' }]);
  assert.deepEqual(loadMacros(), [{ label: 'a', text: '1' }, { label: 'c', text: '3' }]);
});

test('removeMacro removes only the first matching duplicate', () => {
  reset();
  store.set(KEY, JSON.stringify([{ label: 'a', text: '1' }, { label: 'a', text: '1' }]));
  const list = removeMacro({ label: 'a', text: '1' });
  assert.deepEqual(list, [{ label: 'a', text: '1' }]);
});

test('removeMacro is a no-op when nothing matches', () => {
  reset();
  addMacro('a', '1');
  const list = removeMacro({ label: 'a', text: 'nope' });
  assert.deepEqual(list, [{ label: 'a', text: '1' }]);
});

test('removeMacro is a no-op on an empty list', () => {
  reset();
  assert.deepEqual(removeMacro({ label: 'x', text: 'y' }), []);
});
