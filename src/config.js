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

function withRootExists(project) {
  return { ...project, exists: fs.existsSync(project.root) };
}

/**
 * Load the configured projects, creating a placeholder `projects.json` on first run.
 * Each returned project is augmented with an `exists` flag indicating whether its
 * `root` path is present on disk.
 * @returns {Array<{ name: string, root: string, exists: boolean }>} configured projects
 * @throws {Error} if `projects.json` contains invalid JSON
 */
export function loadProjects() {
  ensureProjectsFile();
  return readProjectsFile().map(withRootExists);
}
