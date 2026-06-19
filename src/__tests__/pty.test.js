import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnSession,
  writeToSession,
  resizeSession,
  killSession,
  getSession,
  getAllSessions,
  MAX_SESSIONS,
  _setSpawnFn,
  _setGetWorktreesFn,
  attachClient,
  detachClient,
  _setTimerFn,
  _restartReaper,
  shutdown,
} from '../pty.js';

const FAKE_PATH = 'C:/projects/my-wt';

function makeFakePty() {
  const calls = { write: [], resize: [], kill: 0, dataHandlers: [] };
  const pty = {
    onData(fn) { calls.dataHandlers.push(fn); },
    write(data) { calls.write.push(data); },
    resize(cols, rows) { calls.resize.push({ cols, rows }); },
    kill() { calls.kill += 1; },
    _calls: calls,
  };
  return pty;
}

function makeFakeWs(bufferedAmount = 0) {
  const sent = [];
  return {
    readyState: 1, // OPEN = 1
    get constructor() { return { OPEN: 1 }; },
    bufferedAmount,
    send(data) { sent.push(data); },
    _sent: sent,
  };
}

function setupFakes(worktreePaths = [FAKE_PATH]) {
  const fakes = [];
  _setSpawnFn(() => {
    const pty = makeFakePty();
    fakes.push(pty);
    return pty;
  });
  _setGetWorktreesFn(async () => worktreePaths.map((p) => ({ path: p, project: 'x', branch: 'main' })));
  return fakes;
}

// Drain all sessions between tests to avoid cap leakage
beforeEach(() => {
  for (const s of getAllSessions()) killSession(s.id);
});

describe('spawnSession security invariants', () => {
  it('unknown worktreePath throws 4403', async () => {
    setupFakes(['/other/path']);
    await assert.rejects(
      () => spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 }),
      (err) => { assert.equal(err.code, 4403); return true; },
    );
  });

  it('invalid kind throws 4403', async () => {
    setupFakes();
    await assert.rejects(
      () => spawnSession({ worktreePath: FAKE_PATH, kind: 'evil', cols: 80, rows: 24 }),
      (err) => { assert.equal(err.code, 4403); return true; },
    );
  });

  it('enforces MAX_SESSIONS cap (11th throws 4429)', async () => {
    setupFakes();
    _setGetWorktreesFn(async () => [{ path: FAKE_PATH, project: 'x', branch: 'main' }]);
    const fakes = [];
    _setSpawnFn(() => { const p = makeFakePty(); fakes.push(p); return p; });

    for (let i = 0; i < MAX_SESSIONS; i++) {
      await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    }
    assert.equal(getAllSessions().length, MAX_SESSIONS);
    await assert.rejects(
      () => spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 }),
      (err) => { assert.equal(err.code, 4429); return true; },
    );
  });

  it('cols/rows clamped: NaN -> 1, 600 -> 500', async () => {
    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: NaN, rows: 600 });
    // The spawn fn receives clamped values; check session was created
    assert.ok(session.id);
    // Verify by resizing with known values and checking the fake received them
    resizeSession(session.id, NaN, 600);
    const fake = fakes[0];
    assert.deepEqual(fake._calls.resize[0], { cols: 1, rows: 500 });
    killSession(session.id);
  });

  it('kind=shell spawns with correct shell + empty args', async () => {
    let capturedArgs;
    _setGetWorktreesFn(async () => [{ path: FAKE_PATH, project: 'x', branch: 'main' }]);
    _setSpawnFn((shell, args, opts) => {
      capturedArgs = { shell, args, cwd: opts.cwd };
      return makeFakePty();
    });
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    assert.ok(typeof capturedArgs.shell === 'string');
    assert.ok(capturedArgs.shell === 'pwsh.exe' || capturedArgs.shell === 'cmd.exe');
    assert.deepEqual(capturedArgs.args, []);
    assert.equal(capturedArgs.cwd, FAKE_PATH);
    killSession(session.id);
  });

  it('kind=claude spawns with claude subcommand args', async () => {
    let capturedArgs;
    _setGetWorktreesFn(async () => [{ path: FAKE_PATH, project: 'x', branch: 'main' }]);
    _setSpawnFn((shell, args, opts) => {
      capturedArgs = { shell, args };
      return makeFakePty();
    });
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'claude', cols: 80, rows: 24 });
    assert.ok(capturedArgs.args.length > 0, 'claude kind passes args');
    assert.ok(
      capturedArgs.args.includes('claude') || capturedArgs.args.some((a) => a.includes('claude')),
      'claude appears in args',
    );
    killSession(session.id);
  });
});

describe('session operations', () => {
  it('writeToSession delegates to fake process', async () => {
    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    writeToSession(session.id, 'hello');
    assert.deepEqual(fakes[0]._calls.write, ['hello']);
    killSession(session.id);
  });

  it('resizeSession delegates to fake process', async () => {
    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    resizeSession(session.id, 120, 40);
    assert.deepEqual(fakes[0]._calls.resize, [{ cols: 120, rows: 40 }]);
    killSession(session.id);
  });

  it('killSession removes session and calls kill on process', async () => {
    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const id = session.id;
    killSession(id);
    assert.equal(getSession(id), null);
    assert.equal(fakes[0]._calls.kill, 1);
  });

  it('getSession returns null for unknown id', () => {
    assert.equal(getSession('not-a-real-id'), null);
  });

  it('getAllSessions returns all active sessions', async () => {
    setupFakes();
    const s1 = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const s2 = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const all = getAllSessions();
    assert.ok(all.some((s) => s.id === s1.id));
    assert.ok(all.some((s) => s.id === s2.id));
    killSession(s1.id);
    killSession(s2.id);
  });
});

describe('detach/reattach/scrollback/reaper', () => {
  beforeEach(() => {
    // restore real setInterval between tests
    _setTimerFn(setInterval);
    _restartReaper();
  });

  it('detachClient keeps pty alive, sets ws=null and idleAt', async () => {
    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const ws = makeFakeWs();
    attachClient(session.id, ws);
    detachClient(session.id);
    const s = getSession(session.id);
    assert.ok(s, 'session still in Map');
    assert.equal(s.ws, null);
    assert.ok(s.idleAt > 0, 'idleAt set');
    assert.equal(fakes[0]._calls.kill, 0, 'pty NOT killed');
    killSession(session.id);
  });

  it('attachClient replays scrollback to new ws in order', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    // Attach first ws and produce some data
    const ws1 = makeFakeWs();
    attachClient(session.id, ws1);
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[fake._calls.dataHandlers.length - 1];
    handler('chunk1');
    handler('chunk2');
    handler('chunk3');
    // Detach
    detachClient(session.id);
    // Reattach with new ws
    const ws2 = makeFakeWs();
    attachClient(session.id, ws2);
    // scrollback should be replayed
    assert.deepEqual(ws2._sent.slice(0, 3), ['chunk1', 'chunk2', 'chunk3']);
    killSession(session.id);
  });

  it('live data after reattach goes to new ws only', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const ws1 = makeFakeWs();
    attachClient(session.id, ws1);
    detachClient(session.id);
    const ws2 = makeFakeWs();
    attachClient(session.id, ws2);
    // Clear ws2._sent (it has the replayed chunks from scrollback)
    ws2._sent.length = 0;
    // Now fire new data
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[fake._calls.dataHandlers.length - 1];
    handler('live-chunk');
    assert.ok(ws2._sent.includes('live-chunk'), 'new ws received live chunk');
    // ws1 should NOT receive it (it's detached)
    assert.ok(!ws1._sent.includes('live-chunk'), 'old ws did not receive live chunk');
    killSession(session.id);
  });

  it('scrollback byte cap evicts oldest chunks', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const ws = makeFakeWs();
    attachClient(session.id, ws);
    // Fill scrollback to just over 512000 bytes
    // Each chunk is 100000 bytes; 6 chunks = 600000 bytes > 512000
    const bigChunk = 'x'.repeat(100000);
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[fake._calls.dataHandlers.length - 1];
    for (let i = 0; i < 6; i++) handler(bigChunk);
    const s = getSession(session.id);
    // Total bytes must be <= 512000; at most 5 full chunks
    assert.ok(s.scrollbackBytes <= 512000, `bytes ${s.scrollbackBytes} <= 512000`);
    assert.ok(s.scrollback.length < 6, 'oldest chunks evicted');
    killSession(session.id);
  });

  it('scrollback chunk-count cap evicts oldest chunks', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const ws = makeFakeWs();
    attachClient(session.id, ws);
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[fake._calls.dataHandlers.length - 1];
    // Push 5001 single-byte chunks to trigger chunk-count cap (5000)
    for (let i = 0; i < 5001; i++) handler('a');
    const s = getSession(session.id);
    assert.ok(s.scrollback.length <= 5000, `chunk count ${s.scrollback.length} <= 5000`);
    killSession(session.id);
  });

  it('backpressure: skips live send when bufferedAmount >= HIGH_WATER, but still appends to scrollback', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    // ws with bufferedAmount at HIGH_WATER (1MB)
    const ws = makeFakeWs(1 << 20);
    attachClient(session.id, ws);
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[fake._calls.dataHandlers.length - 1];
    handler('pressured-chunk');
    // send must NOT have been called
    assert.equal(ws._sent.length, 0, 'no live send over HIGH_WATER');
    // scrollback must still have the chunk
    const s = getSession(session.id);
    assert.ok(s.scrollback.includes('pressured-chunk'), 'chunk still in scrollback');
    killSession(session.id);
  });

  it('idle reaper kills session after IDLE_TIMEOUT_MS', async () => {
    setupFakes();
    let timerCallback = null;
    _setTimerFn((fn, _interval) => {
      timerCallback = fn;
      return { unref() {} }; // fake interval handle
    });
    _restartReaper();

    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const ws = makeFakeWs();
    attachClient(session.id, ws);
    // Set idleAt to a long time ago (past IDLE_TIMEOUT_MS)
    detachClient(session.id);
    const s = getSession(session.id);
    s.idleAt = Date.now() - (31 * 60 * 1000); // 31 minutes ago

    // Fire the reaper
    assert.ok(timerCallback, 'timer callback registered');
    timerCallback();

    assert.equal(getSession(session.id), null, 'session reaped from Map');
  });

  it('reaper does NOT kill session with active client', async () => {
    setupFakes();
    let timerCallback = null;
    _setTimerFn((fn, _interval) => {
      timerCallback = fn;
      return { unref() {} };
    });
    _restartReaper();

    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const ws = makeFakeWs();
    attachClient(session.id, ws);
    // session.ws is set, idleAt is 0 — should NOT be reaped even if we fire the callback

    timerCallback();
    assert.ok(getSession(session.id), 'session with active client NOT reaped');
    killSession(session.id);
  });

  it('shutdown() kills all sessions and clears the reaper interval', async () => {
    const fakeHandle = { unref() {} };
    _setTimerFn((fn, _interval) => fakeHandle);
    _restartReaper();

    setupFakes();
    const s1 = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const s2 = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });

    // Override clearInterval seam for this test
    // shutdown() calls clearInterval(_reaperInterval) — we check sessions are cleared
    shutdown();
    assert.equal(getSession(s1.id), null, 's1 killed');
    assert.equal(getSession(s2.id), null, 's2 killed');
    // Restore
    _setTimerFn(setInterval);
    _restartReaper();
  });
});
