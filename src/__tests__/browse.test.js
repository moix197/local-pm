import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDirectory } from '../browse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'detect');
const plainDir = path.join(FIXTURES, 'plain');

describe('listDirectory — validation', () => {
  it('throws on a nonexistent path', () => {
    assert.throws(() => listDirectory('C:/nope/does/not/exist'), /not a directory/);
  });

  it('throws when the path is a file, not a directory', () => {
    const aFile = path.join(plainDir, 'package.json');
    assert.throws(() => listDirectory(aFile), /not a directory/);
  });
});

describe('listDirectory — listing', () => {
  it('returns only subdirectories (files excluded)', () => {
    const result = listDirectory(FIXTURES);
    const names = result.entries.map((e) => e.name);
    assert.ok(names.includes('plain'), 'subdir listed');
    assert.ok(names.includes('docker'), 'subdir listed');
    // detect/ contains only directories, so a known file from a child must NOT appear.
    assert.ok(!names.includes('package.json'), 'files are excluded');
  });

  it('reports the resolved path and a correct parent', () => {
    const result = listDirectory(FIXTURES);
    assert.equal(result.path, FIXTURES);
    assert.equal(result.parent, path.dirname(FIXTURES));
  });

  it('flags isProject for a dir containing package.json and not otherwise', () => {
    // FIXTURES/detect/plain has a package.json → isProject true.
    const inDetect = listDirectory(FIXTURES);
    const plainEntry = inDetect.entries.find((e) => e.name === 'plain');
    assert.ok(plainEntry, 'plain dir present');
    assert.equal(plainEntry.isProject, true, 'package.json marks it a project');

    // FIXTURES/detect itself sits under a dir whose siblings are non-project.
    const parent = path.dirname(FIXTURES); // .../fixtures
    const inFixtures = listDirectory(parent);
    const detectEntry = inFixtures.entries.find((e) => e.name === 'detect');
    assert.ok(detectEntry, 'detect dir present');
    assert.equal(detectEntry.isProject, false, 'no markers → not a project');
  });

  it('exposes drives as an array', () => {
    const result = listDirectory(FIXTURES);
    assert.ok(Array.isArray(result.drives));
  });

  it('falls back to a sensible default dir when none is given', () => {
    const result = listDirectory();
    assert.equal(typeof result.path, 'string');
    assert.ok(result.path.length > 0);
    assert.ok(Array.isArray(result.entries));
  });
});
