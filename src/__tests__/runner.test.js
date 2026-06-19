import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as runner from '../runner.js';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeStream() {
  const h = {};
  return {
    setEncoding() {},
    on(ev, fn) { h[ev] = fn; },
    emit(ev, data) { h[ev]?.(data); },
  };
}

function makeChild(pid, autoClose = false) {
  const h = {};
  const child = {
    pid,
    stdout: makeStream(),
    stderr: makeStream(),
    on(ev, fn) {
      h[ev] = fn;
      if (autoClose && ev === 'close') Promise.resolve().then(() => fn());
    },
    emit(ev, data) { h[ev]?.(data); },
  };
  return child;
}

/**
 * Spawn stub: first call auto-closes (npm install), second returns a long-lived
 * dev child stored on refs.dev. Also records spawn options on refs.opts (per call).
 */
function makeSpawnStub(refs = {}) {
  let callCount = 0;
  refs.opts = [];
  return function stub(_cmd, _args, opts) {
    callCount += 1;
    refs.opts.push(opts);
    if (callCount === 1) {
      refs.install = makeChild(callCount * 1000, /* autoClose */ true);
      return refs.install;
    }
    refs.dev = makeChild(callCount * 1000, /* autoClose */ false);
    refs.callCount = callCount;
    return refs.dev;
  };
}

function stubAll() {
  runner._setKillFn(async () => {});
  runner._setDockerDownFn(async () => {});
  runner._setDockerRunningFn(async () => true);
  runner._setSpawnFn(() => makeChild(0, true));
}

beforeEach(async () => {
  stubAll();
  await runner.stopAll();
});

// ---------------------------------------------------------------------------
// getStatus shape
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('returns idle shape for an unknown path', () => {
    const s = runner.getStatus('C:\\fake\\none');
    assert.equal(s.active, null);
    assert.equal(s.installing, false);
  });

  it('returns running shape after startServer resolves', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const fakePath = 'C:\\fake\\worktreeA';
    await runner.startServer(fakePath, { project: 'proj', branch: 'feat' }, { PORT: '3100' });

    const s = runner.getStatus(fakePath);
    assert.equal(s.installing, false);
    assert.notEqual(s.active, null);
    assert.equal(s.active.branch, 'feat');
    assert.equal(s.active.project, 'proj');
    assert.equal(s.active.path, fakePath);
    assert.equal(s.active.port, '3100');
    assert.equal(s.active.pid, 2000);
    assert.ok(typeof s.active.startedAt === 'number');
  });

  it('exposes installing=true while install is in progress, false after', async () => {
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
    const startP = runner.startServer(fakePath, {}, {});

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(runner.getStatus(fakePath).installing, true);

    installChild?.emit('close');
    await startP;
    assert.equal(runner.getStatus(fakePath).installing, false);
  });
});

// ---------------------------------------------------------------------------
// env merge with process.env
// ---------------------------------------------------------------------------

describe('spawn env merge', () => {
  it('merges caller env over process.env in the dev spawn options', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    await runner.startServer('C:\\fake\\envWt', { project: 'p', branch: 'env' }, { PORT: '3150' });

    // Second spawn is the dev server.
    const devOpts = refs.opts[1];
    assert.equal(devOpts.shell, true);
    assert.equal(devOpts.cwd, 'C:\\fake\\envWt');
    assert.equal(devOpts.env.PORT, '3150', 'caller PORT injected');
    // A representative process.env key must survive the merge (PATH on win, Path fallback).
    const procKey = process.env.PATH !== undefined ? 'PATH' : Object.keys(process.env)[0];
    assert.equal(devOpts.env[procKey], process.env[procKey], 'process.env preserved in merge');
  });
});

// ---------------------------------------------------------------------------
// getLogs ring-buffer cap and per-path isolation
// ---------------------------------------------------------------------------

describe('getLogs', () => {
  it('caps a path buffer at 300 lines after > 300 are pushed', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const p = 'C:\\fake\\worktreeC';
    await runner.startServer(p, {}, {});

    const chunk = Array.from({ length: 310 }, (_, i) => `line-${i}`).join('\n');
    refs.dev?.stdout.emit('data', chunk);

    const captured = runner.getLogs(p);
    assert.ok(captured.length <= 300, `expected <=300, got ${captured.length}`);
  });

  it('returns a copy — caller mutation does not affect internal buffer', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));
    const p = 'C:\\fake\\copyWt';
    await runner.startServer(p, {}, {});
    const copy1 = runner.getLogs(p);
    copy1.push('poisoned');
    const copy2 = runner.getLogs(p);
    assert.ok(!copy2.includes('poisoned'), 'internal log buffer must be mutation-safe');
  });

  it('keeps each server log buffer isolated', async () => {
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\logA', {}, {});
    refsA.dev?.stdout.emit('data', 'only-in-A\n');

    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\logB', {}, {});
    refsB.dev?.stdout.emit('data', 'only-in-B\n');

    const logsA = runner.getLogs('C:\\fake\\logA');
    const logsB = runner.getLogs('C:\\fake\\logB');
    assert.ok(logsA.includes('only-in-A'));
    assert.ok(!logsA.includes('only-in-B'), 'A logs must not contain B output');
    assert.ok(logsB.includes('only-in-B'));
    assert.ok(!logsB.includes('only-in-A'), 'B logs must not contain A output');
  });
});

// ---------------------------------------------------------------------------
// Multiple concurrent servers
// ---------------------------------------------------------------------------

describe('concurrent servers', () => {
  it('keeps two servers active at the same time', async () => {
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\A', { project: 'p', branch: 'a' }, { PORT: '3100' });

    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\B', { project: 'p', branch: 'b' }, { PORT: '3101' });

    const all = runner.getAllStatuses();
    assert.equal(all.length, 2, 'both servers should be active');
    const byPath = new Map(all.map((s) => [s.path, s]));
    assert.equal(byPath.get('C:\\fake\\A').branch, 'a');
    assert.equal(byPath.get('C:\\fake\\B').branch, 'b');
    assert.equal(byPath.get('C:\\fake\\A').port, '3100');
    assert.equal(byPath.get('C:\\fake\\B').port, '3101');
  });

  it('stopping one server leaves the other running', async () => {
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\KeepA', { project: 'p', branch: 'a' }, { PORT: '3100' });

    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\KeepB', { project: 'p', branch: 'b' }, { PORT: '3101' });

    await runner.stopServer('C:\\fake\\KeepA');

    assert.equal(runner.getStatus('C:\\fake\\KeepA').active, null, 'A stopped');
    assert.notEqual(runner.getStatus('C:\\fake\\KeepB').active, null, 'B still running');
    assert.equal(runner.getAllStatuses().length, 1);
  });

  it('ignores a second concurrent startServer on the same path', async () => {
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
    const p1 = runner.startServer(fakePath, { project: 'p', branch: 'x' }, {});
    const p2 = runner.startServer(fakePath, { project: 'p', branch: 'x' }, {});

    const r2 = await p2;
    assert.equal(r2.active, null, 'second call returns idle while first is in flight');

    installChild?.emit('close');
    await p1;

    assert.notEqual(runner.getStatus(fakePath).active, null, 'first start should succeed');
    assert.equal(spawnCall, 2, `expected 2 spawn calls, got ${spawnCall}`);
  });
});

// ---------------------------------------------------------------------------
// stopServer / stopAll
// ---------------------------------------------------------------------------

describe('stopServer', () => {
  it('is idempotent for an unknown path — does not throw', async () => {
    await assert.doesNotReject(() => runner.stopServer('C:\\fake\\never'));
  });

  it('swallows a rejected dockerComposeDown and still clears the entry', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));
    const p = 'C:\\fake\\DockerErr';
    await runner.startServer(p, { project: 'p', branch: 'main' }, {});
    assert.notEqual(runner.getStatus(p).active, null);

    runner._setDockerDownFn(async () => { throw new Error('docker not available'); });
    runner._setKillFn(async () => {});

    await assert.doesNotReject(() => runner.stopServer(p));
    assert.equal(runner.getStatus(p).active, null, 'active must be null after stop');
  });
});

describe('stopAll', () => {
  it('stops every running server', async () => {
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\AllA', { project: 'p', branch: 'a' }, { PORT: '3100' });
    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\AllB', { project: 'p', branch: 'b' }, { PORT: '3101' });

    assert.equal(runner.getAllStatuses().length, 2);
    await runner.stopAll();
    assert.equal(runner.getAllStatuses().length, 0, 'all servers stopped');
  });
});

// ---------------------------------------------------------------------------
// spawn 'error' event handling
// ---------------------------------------------------------------------------

describe('spawn error handling', () => {
  it('startServer does not reject when dev server emits error', async () => {
    let spawnCall = 0;
    let devChild;
    runner._setSpawnFn((_cmd, _args, _opts) => {
      spawnCall += 1;
      if (spawnCall === 1) return makeChild(100, /* autoClose */ true);
      devChild = makeChild(200, /* autoClose */ false);
      return devChild;
    });

    const startP = runner.startServer('C:\\fake\\ErrPath', { project: 'p', branch: 'err-branch' }, {});
    await assert.doesNotReject(() => startP);

    devChild?.emit('error', new Error('ENOENT spawn failed'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('records the error in getLogs() when dev server emits error', async () => {
    let spawnCall = 0;
    let devChild;
    runner._setSpawnFn((_cmd, _args, _opts) => {
      spawnCall += 1;
      if (spawnCall === 1) return makeChild(100, /* autoClose */ true);
      devChild = makeChild(200, /* autoClose */ false);
      return devChild;
    });

    const p = 'C:\\fake\\ErrLogs';
    await runner.startServer(p, { project: 'p', branch: 'log-branch' }, {});
    devChild?.emit('error', new Error('ENOENT spawn failed'));
    await Promise.resolve();
    await Promise.resolve();

    const captured = runner.getLogs(p);
    const errorLine = captured.find((l) => l.includes('failed to start'));
    assert.ok(errorLine, `expected an error log line, got: ${JSON.stringify(captured)}`);
  });

  it('resets the entry to null after dev server emits error', async () => {
    let spawnCall = 0;
    let devChild;
    runner._setSpawnFn((_cmd, _args, _opts) => {
      spawnCall += 1;
      if (spawnCall === 1) return makeChild(100, /* autoClose */ true);
      devChild = makeChild(200, /* autoClose */ false);
      return devChild;
    });

    const p = 'C:\\fake\\ErrIdle';
    await runner.startServer(p, { project: 'p', branch: 'idle-branch' }, {});
    assert.notEqual(runner.getStatus(p).active, null, 'should be active before error');

    devChild?.emit('error', new Error('ENOENT spawn failed'));
    await Promise.resolve();
    await Promise.resolve();

    const s = runner.getStatus(p);
    assert.equal(s.active, null, 'active must be null after spawn error');
    assert.equal(s.installing, false, 'installing must be false after spawn error');
  });

  it('does not hang and logs the error when the install spawn emits error', async () => {
    let installChild;
    let devChild;
    let spawnCall = 0;
    runner._setSpawnFn((_cmd, _args, _opts) => {
      spawnCall += 1;
      if (spawnCall === 1) {
        installChild = makeChild(100, /* autoClose */ false);
        Promise.resolve().then(() =>
          installChild.emit('error', new Error('ENOENT npm install failed')),
        );
        return installChild;
      }
      devChild = makeChild(200, /* autoClose */ false);
      return devChild;
    });

    const p = 'C:\\fake\\InstallErr';
    await assert.doesNotReject(() =>
      runner.startServer(p, { project: 'p', branch: 'inst-branch' }, {}),
    );

    const captured = runner.getLogs(p);
    const errorLine = captured.find((l) => l.includes('npm install error'));
    assert.ok(errorLine, `expected install error log, got: ${JSON.stringify(captured)}`);
    assert.equal(runner.getStatus(p).installing, false, 'installing must be false after install error');

    devChild?.emit('error', new Error('ENOENT spawn failed'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(runner.getStatus(p).active, null, 'active must be null after errors');
  });
});

// ---------------------------------------------------------------------------
// docker preflight
// ---------------------------------------------------------------------------

describe('docker preflight', () => {
  it('logs the Docker-not-running message and does not spawn when compose file exists and Docker is down', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-pm-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), 'version: "3"\n');

      let spawnCallCount = 0;
      runner._setSpawnFn((_cmd, _args, _opts) => {
        spawnCallCount += 1;
        return makeChild(spawnCallCount * 100, true);
      });
      runner._setDockerRunningFn(async () => false);

      const status = await runner.startServer(tmpDir, { project: 'p', branch: 'docker-down' }, {});

      assert.equal(spawnCallCount, 0, 'spawn must not be called when Docker is not running');
      assert.equal(status.active, null, 'active must remain null');

      const captured = runner.getLogs(tmpDir);
      const msg = '[local-pm] Docker is not running — start Docker Desktop first, then try again.';
      assert.ok(
        captured.includes(msg),
        `expected Docker-not-running message in logs, got: ${JSON.stringify(captured)}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('proceeds to spawn when compose file exists and Docker IS running', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-pm-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), 'version: "3"\n');

      const refs = {};
      runner._setSpawnFn(makeSpawnStub(refs));
      runner._setDockerRunningFn(async () => true);

      await runner.startServer(tmpDir, { project: 'p', branch: 'docker-up' }, {});

      assert.notEqual(runner.getStatus(tmpDir).active, null, 'active must be set when Docker is running');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips the Docker check entirely when no compose file is present', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-pm-test-'));
    try {
      const refs = {};
      runner._setSpawnFn(makeSpawnStub(refs));
      runner._setDockerRunningFn(async () => false);

      await runner.startServer(tmpDir, { project: 'p', branch: 'no-compose' }, {});

      assert.notEqual(runner.getStatus(tmpDir).active, null, 'active must be set even though Docker returns false — no compose file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
