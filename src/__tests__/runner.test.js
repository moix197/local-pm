import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../runner.js';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/**
 * A fake child-process stream: records setEncoding calls, routes on/emit.
 */
function makeStream() {
  const h = {};
  return {
    setEncoding() {},
    on(ev, fn) { h[ev] = fn; },
    emit(ev, data) { h[ev]?.(data); },
  };
}

/**
 * Build a fake child process.
 * @param {number} pid
 * @param {boolean} autoClose - if true, fires 'close' on the child after a
 *   microtask so the caller (runNpmInstall) resolves without manual wiring.
 */
function makeChild(pid, autoClose = false) {
  const h = {};
  const child = {
    pid,
    stdout: makeStream(),
    stderr: makeStream(),
    on(ev, fn) {
      h[ev] = fn;
      // If autoClose is enabled and a 'close' handler is registered, schedule it.
      if (autoClose && ev === 'close') {
        Promise.resolve().then(() => fn());
      }
    },
    emit(ev, data) { h[ev]?.(data); },
  };
  return child;
}

/**
 * Builds a spawn stub that auto-closes for the install child (first spawn)
 * and returns a long-lived dev-server child (second spawn) stored in the
 * returned refs object.
 *
 * refs.dev is populated after the second spawn.
 */
function makeSpawnStub(refs = {}) {
  let callCount = 0;
  return function stub(_cmd, _args, _opts) {
    callCount += 1;
    if (callCount === 1) {
      // npm install — auto-close so runNpmInstall resolves on its own.
      refs.install = makeChild(callCount * 1000, /* autoClose */ true);
      return refs.install;
    }
    // npm run dev — long-lived, never auto-closes.
    refs.dev = makeChild(callCount * 1000, /* autoClose */ false);
    refs.callCount = callCount;
    return refs.dev;
  };
}

/** Install no-op stubs for all injectable seams. */
function stubAll() {
  runner._setKillFn(async () => {});
  runner._setDockerDownFn(async () => {});
  runner._setSpawnFn(() => makeChild(0, true));
}

// ---------------------------------------------------------------------------
// Reset between tests.
// ---------------------------------------------------------------------------

beforeEach(async () => {
  stubAll();
  await runner.stopServer();
});

// ---------------------------------------------------------------------------
// getStatus shape
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('returns idle shape when nothing is running', () => {
    const s = runner.getStatus();
    assert.equal(s.active, null);
    assert.equal(s.installing, false);
  });

  it('returns running shape after startServer resolves', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const fakePath = 'C:\\fake\\worktreeA';
    await runner.startServer(fakePath, { project: 'proj', branch: 'feat' });

    const s = runner.getStatus();
    assert.equal(s.installing, false);
    assert.notEqual(s.active, null);
    assert.equal(s.active.branch, 'feat');
    assert.equal(s.active.project, 'proj');
    assert.equal(s.active.path, fakePath);
    // pid is from the second spawn (dev server), which gets pid = 2000
    assert.equal(s.active.pid, 2000);
    assert.ok(typeof s.active.startedAt === 'number');
  });

  it('exposes installing=true while install is in progress, false after', async () => {
    // Use a manually-controlled install child (no autoClose) to freeze mid-install.
    let installChild;
    let spawnCall = 0;
    runner._setSpawnFn((_cmd, _args, _opts) => {
      spawnCall += 1;
      if (spawnCall === 1) {
        installChild = makeChild(spawnCall * 100, /* autoClose */ false);
        return installChild;
      }
      return makeChild(spawnCall * 100, /* autoClose */ false);
    });

    const fakePath = 'C:\\fake\\worktreeB';
    const startP = runner.startServer(fakePath, {});

    // Yield enough microtasks for spawn to be called but install not yet closed.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(runner.getStatus().installing, true);

    // Fire close to unblock install.
    installChild?.emit('close');
    await startP;
    assert.equal(runner.getStatus().installing, false);
  });
});

// ---------------------------------------------------------------------------
// getLogs ring-buffer cap
// ---------------------------------------------------------------------------

describe('getLogs', () => {
  it('caps internal buffer at 300 lines after > 300 are pushed', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    await runner.startServer('C:\\fake\\worktreeC', {});

    // Emit 310 lines from dev server stdout.
    const chunk = Array.from({ length: 310 }, (_, i) => `line-${i}`).join('\n');
    refs.dev?.stdout.emit('data', chunk);

    const captured = runner.getLogs();
    assert.ok(captured.length <= 300, `expected <=300, got ${captured.length}`);
  });

  it('returns a copy — caller mutation does not affect internal buffer', () => {
    const copy1 = runner.getLogs();
    copy1.push('poisoned');
    const copy2 = runner.getLogs();
    assert.ok(!copy2.includes('poisoned'), 'internal log buffer must be mutation-safe');
  });
});

// ---------------------------------------------------------------------------
// startServer auto-stop sequencing
// ---------------------------------------------------------------------------

describe('startServer auto-stop sequencing', () => {
  it('stops the current active server before spawning a new one', async () => {
    // Start server A.
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\A', { project: 'p', branch: 'a' });
    assert.notEqual(runner.getStatus().active, null, 'A should be active');
    assert.equal(runner.getStatus().active.branch, 'a');

    // Start server B while A is active.
    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\B', { project: 'p', branch: 'b' });

    const s = runner.getStatus();
    assert.notEqual(s.active, null, 'B should be active');
    assert.equal(s.active.branch, 'b', 'active branch should be b');
    // B's dev spawn gets pid 2000 from makeSpawnStub
    assert.equal(s.active.pid, 2000, 'pid should be from B dev spawn');
  });

  it('ignores a second concurrent startServer call while first is in progress', async () => {
    // Use a manually-controlled install to keep first call in-flight.
    let installChild;
    let spawnCall = 0;
    runner._setSpawnFn((_cmd, _args, _opts) => {
      spawnCall += 1;
      if (spawnCall === 1) {
        installChild = makeChild(10, /* autoClose */ false);
        return installChild;
      }
      return makeChild(spawnCall * 10, /* autoClose */ false);
    });

    const fakePath = 'C:\\fake\\Dup';
    // Fire two concurrent starts — second hits the inProgress guard.
    const p1 = runner.startServer(fakePath, { project: 'p', branch: 'x' });
    const p2 = runner.startServer(fakePath, { project: 'p', branch: 'x' });

    // p2 resolves immediately with idle status (inProgress guard early-return).
    const r2 = await p2;
    assert.equal(r2.active, null, 'second call returns idle while first is in flight');

    // Finish p1.
    installChild?.emit('close');
    await p1;

    assert.notEqual(runner.getStatus().active, null, 'first start should succeed');
    // Only 2 spawns: install + dev (p2 was rejected before any spawn)
    assert.equal(spawnCall, 2, `expected 2 spawn calls, got ${spawnCall}`);
  });
});
