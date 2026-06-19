import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoDetectProject } from '../detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'detect');
const gitwtDir = path.join(FIXTURES, 'gitwt');
const dockerDir = path.join(FIXTURES, 'docker');
const plainDir = path.join(FIXTURES, 'plain');
const ambiguousDir = path.join(FIXTURES, 'ambiguous');

describe('autoDetectProject — security gate', () => {
  it('throws on a nonexistent path', () => {
    assert.throws(() => autoDetectProject('C:/nope/does/not/exist'), /not a directory/);
  });

  it('throws when the path is a file, not a directory', () => {
    const aFile = path.join(plainDir, 'package.json');
    assert.throws(() => autoDetectProject(aFile), /not a directory/);
  });
});

describe('autoDetectProject — type detection', () => {
  it('detects git-wt via .git/git-wt-ports.json', () => {
    const result = autoDetectProject(gitwtDir);
    assert.equal(result.type, 'git-wt');
  });

  it('detects docker via docker-compose.yml', () => {
    const result = autoDetectProject(dockerDir);
    assert.equal(result.type, 'docker');
    const byName = Object.fromEntries(result.portVars.map((v) => [v.varName, v]));
    assert.ok(byName.APP_PORT, 'APP_PORT extracted from compose');
    assert.equal(byName.APP_PORT.base, 3000);
  });

  it('detects plain when no git-wt or compose markers exist', () => {
    const result = autoDetectProject(plainDir);
    assert.equal(result.type, 'plain');
    assert.deepEqual(result.portVars, []);
  });
});

describe('autoDetectProject — devCmd sourcing', () => {
  it('sources devCmd from package.json scripts.dev', () => {
    const result = autoDetectProject(plainDir);
    assert.equal(result.devCmd, 'npm run dev');
    assert.equal(result.needsSetup, false);
  });

  it('falls back to scripts.start when no dev script', () => {
    const result = autoDetectProject(dockerDir);
    assert.equal(result.devCmd, 'npm run start');
  });

  it('sets needsSetup when neither dev nor start script exists', () => {
    const result = autoDetectProject(ambiguousDir);
    assert.equal(result.devCmd, null);
    assert.equal(result.needsSetup, true);
  });
});
