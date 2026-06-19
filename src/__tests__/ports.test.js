import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  assignPort,
  releasePort,
  readGitWtOffset,
  resolveGitCommonDir,
  scanComposePortVars,
  buildEnvForTarget,
} from '../ports.js';

const POOL_START = 3100;
const POOL_END = 3199;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

// Tracks paths assigned within a test so afterEach can free the shared pool.
const assignedInTest = new Set();

function assign(p) {
  assignedInTest.add(p);
  return assignPort(p);
}

/** Create a tmp project dir with .git/git-wt-ports.json containing the given content string (or null for absent). */
function makeFakeProjectRoot(gitWtPortsContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git'));
  if (gitWtPortsContent !== null) {
    fs.writeFileSync(path.join(tmpDir, '.git', 'git-wt-ports.json'), gitWtPortsContent);
  }
  return tmpDir;
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
  const dir = isCompose ? makeFakeProjectWithCompose(content) : makeFakeProjectRoot(content);
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
// resolveGitCommonDir
// ---------------------------------------------------------------------------

describe('resolveGitCommonDir', () => {
  it('returns the .git directory path when .git is a directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.git'));
    const result = resolveGitCommonDir(tmpDir);
    assert.equal(result, path.join(tmpDir, '.git'));
  });

  it('follows .git file pointer to commondir for linked worktrees', () => {
    // Set up a fake "main repo" with a .git directory
    const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-main-'));
    tmpDirs.push(mainRepo);
    fs.mkdirSync(path.join(mainRepo, '.git'));

    // Set up a fake "linked worktree" where .git is a file pointing at a gitdir
    const linkedWt = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-linked-'));
    tmpDirs.push(linkedWt);

    // The gitdir points to a subdirectory inside the main .git
    const gitdirPath = path.join(mainRepo, '.git', 'worktrees', 'linked');
    fs.mkdirSync(gitdirPath, { recursive: true });

    // Write .git file in linked worktree
    fs.writeFileSync(path.join(linkedWt, '.git'), `gitdir: ${gitdirPath}`);

    // Write commondir file inside the gitdir (relative path from gitdir to .git)
    // gitdirPath = mainRepo/.git/worktrees/linked
    // common dir = mainRepo/.git
    // relative from gitdir to common = ../..
    fs.writeFileSync(path.join(gitdirPath, 'commondir'), '../..');

    const result = resolveGitCommonDir(linkedWt);
    assert.equal(result, path.resolve(gitdirPath, '../..'));
    // Should resolve to mainRepo/.git
    assert.equal(result, path.join(mainRepo, '.git'));
  });

  it('returns null when .git does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    const result = resolveGitCommonDir(tmpDir);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// readGitWtOffset
// ---------------------------------------------------------------------------

describe('readGitWtOffset', () => {
  it('parses offset 0 for branch main from fixture', () => {
    const tmpDir = makeFakeProjectRoot(
      fs.readFileSync(path.join(FIXTURES, 'git-wt-ports.json'), 'utf8'),
    );
    tmpDirs.push(tmpDir);
    const result = readGitWtOffset(tmpDir, 'main');
    assert.ok(result !== null, 'should return non-null for known branch');
    assert.equal(result.offset, 0);
  });

  it('parses offset 10 for branch feat/my-feature from fixture', () => {
    const tmpDir = makeFakeProjectRoot(
      fs.readFileSync(path.join(FIXTURES, 'git-wt-ports.json'), 'utf8'),
    );
    tmpDirs.push(tmpDir);
    const result = readGitWtOffset(tmpDir, 'feat/my-feature');
    assert.ok(result !== null);
    assert.equal(result.offset, 10);
  });

  it('returns null for a missing file (no .git dir)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    const result = readGitWtOffset(tmpDir, 'main');
    assert.equal(result, null);
  });

  it('returns null for a branch key not present in the file', () => {
    const tmpDir = makeFakeProjectRoot(
      fs.readFileSync(path.join(FIXTURES, 'git-wt-ports.json'), 'utf8'),
    );
    tmpDirs.push(tmpDir);
    const result = readGitWtOffset(tmpDir, 'nonexistent-branch');
    assert.equal(result, null);
  });

  it('returns null (not throws) for malformed JSON', () => {
    const tmpDir = makeFakeProjectRoot('{ this is not valid json }');
    tmpDirs.push(tmpDir);
    assert.doesNotThrow(() => {
      const result = readGitWtOffset(tmpDir, 'main');
      assert.equal(result, null);
    });
  });
});

// ---------------------------------------------------------------------------
// scanComposePortVars
// ---------------------------------------------------------------------------

describe('scanComposePortVars', () => {
  it('extracts APP_PORT:3000 and WS_HOST_PORT:3001 from fixture', () => {
    // Use a tmp dir containing the fixture compose file content.
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
});

// ---------------------------------------------------------------------------
// buildEnvForTarget
// ---------------------------------------------------------------------------

describe('buildEnvForTarget', () => {
  it('git-wt type with valid offset sets PORT and WS_PORT via basePort + offset * increment', () => {
    // tmpDir has .git/git-wt-ports.json (offset 10 for main) — new allocations format
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'git-wt-ports.json'),
      JSON.stringify({
        allocations: { main: { branch: 'main', offset: 10 } },
        nextOffset: 11,
      }),
    );
    const env = buildEnvForTarget({ project: 'myproj', branch: 'main', path: tmpDir, type: 'git-wt' });
    // Default config: basePort=3000, increment=100, envVars=[PORT, WS_PORT]
    // port = 3000 + 10 * 100 = 4000
    assert.equal(env.PORT, '4000', 'PORT = 3000 + 10*100');
    assert.equal(env.WS_PORT, '4000', 'WS_PORT = 3000 + 10*100');
    // No compose file present — COMPOSE_PROJECT_NAME must NOT be set
    assert.ok(!env.COMPOSE_PROJECT_NAME, 'COMPOSE_PROJECT_NAME should not be set without compose file');
  });

  it('git-wt type with offset=0 (main branch) returns PORT=3000, not from pool', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'git-wt-ports.json'),
      JSON.stringify({
        allocations: { main: { branch: 'main', offset: 0 } },
        nextOffset: 1,
      }),
    );
    const env = buildEnvForTarget({ project: 'proj', branch: 'main', path: tmpDir, type: 'git-wt' });
    // offset=0 is valid: port = 3000 + 0*100 = 3000
    assert.equal(env.PORT, '3000', 'offset 0 → PORT=3000, not from pool');
    assert.equal(env.WS_PORT, '3000', 'offset 0 → WS_PORT=3000');
  });

  it('git-wt type sets COMPOSE_PROJECT_NAME when compose file is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'git-wt-ports.json'),
      JSON.stringify({
        allocations: { main: { branch: 'main', offset: 10 } },
        nextOffset: 11,
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'version: "3"\nservices:\n  app:\n    image: node:22\n    ports:\n      - "${APP_PORT}:3000"\n',
    );
    const env = buildEnvForTarget({ project: 'myproj', branch: 'main', path: tmpDir, type: 'git-wt' });
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

  it('git-wt type falls back to assignPort when readGitWtOffset returns null', () => {
    // No .git dir => offset is null => falls back to plain PORT
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
    tmpDirs.push(tmpDir);
    const env = buildEnvForTarget({ project: 'p', branch: 'main', path: tmpDir, type: 'git-wt' });
    assignedInTest.add(tmpDir);
    assert.ok(env.PORT, 'should fall back to PORT from pool');
    const port = Number(env.PORT);
    assert.ok(port >= POOL_START && port <= POOL_END, 'fallback PORT in pool range');
  });
});
