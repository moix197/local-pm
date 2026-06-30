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
  _setTimeoutFn,
  _setClearTimeoutFn,
  _clearPendingGrace,
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

// Drain all sessions and reset injectable seams between tests
beforeEach(() => {
  _setTimeoutFn(setTimeout);
  _setClearTimeoutFn(clearTimeout);
  for (const s of getAllSessions()) killSession(s.id);
  _clearPendingGrace();
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

  it('killSession removes session from map immediately and sends exit sequence', async () => {
    let timerCallback = null;
    _setTimeoutFn((fn) => { timerCallback = fn; return {}; });

    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const id = session.id;
    killSession(id);

    assert.equal(getSession(id), null, 'session removed from map immediately');
    assert.deepEqual(fakes[0]._calls.write, ['\x03', '/exit\r'], 'exit sequence written before kill');
    assert.equal(fakes[0]._calls.kill, 0, 'kill deferred — not called immediately');
    assert.ok(timerCallback, 'grace timer scheduled');

    // Grace fires unconditionally regardless of pty state
    timerCallback();
    assert.equal(fakes[0]._calls.kill, 1, 'kill called after grace elapses');
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

  it('two sessions on same worktreePath coexist; killSession on one leaves the other intact', async () => {
    const fakes = setupFakes();
    const shell = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const claude = await spawnSession({ worktreePath: FAKE_PATH, kind: 'claude', cols: 80, rows: 24 });
    // Both coexist in the Map under distinct ids
    assert.notEqual(shell.id, claude.id);
    assert.ok(getSession(shell.id), 'shell session in Map');
    assert.ok(getSession(claude.id), 'claude session in Map');
    // They are independent processes
    assert.notEqual(shell.ptyProcess, claude.ptyProcess);

    // Killing one does not affect the other
    killSession(shell.id);
    assert.equal(getSession(shell.id), null, 'shell session removed');
    assert.ok(getSession(claude.id), 'claude session still alive');
    // Shell pty received exit sequence (kill is deferred to grace timer); claude pty untouched
    assert.deepEqual(fakes[0]._calls.write, ['\x03', '/exit\r'], 'shell pty received exit sequence');
    assert.equal(fakes[1]._calls.kill, 0, 'claude pty NOT killed');
    assert.deepEqual(fakes[1]._calls.write, [], 'claude pty NOT written to');

    killSession(claude.id);
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
    // onData is wired at spawn time — grab the single handler registered then
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[0];
    // Attach first ws and produce some data
    const ws1 = makeFakeWs();
    attachClient(session.id, ws1);
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
    // onData is wired once at spawn — grab the single handler
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[0];
    const ws1 = makeFakeWs();
    attachClient(session.id, ws1);
    detachClient(session.id);
    const ws2 = makeFakeWs();
    attachClient(session.id, ws2);
    // Clear ws2._sent (it has the replayed chunks from scrollback)
    ws2._sent.length = 0;
    // Now fire new data
    handler('live-chunk');
    assert.ok(ws2._sent.includes('live-chunk'), 'new ws received live chunk');
    // ws1 should NOT receive it (it's detached)
    assert.ok(!ws1._sent.includes('live-chunk'), 'old ws did not receive live chunk');
    killSession(session.id);
  });

  it('scrollback byte cap evicts oldest chunks', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    // onData wired at spawn
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[0];
    const ws = makeFakeWs();
    attachClient(session.id, ws);
    // Fill scrollback to just over 512000 bytes
    // Each chunk is 100000 bytes; 6 chunks = 600000 bytes > 512000
    const bigChunk = 'x'.repeat(100000);
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
    // onData wired at spawn
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[0];
    const ws = makeFakeWs();
    attachClient(session.id, ws);
    // Push 5001 single-byte chunks to trigger chunk-count cap (5000)
    for (let i = 0; i < 5001; i++) handler('a');
    const s = getSession(session.id);
    assert.ok(s.scrollback.length <= 5000, `chunk count ${s.scrollback.length} <= 5000`);
    killSession(session.id);
  });

  it('backpressure: skips live send when bufferedAmount >= HIGH_WATER, but still appends to scrollback', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    // onData wired at spawn
    const fake = getSession(session.id).ptyProcess;
    const handler = fake._calls.dataHandlers[0];
    // ws with bufferedAmount at HIGH_WATER (1MB)
    const ws = makeFakeWs(1 << 20);
    attachClient(session.id, ws);
    handler('pressured-chunk');
    // send must NOT have been called
    assert.equal(ws._sent.length, 0, 'no live send over HIGH_WATER');
    // scrollback must still have the chunk
    const s = getSession(session.id);
    assert.ok(s.scrollback.includes('pressured-chunk'), 'chunk still in scrollback');
    killSession(session.id);
  });

  it('reattach regression: each pty chunk appears exactly once in scrollback and is sent once to new client', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    // onData wired once at spawn — only one handler must ever exist
    const fake = getSession(session.id).ptyProcess;
    assert.equal(fake._calls.dataHandlers.length, 1, 'exactly one onData handler registered at spawn');
    const handler = fake._calls.dataHandlers[0];

    // Attach client A, push a chunk, detach
    const wsA = makeFakeWs();
    attachClient(session.id, wsA);
    handler('before-detach');
    detachClient(session.id);

    // Attach client B (reattach)
    const wsB = makeFakeWs();
    attachClient(session.id, wsB);
    // Clear wsB._sent — it received the scrollback replay; we only care about live sends below
    wsB._sent.length = 0;

    // Confirm still exactly one handler after reattach (no accumulation)
    assert.equal(fake._calls.dataHandlers.length, 1, 'still exactly one handler after reattach');

    // Push new chunks through the single handler
    handler('chunk-A');
    handler('chunk-B');

    // Each chunk must appear exactly once in scrollback
    const s = getSession(session.id);
    assert.equal(s.scrollback.filter((c) => c === 'chunk-A').length, 1, 'chunk-A in scrollback exactly once');
    assert.equal(s.scrollback.filter((c) => c === 'chunk-B').length, 1, 'chunk-B in scrollback exactly once');

    // Client B must receive each live chunk exactly once
    assert.equal(wsB._sent.filter((c) => c === 'chunk-A').length, 1, 'chunk-A sent to wsB exactly once');
    assert.equal(wsB._sent.filter((c) => c === 'chunk-B').length, 1, 'chunk-B sent to wsB exactly once');

    // Client A must NOT receive the new chunks (it was detached)
    assert.ok(!wsA._sent.includes('chunk-A'), 'detached wsA did not receive chunk-A');
    assert.ok(!wsA._sent.includes('chunk-B'), 'detached wsA did not receive chunk-B');

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

  it('client-supplied sessionId is used as Map key and returned on session.id', async () => {
    setupFakes();
    const chosenId = 'client-chosen-id';
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24, sessionId: chosenId });
    assert.equal(session.id, chosenId, 'session.id matches client-supplied id');
    assert.equal(getSession(chosenId), session, 'getSession finds it by client-supplied id');
    killSession(chosenId);
  });

  it('spawnSession without sessionId generates a truthy id and getSession finds it', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    assert.ok(session.id, 'generated id is truthy');
    assert.equal(getSession(session.id), session, 'getSession finds session by generated id');
    killSession(session.id);
  });

  it('spawnSession with empty-string sessionId falls back to generated id', async () => {
    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24, sessionId: '' });
    assert.ok(session.id, 'generated id is truthy');
    assert.notEqual(session.id, '', 'id is not the empty string');
    assert.equal(getSession(session.id), session, 'getSession finds session by generated id');
    killSession(session.id);
  });

  it('client-chosen id is the reattach key: scrollback replays via attachClient', async () => {
    setupFakes();
    const chosenId = 'reattach-key-test';
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24, sessionId: chosenId });

    // Push data through the fake pty handler
    const fake = getSession(chosenId).ptyProcess;
    const handler = fake._calls.dataHandlers[0];
    const ws1 = makeFakeWs();
    attachClient(chosenId, ws1);
    handler('data-before-detach');
    detachClient(chosenId);

    // Reattach using the client-chosen id
    const ws2 = makeFakeWs();
    attachClient(chosenId, ws2);
    // scrollback must be replayed to ws2
    assert.ok(ws2._sent.includes('data-before-detach'), 'scrollback replayed via client-chosen id');
    killSession(chosenId);
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

describe('graceful killSession / shutdown finalize', () => {
  beforeEach(() => {
    // Restore real timeout/clear functions between tests in this block
    _setTimeoutFn(setTimeout);
    _setClearTimeoutFn(clearTimeout);
  });

  it('graceful kill: writes \\x03 and /exit\\r before scheduling force-kill', async () => {
    let timerCallback = null;
    _setTimeoutFn((fn) => { timerCallback = fn; return {}; });

    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    killSession(session.id);

    assert.deepEqual(fakes[0]._calls.write, ['\x03', '/exit\r'], 'exit sequence written');
    assert.equal(fakes[0]._calls.kill, 0, 'kill NOT called immediately');
    assert.ok(timerCallback, 'grace timer scheduled');
  });

  it('force-kill fires unconditionally when grace elapses even if pty never exited', async () => {
    let timerCallback = null;
    _setTimeoutFn((fn) => { timerCallback = fn; return {}; });

    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    killSession(session.id);

    assert.equal(fakes[0]._calls.kill, 0, 'kill NOT called before grace elapses');

    // Simulate grace period expiry — fires unconditionally regardless of pty state
    timerCallback();
    assert.equal(fakes[0]._calls.kill, 1, 'kill called after grace elapses');
  });

  it('killSession: session removed from map immediately (before grace fires)', async () => {
    _setTimeoutFn((fn) => {}); // capture but never fire

    setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const id = session.id;
    killSession(id);

    assert.equal(getSession(id), null, 'session gone from map immediately');
    assert.equal(getAllSessions().length, 0, 'no sessions in map');
  });

  it('killSession: second call is a no-op (idempotent)', async () => {
    const timerCallbacks = [];
    _setTimeoutFn((fn) => { timerCallbacks.push(fn); return {}; });

    const fakes = setupFakes();
    const session = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });
    const id = session.id;

    killSession(id); // first call — schedules grace
    killSession(id); // second call — session not in map, must be a no-op

    assert.equal(timerCallbacks.length, 1, 'grace timer scheduled exactly once');
    assert.deepEqual(fakes[0]._calls.write, ['\x03', '/exit\r'], 'exit sequence written exactly once');
  });

  it('shutdown() force-kills map sessions synchronously without grace window', async () => {
    _setTimeoutFn((fn) => { return {}; }); // no timer should fire for map sessions

    const fakes = setupFakes();
    const s = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });

    shutdown();

    assert.equal(getSession(s.id), null, 'session gone from map');
    assert.deepEqual(fakes[0]._calls.write, ['\x03', '/exit\r'], 'exit sequence written by shutdown');
    assert.equal(fakes[0]._calls.kill, 1, 'pty killed synchronously by shutdown');
  });

  it('shutdown() cancels pending grace timer for sessions already killed via killSession', async () => {
    let graceHandle = null;
    let clearedHandle = null;
    _setTimeoutFn((fn) => { graceHandle = { _fn: fn }; return graceHandle; });
    _setClearTimeoutFn((h) => { clearedHandle = h; });

    const fakes = setupFakes();
    const s1 = await spawnSession({ worktreePath: FAKE_PATH, kind: 'shell', cols: 80, rows: 24 });

    // Kill s1 via graceful path — schedules a grace timer
    killSession(s1.id);
    assert.equal(getSession(s1.id), null, 's1 removed from map by killSession');
    assert.equal(fakes[0]._calls.kill, 0, 'grace timer pending — kill deferred');
    assert.ok(graceHandle, 'grace timer handle captured');

    // Now shutdown() with s1 already grace-pending
    shutdown();

    // Shutdown cancelled the pending grace timer and killed s1 immediately
    assert.equal(clearedHandle, graceHandle, 'pending grace timer cleared by shutdown');
    assert.equal(fakes[0]._calls.kill, 1, 's1 pty killed synchronously by shutdown');
  });
});
