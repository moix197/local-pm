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

const WT = 'C:\\fake\\wt';
const WT_A = 'C:\\fake\\a';
const WT_B = 'C:\\fake\\b';

function stubAll() {
  runner._setKillFn(async () => {});
  runner._setDockerDownFn(async () => {});
  runner._setDockerRunningFn(async () => true);
  runner._setSpawnFn(() => makeChild(0));
}

beforeEach(async () => {
  stubAll();
  await runner.stopAll();
  // Clear any lingering command from a prior test by stopping it per path.
  for (const p of [WT, WT_A, WT_B]) runner.stopCommand(p);
});

describe('runCommand happy path', () => {
  it('logs header + footer and transitions running⇒done with exitCode 0', async () => {
    let child;
    runner._setSpawnFn((_cmd, _opts) => (child = makeChild(1234)));

    await runner.runCommand(WT, { cmd: 'npm install', label: 'npm install' });
    assert.equal(runner.getStatus(WT).command.status, 'running');

    child.emit('close', 0);
    const s = runner.getStatus(WT);
    assert.equal(s.command.status, 'done');
    assert.equal(s.command.exitCode, 0);

    const logs = runner.getLogs(WT);
    assert.ok(logs.includes('[cmd] npm install'), 'header logged');
    assert.ok(logs.includes('[cmd] exited 0'), 'footer logged');
  });
});

describe('runCommand non-zero exit', () => {
  it('marks failed with exitCode 1', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(1)));
    await runner.runCommand(WT, { cmd: 'npm run build', label: 'build' });
    child.emit('close', 1);
    const s = runner.getStatus(WT);
    assert.equal(s.command.status, 'failed');
    assert.equal(s.command.exitCode, 1);
    assert.ok(runner.getLogs(WT).includes('[cmd] exited 1'));
  });
});

describe('runCommand spawn error', () => {
  it('logs the error and clears inProgress (state failed)', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(2)));
    await runner.runCommand(WT, { cmd: 'bogus', label: 'bogus' });
    child.emit('error', new Error('ENOENT'));
    const s = runner.getStatus(WT);
    assert.equal(s.command.status, 'failed');
    assert.ok(runner.getLogs(WT).some((l) => l.includes('[cmd] error: ENOENT')));
    // inProgress cleared ⇒ a subsequent command can spawn
    let spawned = false;
    runner._setSpawnFn(() => { spawned = true; return makeChild(3); });
    await runner.runCommand(WT, { cmd: 'next', label: 'next' });
    assert.ok(spawned, 'inProgress was reset after error');
  });
});

describe('runCommand rejects when that path already has a running command', () => {
  it('does not spawn a second command for the same path', async () => {
    let spawnCount = 0;
    runner._setSpawnFn(() => { spawnCount += 1; return makeChild(spawnCount); });

    await runner.runCommand(WT, { cmd: 'a', label: 'a' });
    // Do NOT close — command.status stays 'running' for WT.
    await runner.runCommand(WT, { cmd: 'b', label: 'b' });
    assert.equal(spawnCount, 1, 'second command for same path must not spawn');
  });
});

describe('two paths run commands simultaneously', () => {
  it('both paths spawn and each tracks its own command independently', async () => {
    const children = new Map();
    runner._setSpawnFn((_cmd, opts) => {
      const c = makeChild(children.size + 100);
      // opts.cwd identifies the target path (spawnCommand passes {cwd, shell}).
      children.set(opts.cwd, c);
      return c;
    });

    await runner.runCommand(WT_A, { cmd: 'a', label: 'cmd-a' });
    await runner.runCommand(WT_B, { cmd: 'b', label: 'cmd-b' });

    assert.equal(runner.getStatus(WT_A).command.status, 'running', 'A running');
    assert.equal(runner.getStatus(WT_B).command.status, 'running', 'B running');
    assert.equal(runner.getStatus(WT_A).command.label, 'cmd-a');
    assert.equal(runner.getStatus(WT_B).command.label, 'cmd-b');

    // Finishing A leaves B untouched.
    children.get(WT_A).emit('close', 0);
    assert.equal(runner.getStatus(WT_A).command.status, 'done');
    assert.equal(runner.getStatus(WT_B).command.status, 'running', 'B unaffected by A close');
  });
});

describe('inProgress guard is per-path', () => {
  it('blocks a concurrent command for the same path but not for another', async () => {
    let spawnCount = 0;
    runner._setSpawnFn(() => { spawnCount += 1; return makeChild(spawnCount); });
    const p1 = runner.runCommand(WT_A, { cmd: 'a', label: 'a' });
    const p2 = runner.runCommand(WT_A, { cmd: 'a2', label: 'a2' });
    const p3 = runner.runCommand(WT_B, { cmd: 'b', label: 'b' });
    await Promise.all([p1, p2, p3]);
    assert.equal(spawnCount, 2, 'one spawn for A (guarded) + one for B');
  });
});

describe('stopCommand(path)', () => {
  it('kills command.pid and marks state failed for that path', async () => {
    runner._setSpawnFn(() => makeChild(5555));
    let killedPid = null;
    runner._setKillFn(async (pid) => { killedPid = pid; });

    await runner.runCommand(WT, { cmd: 'sleep', label: 'sleep' });
    runner.stopCommand(WT);
    assert.equal(killedPid, 5555, 'kill called with command.pid');
    assert.equal(runner.getStatus(WT).command.status, 'failed');
  });

  it('only stops the given path, leaving another path running', async () => {
    const children = new Map();
    runner._setSpawnFn((_cmd, opts) => {
      const c = makeChild(children.size + 200);
      children.set(opts.cwd, c);
      return c;
    });
    const killed = [];
    runner._setKillFn(async (pid) => { killed.push(pid); });

    await runner.runCommand(WT_A, { cmd: 'a', label: 'a' });
    await runner.runCommand(WT_B, { cmd: 'b', label: 'b' });

    runner.stopCommand(WT_A);
    assert.equal(runner.getStatus(WT_A).command.status, 'failed', 'A stopped');
    assert.equal(runner.getStatus(WT_B).command.status, 'running', 'B still running');
    assert.deepEqual(killed, [200], 'only A pid killed');
  });

  it('is a no-op when nothing is running for that path', () => {
    let called = false;
    runner._setKillFn(async () => { called = true; });
    runner.stopCommand(WT);
    assert.equal(called, false, 'kill must not be called when idle');
  });
});

describe('stopCommand stays authoritative on a late close event', () => {
  it('keeps status failed and does not flip to done/exit 0', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(7777)));
    runner._setKillFn(async () => {});

    await runner.runCommand(WT, { cmd: 'sleep', label: 'sleep' });
    runner.stopCommand(WT);

    // taskkill ends the process ⇒ the child's close handler fires late, and on
    // Windows a killed process can report exit code 0.
    child.emit('close', 0);

    const s = runner.getStatus(WT);
    assert.equal(s.command.status, 'failed', 'stopped command must stay failed');
    assert.notEqual(s.command.exitCode, 0, 'must not record exit 0');

    // inProgress cleared exactly once ⇒ a subsequent command can spawn.
    let spawned = false;
    runner._setSpawnFn(() => { spawned = true; return makeChild(8888); });
    await runner.runCommand(WT, { cmd: 'next', label: 'next' });
    assert.ok(spawned, 'inProgress not stuck after stop + late close');
  });
});

describe('runCommand routes output to the target path log buffer', () => {
  it('writes the command header into that path\'s own logs', async () => {
    let child;
    runner._setSpawnFn(() => (child = makeChild(4321)));
    const p = 'C:\\fake\\cmdLogs';
    await runner.runCommand(p, { cmd: 'build', label: 'build' });
    child.emit('close', 0);
    assert.ok(runner.getLogs(p).includes('[cmd] build'), 'command header in path logs');
    runner.stopCommand(p);
  });
});
