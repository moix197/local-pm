import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../server.js';
import { ensureToken } from '../token.js';
import * as runner from '../runner.js';

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

beforeEach(async () => {
  stubRunner();
  await runner.stopAll();
  runner.stopCommand();
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
