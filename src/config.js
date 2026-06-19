import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsFile = path.join(repoRoot, 'projects.json');

const defaultProjects = [{ name: 'my-project', root: 'C:/path/to/your/project' }];

function ensureProjectsFile() {
  if (!fs.existsSync(projectsFile)) {
    fs.writeFileSync(projectsFile, JSON.stringify(defaultProjects, null, 2) + '\n', 'utf8');
  }
}

function readProjectsFile() {
  const raw = fs.readFileSync(projectsFile, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`projects.json is not valid JSON: ${err.message}`);
  }
}

/**
 * Atomically persist the projects array: write to `projects.json.tmp` then
 * `fs.renameSync` over `projects.json`. A crash between write and rename leaves
 * the `.tmp` file (recoverable) — `projects.json` is never half-written.
 * @param {Array<object>} projects
 */
function writeProjectsFile(projects) {
  const tmpFile = projectsFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(projects, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, projectsFile);
}

/**
 * Normalize an optional per-project `commands` value into `{label,cmd}` objects.
 * Accepts strings (→ `{label:s, cmd:s}`) or `{label,cmd}` objects; absent ⇒ `[]`.
 * @param {unknown} raw
 * @returns {Array<{ label: string, cmd: string }>}
 * @throws {Error} if present but not an array of the accepted shapes
 */
export function normalizeCommands(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('projects.json: "commands" must be an array of strings or {label,cmd} objects');
  }
  return raw.map((entry) => {
    if (typeof entry === 'string') return { label: entry, cmd: entry };
    if (entry && typeof entry.label === 'string' && typeof entry.cmd === 'string') {
      return { label: entry.label, cmd: entry.cmd };
    }
    throw new Error('projects.json: each command must be a string or a {label,cmd} object');
  });
}

function withRootExists(project) {
  return {
    ...project,
    exists: fs.existsSync(project.root),
    commands: normalizeCommands(project.commands),
  };
}

/**
 * Load the configured projects, creating a placeholder `projects.json` on first run.
 * Each returned project is augmented with an `exists` flag indicating whether its
 * `root` path is present on disk.
 * @returns {Array<{ name: string, root: string, exists: boolean, commands: Array<{label:string,cmd:string}> }>} configured projects
 * @throws {Error} if `projects.json` contains invalid JSON
 */
export function loadProjects() {
  ensureProjectsFile();
  return readProjectsFile().map(withRootExists);
}

/**
 * Append a project entry to projects.json (atomic write). Replaces any existing
 * entry with the same `root` so re-adding a folder updates it in place.
 * @param {{ name: string, root: string, [k:string]: unknown }} entry
 * @returns {object} the stored entry
 */
export function addProject(entry) {
  ensureProjectsFile();
  const projects = readProjectsFile().filter((p) => p.root !== entry.root);
  projects.push(entry);
  writeProjectsFile(projects);
  return entry;
}

/**
 * Remove the project whose `root` matches (atomic write).
 * @param {string} root
 * @returns {boolean} true if an entry was removed
 */
export function removeProject(root) {
  ensureProjectsFile();
  const projects = readProjectsFile();
  const next = projects.filter((p) => p.root !== root);
  if (next.length === projects.length) return false;
  writeProjectsFile(next);
  return true;
}

// Only these fields may be changed via PATCH. `root` is the key and is immutable;
// `type` is auto-detected, never user-editable. A patch with any other key has
// that key silently ignored so a caller can't overwrite identity/detection fields.
const EDITABLE_FIELDS = ['name', 'devCmd', 'portVars', 'commands'];

/**
 * Shallow-merge the whitelisted fields of `patch` onto the project whose `root`
 * matches (atomic write). Non-whitelisted keys (incl. `root`/`type`) are ignored.
 * @param {string} root
 * @param {object} patch
 * @returns {object|null} the updated entry, or null if no match
 */
export function updateProject(root, patch) {
  ensureProjectsFile();
  const projects = readProjectsFile();
  const idx = projects.findIndex((p) => p.root === root);
  if (idx === -1) return null;
  const allowed = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in patch) allowed[key] = patch[key];
  }
  projects[idx] = { ...projects[idx], ...allowed };
  writeProjectsFile(projects);
  return projects[idx];
}
