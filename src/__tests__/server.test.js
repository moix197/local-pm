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
  await runner.stopServer();
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

  it('returns 409 when a server is active', async () => {
    const wt = await knownWorktreePath();
    // Make a server active via the runner with stubbed spawn.
    runner._setSpawnFn(() => makeChild(999, false));
    await runner.startServer(wt, { project: 'self', branch: 'main' });
    assert.notEqual(runner.getStatus().active, null);

    const res = await fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: wt, cmd: 'npm install', label: 'npm install' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'stop the server first');
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
