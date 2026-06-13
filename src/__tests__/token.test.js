import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToken, readToken, isAuthorized } from '../token.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tokenFile = path.join(repoRoot, 'token.local');

/**
 * Return a unique temp path that doesn't pollute the repo's real token.local.
 */
function tempTokenPath() {
  return path.join(os.tmpdir(), `lpm-token-${Date.now()}-${Math.random().toString(16).slice(2)}.local`);
}

/**
 * Snapshot the real token.local (if present), run `fn`, then restore it.
 * isAuthorized reads the fixed repo-root token, so tests must restore it.
 */
function withTokenFile(fn) {
  const existed = fs.existsSync(tokenFile);
  const backup = existed ? fs.readFileSync(tokenFile, 'utf8') : null;
  try {
    fn();
  } finally {
    if (backup === null) {
      if (fs.existsSync(tokenFile)) fs.rmSync(tokenFile);
    } else {
      fs.writeFileSync(tokenFile, backup, 'utf8');
    }
  }
}

function reqWith(authorization) {
  return { headers: authorization === undefined ? {} : { authorization } };
}

test('ensureToken: creates the file when absent and flags isNew', () => {
  const file = tempTokenPath();
  try {
    const { token, isNew } = ensureToken(file);
    assert.equal(isNew, true);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(file));
  } finally {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
});

test('ensureToken: reads an existing file and flags isNew false, trimming', () => {
  const file = tempTokenPath();
  try {
    fs.writeFileSync(file, '  abc123  \n', 'utf8');
    const { token, isNew } = ensureToken(file);
    assert.equal(isNew, false);
    assert.equal(token, 'abc123');
  } finally {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
});

test('readToken: throws a descriptive error when absent', () => {
  const file = tempTokenPath();
  assert.throws(() => readToken(file), /token\.local not found/);
});

test('readToken: returns the trimmed token when present', () => {
  const file = tempTokenPath();
  try {
    fs.writeFileSync(file, '  deadbeef  \n', 'utf8');
    assert.equal(readToken(file), 'deadbeef');
  } finally {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
});

test('isAuthorized: valid bearer token returns true', () => {
  withTokenFile(() => {
    fs.writeFileSync(tokenFile, 'sekret\n', 'utf8');
    assert.equal(isAuthorized(reqWith('Bearer sekret')), true);
  });
});

test('isAuthorized: missing Authorization header returns false', () => {
  withTokenFile(() => {
    fs.writeFileSync(tokenFile, 'sekret\n', 'utf8');
    assert.equal(isAuthorized(reqWith(undefined)), false);
  });
});

test('isAuthorized: wrong token returns false', () => {
  withTokenFile(() => {
    fs.writeFileSync(tokenFile, 'sekret\n', 'utf8');
    assert.equal(isAuthorized(reqWith('Bearer nopenope')), false);
  });
});

test('isAuthorized: missing Bearer prefix returns false', () => {
  withTokenFile(() => {
    fs.writeFileSync(tokenFile, 'sekret\n', 'utf8');
    assert.equal(isAuthorized(reqWith('sekret')), false);
  });
});

test('isAuthorized: length mismatch returns false without timingSafeEqual throwing', () => {
  withTokenFile(() => {
    fs.writeFileSync(tokenFile, 'sekret\n', 'utf8');
    assert.equal(isAuthorized(reqWith('Bearer s')), false);
  });
});
