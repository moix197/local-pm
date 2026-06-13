import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects } from '../config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const projectsFile = path.join(repoRoot, 'projects.json');

/**
 * Snapshot the real projects.json (if present), run `fn`, then restore it.
 * loadProjects targets a fixed repo-root path, so tests must not leave it mutated.
 */
function withProjectsFile(fn) {
  const existed = fs.existsSync(projectsFile);
  const backup = existed ? fs.readFileSync(projectsFile, 'utf8') : null;
  try {
    fn();
  } finally {
    if (backup === null) {
      if (fs.existsSync(projectsFile)) fs.rmSync(projectsFile);
    } else {
      fs.writeFileSync(projectsFile, backup, 'utf8');
    }
  }
}

test('loadProjects: creates a default file when missing', () => {
  withProjectsFile(() => {
    if (fs.existsSync(projectsFile)) fs.rmSync(projectsFile);
    const projects = loadProjects();
    assert.ok(fs.existsSync(projectsFile), 'projects.json should be created');
    assert.ok(Array.isArray(projects));
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'my-project');
    assert.equal(typeof projects[0].exists, 'boolean');
  });
});

test('loadProjects: reads an existing file and adds exists flag', () => {
  withProjectsFile(() => {
    fs.writeFileSync(
      projectsFile,
      JSON.stringify([{ name: 'alpha', root: repoRoot }]) + '\n',
      'utf8',
    );
    const projects = loadProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'alpha');
    assert.equal(projects[0].root, repoRoot);
    assert.equal(projects[0].exists, true);
  });
});

test('loadProjects: throws a descriptive error on malformed JSON', () => {
  withProjectsFile(() => {
    fs.writeFileSync(projectsFile, '{ not valid json', 'utf8');
    assert.throws(loadProjects, /^Error: projects\.json is not valid JSON: /);
  });
});
