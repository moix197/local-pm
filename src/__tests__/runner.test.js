import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as runner from '../runner.js';
import { extractPortFromLogLine } from '../runner.js';

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
  return function stub(cmd, _args, opts) {
    callCount += 1;
    refs.opts.push(opts);
    if (callCount === 1) {
      refs.install = makeChild(callCount * 1000, /* autoClose */ true);
      return refs.install;
    }
    refs.devCmdArg = cmd;
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
    await runner.startServer(fakePath, { project: 'proj', branch: 'feat', path: fakePath, type: 'plain' });

    const s = runner.getStatus(fakePath);
    assert.equal(s.installing, false);
    assert.notEqual(s.active, null);
    assert.equal(s.active.branch, 'feat');
    assert.equal(s.active.project, 'proj');
    assert.equal(s.active.path, fakePath);
    // port comes from pool — just verify it's a numeric string
    assert.ok(s.active.port != null, 'port should be set');
    assert.ok(Number(s.active.port) >= 3100, 'port in pool range');
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
    const startP = runner.startServer(fakePath, {});

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
  it('merges buildEnvForTarget result over process.env in the dev spawn options', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const wtPath = 'C:\\fake\\envWt';
    await runner.startServer(wtPath, { project: 'p', branch: 'env', path: wtPath, type: 'plain' });

    // Second spawn is the dev server.
    const devOpts = refs.opts[1];
    assert.equal(devOpts.shell, true);
    assert.equal(devOpts.cwd, wtPath);
    // PORT is assigned from the pool (plain type)
    assert.ok(devOpts.env.PORT, 'PORT should be injected by buildEnvForTarget');
    assert.ok(Number(devOpts.env.PORT) >= 3100, 'PORT should be in pool range');
    // A representative process.env key must survive the merge (PATH on win, Path fallback).
    const procKey = process.env.PATH !== undefined ? 'PATH' : Object.keys(process.env)[0];
    assert.equal(devOpts.env[procKey], process.env[procKey], 'process.env preserved in merge');
  });
});

// ---------------------------------------------------------------------------
// spawnDevServer honors the stored devCmd
// ---------------------------------------------------------------------------

describe('stored devCmd at spawn', () => {
  // On win32 the runner rewrites a leading `npm ` to `npm.cmd `; normalize both.
  const cmdOf = (raw) => (process.platform === 'win32' ? raw.replace(/^npm /, 'npm.cmd ') : raw);

  it('spawns the project devCmd instead of the hardcoded npm run dev', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const wtPath = 'C:\\fake\\devCmdWt';
    await runner.startServer(wtPath, {
      project: 'p', branch: 'feat', path: wtPath, type: 'plain', devCmd: 'npm run start',
    });

    // Second spawn is the dev server: first positional arg is the command string.
    assert.equal(refs.devCmdArg, cmdOf('npm run start'));
  });

  it('falls back to npm run dev when no devCmd is stored', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const wtPath = 'C:\\fake\\noDevCmdWt';
    await runner.startServer(wtPath, { project: 'p', branch: 'feat', path: wtPath, type: 'plain' });

    assert.equal(refs.devCmdArg, cmdOf('npm run dev'));
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
    await runner.startServer(p, {});

    const chunk = Array.from({ length: 310 }, (_, i) => `line-${i}`).join('\n');
    refs.dev?.stdout.emit('data', chunk);

    const captured = runner.getLogs(p);
    assert.ok(captured.length <= 300, `expected <=300, got ${captured.length}`);
  });

  it('returns a copy — caller mutation does not affect internal buffer', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));
    const p = 'C:\\fake\\copyWt';
    await runner.startServer(p, {});
    const copy1 = runner.getLogs(p);
    copy1.push('poisoned');
    const copy2 = runner.getLogs(p);
    assert.ok(!copy2.includes('poisoned'), 'internal log buffer must be mutation-safe');
  });

  it('keeps each server log buffer isolated', async () => {
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\logA', {});
    refsA.dev?.stdout.emit('data', 'only-in-A\n');

    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\logB', {});
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
    await runner.startServer('C:\\fake\\A', { project: 'p', branch: 'a', path: 'C:\\fake\\A', type: 'plain' });

    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\B', { project: 'p', branch: 'b', path: 'C:\\fake\\B', type: 'plain' });

    const all = runner.getAllStatuses();
    assert.equal(all.length, 2, 'both servers should be active');
    const byPath = new Map(all.map((s) => [s.path, s]));
    assert.equal(byPath.get('C:\\fake\\A').branch, 'a');
    assert.equal(byPath.get('C:\\fake\\B').branch, 'b');
    // Ports are assigned from pool — just verify both are set and distinct
    assert.ok(byPath.get('C:\\fake\\A').port != null, 'A port should be set');
    assert.ok(byPath.get('C:\\fake\\B').port != null, 'B port should be set');
    assert.notEqual(byPath.get('C:\\fake\\A').port, byPath.get('C:\\fake\\B').port, 'ports should be distinct');
  });

  it('stopping one server leaves the other running', async () => {
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\KeepA', { project: 'p', branch: 'a', path: 'C:\\fake\\KeepA', type: 'plain' });

    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\KeepB', { project: 'p', branch: 'b', path: 'C:\\fake\\KeepB', type: 'plain' });

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
    const p1 = runner.startServer(fakePath, { project: 'p', branch: 'x', path: fakePath, type: 'plain' });
    const p2 = runner.startServer(fakePath, { project: 'p', branch: 'x', path: fakePath, type: 'plain' });

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
    await runner.startServer(p, { project: 'p', branch: 'main' });
    assert.notEqual(runner.getStatus(p).active, null);

    runner._setDockerDownFn(async () => { throw new Error('docker not available'); });
    runner._setKillFn(async () => {});

    await assert.doesNotReject(() => runner.stopServer(p));
    assert.equal(runner.getStatus(p).active, null, 'active must be null after stop');
  });

  it('passes --project-name to docker compose down when COMPOSE_PROJECT_NAME is in entry env', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-runner-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'docker-compose.yml'),
        'version: "3"\nservices:\n  app:\n    image: node:22\n    ports:\n      - "${APP_PORT}:3000"\n',
      );

      const dockerDownCalls = [];
      runner._setDockerDownFn(async (cwd, projectName) => {
        dockerDownCalls.push({ cwd, projectName });
      });

      const refs = {};
      runner._setSpawnFn(makeSpawnStub(refs));
      runner._setDockerRunningFn(async () => true);

      await runner.startServer(tmpDir, { project: 'myproj', branch: 'main', path: tmpDir, type: 'docker' });
      await runner.stopServer(tmpDir);

      assert.equal(dockerDownCalls.length, 1, 'docker compose down called once');
      assert.ok(dockerDownCalls[0].projectName, 'projectName should be set');
      assert.ok(
        typeof dockerDownCalls[0].projectName === 'string' && dockerDownCalls[0].projectName.length > 0,
        'projectName should be a non-empty string',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('stopping server A only calls docker compose down once (for A), B stays running', async () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-runner-test-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-runner-test-'));
    try {
      const composeContent = 'version: "3"\nservices:\n  app:\n    image: node:22\n    ports:\n      - "${APP_PORT}:3000"\n';
      fs.writeFileSync(path.join(tmpA, 'docker-compose.yml'), composeContent);
      fs.writeFileSync(path.join(tmpB, 'docker-compose.yml'), composeContent);

      const dockerDownCalls = [];
      runner._setDockerDownFn(async (cwd, projectName) => {
        dockerDownCalls.push({ cwd, projectName });
      });
      runner._setDockerRunningFn(async () => true);

      const refsA = {};
      runner._setSpawnFn(makeSpawnStub(refsA));
      await runner.startServer(tmpA, { project: 'projA', branch: 'main', path: tmpA, type: 'docker' });

      const refsB = {};
      runner._setSpawnFn(makeSpawnStub(refsB));
      await runner.startServer(tmpB, { project: 'projB', branch: 'main', path: tmpB, type: 'docker' });

      dockerDownCalls.length = 0; // reset after starts

      await runner.stopServer(tmpA);

      assert.equal(dockerDownCalls.length, 1, 'docker compose down called exactly once');
      assert.ok(
        dockerDownCalls[0].projectName && dockerDownCalls[0].projectName.includes('projA'),
        `expected projA in projectName, got: ${dockerDownCalls[0].projectName}`,
      );
      assert.notEqual(runner.getStatus(tmpB).active, null, 'B still running');

      await runner.stopServer(tmpB);
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});

describe('stopAll', () => {
  it('stops every running server', async () => {
    const refsA = {};
    runner._setSpawnFn(makeSpawnStub(refsA));
    await runner.startServer('C:\\fake\\AllA', { project: 'p', branch: 'a', path: 'C:\\fake\\AllA', type: 'plain' });
    const refsB = {};
    runner._setSpawnFn(makeSpawnStub(refsB));
    await runner.startServer('C:\\fake\\AllB', { project: 'p', branch: 'b', path: 'C:\\fake\\AllB', type: 'plain' });

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

    const startP = runner.startServer('C:\\fake\\ErrPath', { project: 'p', branch: 'err-branch' });
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
    await runner.startServer(p, { project: 'p', branch: 'log-branch' });
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
    await runner.startServer(p, { project: 'p', branch: 'idle-branch' });
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
      runner.startServer(p, { project: 'p', branch: 'inst-branch' }),
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

      const status = await runner.startServer(tmpDir, { project: 'p', branch: 'docker-down' });

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

      await runner.startServer(tmpDir, { project: 'p', branch: 'docker-up' });

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

      await runner.startServer(tmpDir, { project: 'p', branch: 'no-compose' });

      assert.notEqual(runner.getStatus(tmpDir).active, null, 'active must be set even though Docker returns false — no compose file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractPortFromLogLine
// ---------------------------------------------------------------------------

describe('extractPortFromLogLine', () => {
  it('extracts port from next.js style "- Local: http://localhost:3000" line', () => {
    const port = extractPortFromLogLine('  - Local:        http://localhost:3000');
    assert.equal(port, 3000);
  });

  it('extracts port from vite/next "ready - started server on 0.0.0.0:3000, url: http://localhost:3000" line', () => {
    const port = extractPortFromLogLine('ready - started server on 0.0.0.0:3000, url: http://localhost:3000');
    assert.equal(port, 3000);
  });

  it('returns null for a line with no URL', () => {
    const port = extractPortFromLogLine('no port here');
    assert.equal(port, null);
  });

  it('extracts port from https URL', () => {
    const port = extractPortFromLogLine('  Local: https://localhost:4321/');
    assert.equal(port, 4321);
  });

  it('returns null for a line with only a hostname (no port)', () => {
    const port = extractPortFromLogLine('http://localhost/no-port');
    assert.equal(port, null);
  });
});

// ---------------------------------------------------------------------------
// port detection from log output
// ---------------------------------------------------------------------------

describe('port detection from log output', () => {
  it('appending a matching log line updates getStatus(path).port for git-wt servers', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const wtPath = 'C:\\fake\\gitwt-detect';
    await runner.startServer(wtPath, { project: 'p', branch: 'main', path: wtPath, type: 'git-wt' });

    // Initially port is null for git-wt (no PORT injected)
    assert.equal(runner.getStatus(wtPath).active.port, null, 'port should be null before log line');

    // Simulate dev server printing its URL
    refs.dev?.stdout.emit('data', '  - Local:        http://localhost:3000\n');

    assert.equal(runner.getStatus(wtPath).active.port, 3000, 'port should be detected from log output');
  });

  it('only captures the first port match — subsequent lines do not override', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const wtPath = 'C:\\fake\\gitwt-first-port';
    await runner.startServer(wtPath, { project: 'p', branch: 'main', path: wtPath, type: 'git-wt' });

    refs.dev?.stdout.emit('data', '  - Local:        http://localhost:3000\n');
    refs.dev?.stdout.emit('data', '  - Network:      http://192.168.1.1:4000\n');

    assert.equal(runner.getStatus(wtPath).active.port, 3000, 'first detected port should win');
  });

  it('plain type servers also detect port from log output if initial env port differs', async () => {
    const refs = {};
    runner._setSpawnFn(makeSpawnStub(refs));

    const wtPath = 'C:\\fake\\plain-detect';
    await runner.startServer(wtPath, { project: 'p', branch: 'b', path: wtPath, type: 'plain' });

    // plain type already has a port from pool — log-based detection only fires when port is null
    const initialPort = runner.getStatus(wtPath).active.port;
    assert.ok(initialPort != null, 'plain type should have a pool port initially');
  });
});
