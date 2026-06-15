import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
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
    runner._setSpawnFn(() => makeChild(5555));
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

describe('stopCommand stays authoritative on a late close event', () => {
  it('keeps status failed and does not flip to done/exit 0', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(7777)));
    runner._setKillFn(async () => {});

    await runner.runCommand('C:\\fake\\wt', { cmd: 'sleep', label: 'sleep' });
    runner.stopCommand();

    // taskkill ends the process ⇒ the child's close handler fires late, and on
    // Windows a killed process can report exit code 0.
    child.emit('close', 0);

    const s = runner.getStatus();
    assert.equal(s.command.status, 'failed', 'stopped command must stay failed');
    assert.notEqual(s.command.exitCode, 0, 'must not record exit 0');

    // inProgress cleared exactly once ⇒ a subsequent command can spawn.
    let spawned = false;
    runner._setSpawnFn(() => { spawned = true; return makeChild(8888); });
    await runner.runCommand('C:\\fake\\wt', { cmd: 'next', label: 'next' });
    assert.ok(spawned, 'inProgress not stuck after stop + late close');
  });
});

describe('startServer clears a stale terminal command', () => {
  it('nulls a finished command so it cannot mask the server banner', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(4321)));
    await runner.runCommand('C:\\fake\\wt', { cmd: 'build', label: 'build' });
    child.emit('close', 0);
    assert.equal(runner.getStatus().command.status, 'done', 'precondition: done');

    // Temp dir with node_modules so startServer skips install and spawns dev.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-pm-cmd-'));
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    try {
      runner._setSpawnFn(() => makeChild(5432));
      await runner.startServer(tmpDir, { project: 'p', branch: 'b' });
      assert.equal(runner.getStatus().command, null, 'stale command cleared');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
