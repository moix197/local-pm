import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDesktop } from './desktop-gate.js';

// Stub matchMedia: returns an object with .matches based on min-width query
function makeStub(viewportWidth) {
  return (query) => {
    // Parse "min-width: Npx" from the query string
    const m = query.match(/min-width:\s*(\d+)px/);
    if (!m) return { matches: false };
    return { matches: viewportWidth >= parseInt(m[1], 10) };
  };
}

test('isDesktop returns true for wide viewport (1024px)', () => {
  assert.ok(isDesktop(makeStub(1024)));
});

test('isDesktop returns true for exactly 769px', () => {
  assert.ok(isDesktop(makeStub(769)));
});

test('isDesktop returns false for 768px (mobile boundary)', () => {
  assert.ok(!isDesktop(makeStub(768)));
});

test('isDesktop returns false for 375px (phone)', () => {
  assert.ok(!isDesktop(makeStub(375)));
});
