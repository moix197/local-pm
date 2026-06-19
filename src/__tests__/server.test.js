import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../server.js';
import { ensureToken } from '../token.js';
import * as runner from '../runner.js';
import { assignPort, releasePort, _setIsPortFreeFn, _resetIsPortFreeFn } from '../ports.js';
import { WebSocket as WsClient } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const projectsFile = path.join(repoRoot, 'projects.json');

let baseUrl;
let token;
let projectsBackup;
let projectsExisted;

// --- child-process stub seams (mirror runner.test.js) -----------------------
function makeStream() {
  const h = {};
  return { setEncoding() {}, on(ev, fn) { h[ev] = fn; }, emit(ev, d) { h[ev]?.(d); } };
}
function makeChild(pid, autoClose = false) {
  const h = {};
  const child = {
    pid,
    stdout: makeStream(),
    stderr: makeStream(),
    on(ev, fn) { h[ev] = fn; if (autoClose && ev === 'close') Promise.resolve().then(() => fn()); },
    emit(ev, d) { h[ev]?.(d); },
  };
  return child;
}
function stubRunner() {
  runner._setKillFn(async () => {});
  runner._setDockerDownFn(async () => {});
  runner._setDockerRunningFn(async () => true);
  runner._setSpawnFn(() => makeChild(0, true));
}

// Spawn stub for paths WITHOUT node_modules: first call (npm install) auto-closes
// so runNpmInstall resolves; second call (npm run dev) is long-lived.
function installThenDev(devPid) {
  let n = 0;
  return () => {
    n += 1;
    return n === 1 ? makeChild(devPid - 1, /* autoClose */ true) : makeChild(devPid, false);
  };
}

before(async () => {
  // Point projects.json at this repo so a known worktree path exists.
  projectsExisted = fs.existsSync(projectsFile);
  projectsBackup = projectsExisted ? fs.readFileSync(projectsFile, 'utf8') : null;
  fs.writeFileSync(projectsFile, JSON.stringify([{ name: 'self', root: repoRoot }]) + '\n', 'utf8');

  token = ensureToken().token;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (projectsBackup === null) {
    if (fs.existsSync(projectsFile)) fs.rmSync(projectsFile);
  } else {
    fs.writeFileSync(projectsFile, projectsBackup, 'utf8');
  }
});

// Paths used by command tests, cleared per-test (stopCommand is per-path now).
const cmdPaths = new Set();

beforeEach(async () => {
  stubRunner();
  await runner.stopAll();
  for (const p of cmdPaths) runner.stopCommand(p);
  cmdPaths.clear();
});

function auth(extra = {}) {
  return { Authorization: 'Bearer ' + token, ...extra };
}

async function knownWorktreePath() {
  const res = await fetch(`${baseUrl}/api/state`, { headers: auth() });
  const body = await res.json();
  return body.worktrees[0]?.path ?? repoRoot;
}

describe('auth gate', () => {
  it('rejects /api/command without Bearer (401)', async () => {
    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoRoot, cmd: 'x', label: 'x' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects /api/command/stop without Bearer (401)', async () => {
    const res = await fetch(`${baseUrl}/api/command/stop`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/command', () => {
  it('returns 400 on unknown/missing path', async () => {
    const missing = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ cmd: 'x', label: 'x' }),
    });
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: 'C:/nope/nowhere', cmd: 'x', label: 'x' }),
    });
    assert.equal(unknown.status, 400);
  });

  it('no longer returns the global 409 when a server is active', async () => {
    const wt = await knownWorktreePath();
    cmdPaths.add(wt);
    // Make a server active via the runner with stubbed spawn.
    runner._setSpawnFn(() => makeChild(999, false));
    await runner.startServer(wt, { project: 'self', branch: 'main' }, { PORT: '3100' });
    assert.notEqual(runner.getStatus(wt).active, null);

    runner._setSpawnFn(() => makeChild(888, false));
    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt, cmd: 'npm install', label: 'npm install' }),
    });
    assert.equal(res.status, 200, 'command runs even while a server is active');
  });

  it('returns 200 and delegates to runCommand when stopped', async () => {
    const wt = await knownWorktreePath();
    cmdPaths.add(wt);
    let spawned = false;
    runner._setSpawnFn(() => { spawned = true; return makeChild(111, false); });

    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt, cmd: 'npm install', label: 'npm install' }),
    });
    assert.equal(res.status, 200);
    assert.ok(spawned, 'runCommand spawned the command');
    const body = await res.json();
    assert.equal(body.command.status, 'running');
  });

  it('runs a command on the route while another path already has one (no global 409)', async () => {
    const wt = await knownWorktreePath();
    const other = wt + '#other';
    cmdPaths.add(wt);
    cmdPaths.add(other);
    // Seed a long-lived command on a DIFFERENT path directly in the runner.
    runner._setSpawnFn(() => makeChild(700, false));
    await runner.runCommand(other, { cmd: 'busy', label: 'busy' });
    assert.equal(runner.getStatus(other).command.status, 'running');

    // The route must still accept a command for the known worktree path — the
    // busy command in `other` must not produce a global 409.
    runner._setSpawnFn(() => makeChild(701, false));
    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt, cmd: 'cmd-a', label: 'cmd-a' }),
    });
    assert.equal(res.status, 200, 'command runs even while another path is busy');
    assert.equal(runner.getStatus(other).command.status, 'running', 'other path unaffected');
  });

  it('returns 409 when the same path already has an active command', async () => {
    const wt = await knownWorktreePath();
    cmdPaths.add(wt);
    runner._setSpawnFn(() => makeChild(811, false));
    const first = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt, cmd: 'sleep', label: 'sleep' }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt, cmd: 'sleep2', label: 'sleep2' }),
    });
    assert.equal(second.status, 409, 'same path twice returns 409');
  });
});

describe('GET /vendor/ static route', () => {
  it('serves xterm.js as application/javascript', async () => {
    const res = await fetch(`${baseUrl}/vendor/xterm.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/javascript');
  });

  it('serves xterm.css as text/css', async () => {
    const res = await fetch(`${baseUrl}/vendor/xterm.css`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/css');
  });

  it('serves addon-fit.js as application/javascript', async () => {
    const res = await fetch(`${baseUrl}/vendor/addon-fit.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/javascript');
  });

  it('rejects a path-traversal attempt with 403', async () => {
    // ..%2f survives URL normalization (a bare ../ would collapse before reaching
    // the handler); decoded it escapes public/vendor/, so the guard must 403.
    const res = await fetch(`${baseUrl}/vendor/..%2ftoken.local`);
    assert.equal(res.status, 403);
  });

  it('rejects an absolute-path injection with 403', async () => {
    // %2f-encoded leading slash decodes to an absolute path that resolves
    // outside public/vendor/ — the guard must reject it too.
    const res = await fetch(`${baseUrl}/vendor/%2fetc%2fpasswd`);
    assert.equal(res.status, 403);
  });

  it('returns 404 for a missing vendor file', async () => {
    const res = await fetch(`${baseUrl}/vendor/nope.js`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/state', () => {
  it('returns a running array and omits the legacy logs field', async () => {
    const res = await fetch(`${baseUrl}/api/state`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.running), 'running is an array');
    assert.equal(body.logs, undefined, 'logs dropped from /api/state body');
    assert.ok(typeof body.serverPort === 'number');
  });
});

describe('GET /api/logs', () => {
  it('returns 400 without a path', async () => {
    const res = await fetch(`${baseUrl}/api/logs`, { headers: auth() });
    assert.equal(res.status, 400);
  });

  it('returns that server\'s own log lines', async () => {
    const wt = await knownWorktreePath();
    let child;
    runner._setSpawnFn(() => { child = makeChild(321, false); return child; });
    await runner.startServer(wt, { project: 'self', branch: 'main' }, { PORT: '3100' });
    child.stdout.emit('data', 'hello-from-server\n');

    const res = await fetch(`${baseUrl}/api/logs?path=${encodeURIComponent(wt)}`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.logs));
    assert.ok(body.logs.includes('hello-from-server'), 'log line for that path returned');
  });
});

describe('GET /api/browse', () => {
  it('returns 401 without a Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent(repoRoot)}`);
    assert.equal(res.status, 401);
  });

  it('returns a listing for a valid directory', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent(repoRoot)}`, {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, repoRoot);
    assert.ok(Array.isArray(body.entries), 'entries is an array');
    assert.ok(Array.isArray(body.drives), 'drives is an array');
    assert.ok(body.entries.every((e) => typeof e.name === 'string' && typeof e.isProject === 'boolean'));
    assert.ok(body.entries.some((e) => e.name === 'src'), 'lists the src subdirectory');
  });

  it('returns 400 for an invalid directory', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent('C:/nope/nowhere/at/all')}`, {
      headers: auth(),
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/stop', () => {
  it('stops only the given path when a path is supplied', async () => {
    const wt = await knownWorktreePath();
    runner._setSpawnFn(() => makeChild(501, false));
    await runner.startServer(wt, { project: 'self', branch: 'main' }, { PORT: '3100' });
    runner._setSpawnFn(installThenDev(502));
    await runner.startServer(wt + '#b', { project: 'self', branch: 'b' }, { PORT: '3101' });
    assert.equal(runner.getAllStatuses().length, 2);

    const res = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt }),
    });
    assert.equal(res.status, 200);
    assert.equal(runner.getStatus(wt).active, null, 'target path stopped');
    assert.notEqual(runner.getStatus(wt + '#b').active, null, 'other path still running');
  });

  it('stops all servers when no path is supplied', async () => {
    const wt = await knownWorktreePath();
    runner._setSpawnFn(() => makeChild(601, false));
    await runner.startServer(wt, { project: 'self', branch: 'main' }, { PORT: '3100' });
    runner._setSpawnFn(installThenDev(602));
    await runner.startServer(wt + '#b', { project: 'self', branch: 'b' }, { PORT: '3101' });
    assert.equal(runner.getAllStatuses().length, 2);

    const res = await fetch(`${baseUrl}/api/stop`, { method: 'POST', headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.running.length, 0, 'all servers stopped');
  });
});

describe('POST /api/start concurrent', () => {
  it('does not return 409 when a second server starts while one is running', async () => {
    const wt = await knownWorktreePath();
    runner._setSpawnFn(() => makeChild(701, false));
    await runner.startServer(wt, { project: 'self', branch: 'main' }, { PORT: '3100' });
    assert.notEqual(runner.getStatus(wt).active, null);

    // A second distinct worktree path. Use the same known root with a suffix so
    // the worktrees lookup still finds a matching entry via the known set.
    runner._setSpawnFn(() => makeChild(702, false));
    const res = await fetch(`${baseUrl}/api/start`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt }),
    });
    // Same path is guarded by runner's per-path inProgress, but the route never
    // returns a global 409 — it returns 200 with status.
    assert.notEqual(res.status, 409, 'no global 409 on concurrent start');
  });
});

describe('project CRUD routes', () => {
  // These routes mutate projects.json; snapshot/restore around each so the
  // shared file (also used by /api/state worktree lookups) stays consistent.
  function withProjectsSnapshot(fn) {
    const backup = fs.readFileSync(projectsFile, 'utf8');
    return Promise.resolve(fn()).finally(() => fs.writeFileSync(projectsFile, backup, 'utf8'));
  }

  it('GET /api/projects returns the configured list', async () => {
    await withProjectsSnapshot(async () => {
      const res = await fetch(`${baseUrl}/api/projects`, { headers: auth() });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.projects));
      assert.ok(body.projects.some((p) => p.root === repoRoot));
    });
  });

  it('POST /api/projects/add detects + persists, returns devCmd in detection', async () => {
    await withProjectsSnapshot(async () => {
      const res = await fetch(`${baseUrl}/api/projects/add`, {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ path: repoRoot }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.project.root, repoRoot);
      assert.ok(body.detection, 'detection present');
      assert.ok('devCmd' in body.detection, 'devCmd surfaced for UI display');
      assert.ok(typeof body.detection.type === 'string');
      // The detected devCmd must be persisted on the project entry so Start
      // later spawns it (this repo has a "start" script → npm run start).
      assert.equal(body.project.devCmd, body.detection.devCmd, 'add persists detected devCmd');
      const stored = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      const saved = stored.find((p) => p.root === repoRoot);
      assert.equal(saved.devCmd, body.detection.devCmd, 'devCmd written to projects.json');
    });
  });

  it('POST /api/projects/add returns 400 for an invalid directory', async () => {
    const res = await fetch(`${baseUrl}/api/projects/add`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: 'C:/nope/nowhere/at/all' }),
    });
    assert.equal(res.status, 400);
  });

  it('DELETE /api/projects removes the entry', async () => {
    await withProjectsSnapshot(async () => {
      fs.writeFileSync(
        projectsFile,
        JSON.stringify([{ name: 'self', root: repoRoot }, { name: 'gone', root: 'C:/p/gone' }]) + '\n',
        'utf8',
      );
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'DELETE',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ root: 'C:/p/gone' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!body.projects.some((p) => p.root === 'C:/p/gone'));
    });
  });

  it('PATCH /api/projects updates the entry', async () => {
    await withProjectsSnapshot(async () => {
      fs.writeFileSync(
        projectsFile,
        JSON.stringify([{ name: 'self', root: repoRoot }, { name: 'edit-me', root: 'C:/p/edit' }]) + '\n',
        'utf8',
      );
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: 'PATCH',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ root: 'C:/p/edit', patch: { name: 'edited', devCmd: 'npm run dev' } }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.project.name, 'edited');
      assert.equal(body.project.devCmd, 'npm run dev');
    });
  });
});

describe('WebSocket upgrade', () => {
  it('rejects upgrade with wrong token (401 before handshake)', async () => {
    const { port } = server.address();
    await new Promise((resolve, reject) => {
      const client = new WsClient(`ws://127.0.0.1:${port}/ws/terminal?token=wrongtoken`);
      client.on('unexpected-response', (req, res) => {
        try {
          assert.equal(res.statusCode, 401);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      client.on('error', () => resolve());
    });
  });
});

describe('POST /api/start pool exhaustion', () => {
  it('returns 503 with a descriptive message when the port pool is exhausted', async () => {
    const POOL_START = 3100;
    const POOL_END = 3199;
    const filledKeys = [];
    // Stub OS probes so filling all slots doesn't require opening real sockets.
    _setIsPortFreeFn(async () => true);
    // Fill every slot in the pool so the next assignPort throws.
    for (let i = 0; i <= POOL_END - POOL_START; i += 1) {
      const key = `__fill__${i}`;
      await assignPort(key);
      filledKeys.push(key);
    }
    try {
      const wt = await knownWorktreePath();
      const res = await fetch(`${baseUrl}/api/start`, {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ path: wt }),
      });
      assert.equal(res.status, 503, 'exhausted pool must return 503');
      const body = await res.json();
      assert.ok(/pool exhausted/i.test(body.error), `expected pool-exhausted message, got: ${body.error}`);
    } finally {
      _resetIsPortFreeFn();
      for (const key of filledKeys) releasePort(key);
    }
  });
});
