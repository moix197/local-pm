import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsFile = path.join(repoRoot, 'projects.json');

const defaultProjects = [{ name: 'web_template', root: 'C:/proyectos/web_template' }];

function ensureProjectsFile() {
  if (!fs.existsSync(projectsFile)) {
    fs.writeFileSync(projectsFile, JSON.stringify(defaultProjects, null, 2) + '\n', 'utf8');
  }
}

function readProjectsFile() {
  return JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
}

function withRootExists(project) {
  return { ...project, exists: fs.existsSync(project.root) };
}

export function loadProjects() {
  ensureProjectsFile();
  return readProjectsFile().map(withRootExists);
}
