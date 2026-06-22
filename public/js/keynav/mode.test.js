import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE, getMode, setMode, isDoubleEsc, handleEscPress, clearEscPending } from './mode.js';

test('initial mode is NAV', () => {
  // Reset to known state
  setMode(MODE.NAV);
  assert.equal(getMode(), MODE.NAV);
});

test('setMode transitions to WRITING', () => {
  setMode(MODE.WRITING);
  assert.equal(getMode(), MODE.WRITING);
  setMode(MODE.NAV);
});

test('setMode transitions back to NAV', () => {
  setMode(MODE.WRITING);
  setMode(MODE.NAV);
  assert.equal(getMode(), MODE.NAV);
});

test('isDoubleEsc: two Escs within 300ms is a double', () => {
  const t = 1000;
  assert.ok(isDoubleEsc(t, t + 200));
  assert.ok(isDoubleEsc(t, t + 300));
});

test('isDoubleEsc: two Escs beyond 300ms is not a double', () => {
  const t = 1000;
  assert.ok(!isDoubleEsc(t, t + 301));
  assert.ok(!isDoubleEsc(t, t + 1000));
});

test('isDoubleEsc: null prevTs is never a double (single Esc)', () => {
  assert.ok(!isDoubleEsc(null, 1000));
});

test('handleEscPress: first Esc returns false (lone, not swallowed)', () => {
  clearEscPending();
  const result = handleEscPress(1000);
  assert.equal(result, false);
});

test('handleEscPress: second Esc within 300ms returns true (double)', () => {
  clearEscPending();
  handleEscPress(1000);
  const result = handleEscPress(1200);
  assert.equal(result, true);
});

test('handleEscPress: second Esc beyond 300ms returns false (treated as new lone Esc)', () => {
  clearEscPending();
  handleEscPress(1000);
  const result = handleEscPress(1400);
  assert.equal(result, false);
});

test('handleEscPress: after double confirmed, next Esc starts fresh', () => {
  clearEscPending();
  handleEscPress(1000);
  handleEscPress(1100); // double confirmed, _lastEscTs = null
  const result = handleEscPress(1200); // new lone Esc
  assert.equal(result, false);
});
