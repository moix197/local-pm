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
