import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  assignPort,
  releasePort,
  scanComposePortVars,
  buildEnvForTarget,
} from '../ports.js';

const POOL_START = 3100;
const POOL_END = 3199;

// Tracks paths assigned within a test so afterEach can free the shared pool.
const assignedInTest = new Set();

function assign(p) {
  assignedInTest.add(p);
  return assignPort(p);
}

/** Create a tmp project dir with a docker-compose.yml containing the given content. */
function makeFakeProjectWithCompose(composeContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
  fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), composeContent);
  return tmpDir;
}

const tmpDirs = [];
afterEach(() => {
  for (const p of assignedInTest) releasePort(p);
  assignedInTest.clear();
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function makeTmp(content, isCompose = false) {
  const dir = isCompose ? makeFakeProjectWithCompose(content) : (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    fs.mkdirSync(path.join(d, '.git'));
    if (content !== null) fs.writeFileSync(path.join(d, '.git', 'git-wt-ports.json'), content);
    return d;
  })();
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// assignPort / releasePort (existing tests preserved)
// ---------------------------------------------------------------------------

describe('assignPort', () => {
  it('allocates distinct ports for distinct paths', () => {
    const a = assign('C:\\wt\\a');
    const b = assign('C:\\wt\\b');
    const c = assign('C:\\wt\\c');
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
    for (const port of [a, b, c]) {
      assert.ok(port >= POOL_START && port <= POOL_END, `port ${port} within pool`);
    }
  });

  it('returns the same port when called again for an already-assigned path', () => {
    const first = assign('C:\\wt\\same');
    const second = assign('C:\\wt\\same');
    assert.equal(first, second);
  });

  it('throws a descriptive error when the pool is exhausted', () => {
    // Fill every slot.
    for (let i = 0; i <= POOL_END - POOL_START; i += 1) assign('C:\\wt\\fill-' + i);
    assert.throws(
      () => assign('C:\\wt\\overflow'),
      /pool exhausted/i,
      'exhausted pool must throw',
    );
  });
});

describe('releasePort', () => {
  it('frees the slot so the same port can be reassigned', () => {
    const p = 'C:\\wt\\release';
    const port = assign(p);
    releasePort(p);
    assignedInTest.delete(p);
    // After release, a brand-new path should be able to take that exact port
    // (it is the lowest free slot again once nothing else is allocated).
    const reclaimed = assign('C:\\wt\\reclaim');
    assert.equal(reclaimed, port, 'released port is reusable');
  });

  it('is a no-op for an unknown path', () => {
    assert.doesNotThrow(() => releasePort('C:\\wt\\never-assigned'));
  });
});

// ---------------------------------------------------------------------------
// scanComposePortVars
// ---------------------------------------------------------------------------

describe('scanComposePortVars', () => {
  it('extracts APP_PORT:3000 and WS_HOST_PORT:3001 from fixture', () => {
    const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    const FIXTURES = path.join(__dirname, 'fixtures');
    const content = fs.readFileSync(path.join(FIXTURES, 'docker-compose.yml'), 'utf8');
    const tmpDir = makeFakeProjectWithCompose(content);
    tmpDirs.push(tmpDir);
    const vars = scanComposePortVars(tmpDir);
    assert.equal(vars.length, 2);
    const byName = Object.fromEntries(vars.map((v) => [v.varName, v]));
    assert.ok(byName.APP_PORT, 'APP_PORT should be found');
    assert.equal(byName.APP_PORT.base, 3000);
    assert.ok(byName.WS_HOST_PORT, 'WS_HOST_PORT should be found');
    assert.equal(byName.WS_HOST_PORT.base, 3001);
  });

  it('returns [] when no compose files exist in the directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    const vars = scanComposePortVars(tmpDir);
    assert.deepEqual(vars, []);
  });

  it('correctly parses ${VAR:-default} and ${VAR-default} syntax', () => {
    const content = [
      'version: "3"',
      'services:',
      '  app:',
      '    image: node:22',
      '    ports:',
      '      - "${APP_PORT:-3000}:3000"',
      '      - "${WS_PORT-3001}:3001"',
    ].join('\n');
    const tmpDir = makeFakeProjectWithCompose(content);
    tmpDirs.push(tmpDir);
    const vars = scanComposePortVars(tmpDir);
    const byName = Object.fromEntries(vars.map((v) => [v.varName, v]));
    assert.ok(byName.APP_PORT, 'APP_PORT extracted from ${APP_PORT:-3000}');
    assert.equal(byName.APP_PORT.varName, 'APP_PORT', 'varName must not include :-default part');
    assert.ok(byName.WS_PORT, 'WS_PORT extracted from ${WS_PORT-3001}');
    assert.equal(byName.WS_PORT.varName, 'WS_PORT', 'varName must not include -default part');
  });
});

// ---------------------------------------------------------------------------
// buildEnvForTarget
// ---------------------------------------------------------------------------

describe('buildEnvForTarget', () => {
  it('git-wt type returns no PORT or WS_PORT — does not impose a port', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    const env = buildEnvForTarget({ project: 'proj', branch: 'feat/dev-otp-echo', path: tmpDir, type: 'git-wt' });
    assert.ok(!('PORT' in env), 'PORT must NOT be set for git-wt target');
    assert.ok(!('WS_PORT' in env), 'WS_PORT must NOT be set for git-wt target');
  });

  it('git-wt type without compose file returns empty env {}', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    const env = buildEnvForTarget({ project: 'proj', branch: 'main', path: tmpDir, type: 'git-wt' });
    assert.deepEqual(env, {}, 'no compose file → empty env for git-wt');
  });

  it('git-wt type sets COMPOSE_PROJECT_NAME when compose file is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'version: "3"\nservices:\n  app:\n    image: node:22\n    ports:\n      - "${APP_PORT}:3000"\n',
    );
    const env = buildEnvForTarget({ project: 'myproj', branch: 'main', path: tmpDir, type: 'git-wt' });
    assert.ok(!('PORT' in env), 'PORT must NOT be set for git-wt target even with compose');
    assert.ok(!('WS_PORT' in env), 'WS_PORT must NOT be set for git-wt target even with compose');
    assert.ok(env.COMPOSE_PROJECT_NAME, 'COMPOSE_PROJECT_NAME should be set when compose file exists');
    assert.ok(env.COMPOSE_PROJECT_NAME.startsWith('myproj'), 'project name in COMPOSE_PROJECT_NAME');
  });

  it('plain type returns PORT from pool', () => {
    const env = buildEnvForTarget({ project: 'p', branch: 'b', path: 'C:\\fake\\plain', type: 'plain' });
    assignedInTest.add('C:\\fake\\plain');
    assert.ok(env.PORT, 'PORT should be set');
    const port = Number(env.PORT);
    assert.ok(port >= POOL_START && port <= POOL_END, 'PORT should be in pool range');
    assert.ok(!env.COMPOSE_PROJECT_NAME, 'plain type should not set COMPOSE_PROJECT_NAME');
  });

  it('docker type assigns pool ports per compose var and sets COMPOSE_PROJECT_NAME', () => {
    const content = 'version: "3"\nservices:\n  app:\n    image: node:22\n    ports:\n      - "${APP_PORT}:3000"\n';
    const tmpDir = makeFakeProjectWithCompose(content);
    tmpDirs.push(tmpDir);
    const env = buildEnvForTarget({ project: 'proj', branch: 'main', path: tmpDir, type: 'docker' });
    // Register composite keys for cleanup
    assignedInTest.add(`${tmpDir}:APP_PORT`);
    assert.ok(env.APP_PORT, 'APP_PORT should be assigned from pool');
    const port = Number(env.APP_PORT);
    assert.ok(port >= POOL_START && port <= POOL_END, 'APP_PORT in pool range');
    assert.ok(env.COMPOSE_PROJECT_NAME, 'COMPOSE_PROJECT_NAME should be set');
  });

  it('docker type pool ports are fully freed after releasePort — no leak across start→stop→start', () => {
    const content =
      'version: "3"\nservices:\n  app:\n    image: node:22\n    ports:\n      - "${APP_PORT}:3000"\n      - "${WS_HOST_PORT}:3001"\n';
    const tmpDir = makeFakeProjectWithCompose(content);
    tmpDirs.push(tmpDir);

    const worktree = { project: 'proj', branch: 'main', path: tmpDir, type: 'docker' };

    // First start — allocates composite keys.
    const env1 = buildEnvForTarget(worktree);
    const port1 = Number(env1.APP_PORT);
    assert.ok(port1 >= POOL_START && port1 <= POOL_END, 'first APP_PORT in pool range');

    // Simulate stop — releasePort with bare path must free composite keys.
    releasePort(tmpDir);

    // Second start — must succeed (pool not leaked) and can reuse the same slots.
    const env2 = buildEnvForTarget(worktree);
    assert.ok(env2.APP_PORT, 'APP_PORT assigned on second start');
    assert.ok(env2.WS_HOST_PORT, 'WS_HOST_PORT assigned on second start');
    // Clean up second allocation.
    releasePort(tmpDir);
  });
});
