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
