import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../runner.js';

// ---------------------------------------------------------------------------
// Stub helpers (mirrors runner.test.js seams)
// ---------------------------------------------------------------------------

function makeStream() {
  const h = {};
  return {
    setEncoding() {},
    on(ev, fn) { h[ev] = fn; },
    emit(ev, data) { h[ev]?.(data); },
  };
}

function makeChild(pid) {
  const h = {};
  return {
    pid,
    stdout: makeStream(),
    stderr: makeStream(),
    on(ev, fn) { h[ev] = fn; },
    emit(ev, data) { h[ev]?.(data); },
  };
}

function stubAll() {
  runner._setKillFn(async () => {});
  runner._setDockerDownFn(async () => {});
  runner._setDockerRunningFn(async () => true);
  runner._setSpawnFn(() => makeChild(0));
}

beforeEach(async () => {
  stubAll();
  await runner.stopServer();
  // Clear any lingering command from a prior test by stopping it if running.
  runner.stopCommand();
});

describe('runCommand happy path', () => {
  it('logs header + footer and transitions running⇒done with exitCode 0', async () => {
    let child;
    runner._setSpawnFn((_cmd, _opts) => (child = makeChild(1234)));

    await runner.runCommand('C:\\fake\\wt', { cmd: 'npm install', label: 'npm install' });
    assert.equal(runner.getStatus().command.status, 'running');

    child.emit('close', 0);
    const s = runner.getStatus();
    assert.equal(s.command.status, 'done');
    assert.equal(s.command.exitCode, 0);

    const logs = runner.getLogs();
    assert.ok(logs.includes('[cmd] npm install'), 'header logged');
    assert.ok(logs.includes('[cmd] exited 0'), 'footer logged');
  });
});

describe('runCommand non-zero exit', () => {
  it('marks failed with exitCode 1', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(1)));
    await runner.runCommand('C:\\fake\\wt', { cmd: 'npm run build', label: 'build' });
    child.emit('close', 1);
    const s = runner.getStatus();
    assert.equal(s.command.status, 'failed');
    assert.equal(s.command.exitCode, 1);
    assert.ok(runner.getLogs().includes('[cmd] exited 1'));
  });
});

describe('runCommand spawn error', () => {
  it('logs the error and clears inProgress (state failed)', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(2)));
    await runner.runCommand('C:\\fake\\wt', { cmd: 'bogus', label: 'bogus' });
    child.emit('error', new Error('ENOENT'));
    const s = runner.getStatus();
    assert.equal(s.command.status, 'failed');
    assert.ok(runner.getLogs().some((l) => l.includes('[cmd] error: ENOENT')));
    // inProgress cleared ⇒ a subsequent command can spawn
    let spawned = false;
    runner._setSpawnFn(() => { spawned = true; return makeChild(3); });
    await runner.runCommand('C:\\fake\\wt', { cmd: 'next', label: 'next' });
    assert.ok(spawned, 'inProgress was reset after error');
  });
});

describe('runCommand rejects when a command is already running', () => {
  it('does not spawn a second command', async () => {
    let spawnCount = 0;
    const children = [];
    runner._setSpawnFn(() => { spawnCount += 1; const c = makeChild(spawnCount); children.push(c); return c; });

    await runner.runCommand('C:\\fake\\wt', { cmd: 'a', label: 'a' });
    // First close to release inProgress but leave it... actually keep it running:
    // do NOT close — command.status stays 'running' and inProgress stays true.
    await runner.runCommand('C:\\fake\\wt', { cmd: 'b', label: 'b' });
    assert.equal(spawnCount, 1, 'second command must not spawn');
  });
});

describe('inProgress guard blocks a concurrent command', () => {
  it('returns status without spawning when busy', async () => {
    let spawnCount = 0;
    runner._setSpawnFn(() => { spawnCount += 1; return makeChild(spawnCount); });
    const p1 = runner.runCommand('C:\\fake\\wt', { cmd: 'a', label: 'a' });
    const p2 = runner.runCommand('C:\\fake\\wt', { cmd: 'b', label: 'b' });
    await Promise.all([p1, p2]);
    assert.equal(spawnCount, 1, 'only one spawn while inProgress');
  });
});

describe('stopCommand', () => {
  it('kills command.pid and marks state failed', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(5555)));
    let killedPid = null;
    runner._setKillFn(async (pid) => { killedPid = pid; });

    await runner.runCommand('C:\\fake\\wt', { cmd: 'sleep', label: 'sleep' });
    runner.stopCommand();
    assert.equal(killedPid, 5555, 'kill called with command.pid');
    assert.equal(runner.getStatus().command.status, 'failed');
  });

  it('is a no-op when nothing is running', () => {
    let called = false;
    runner._setKillFn(async () => { called = true; });
    runner.stopCommand();
    assert.equal(called, false, 'kill must not be called when idle');
  });
});
