import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjects } from './config.js';

const execFileAsync = promisify(execFile);

function parseWorktreePorcelain(stdout) {
  const entries = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: null };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('detached') && current) {
      current.branch = '(detached)';
    }
  }
  return entries;
}

function toWorktree(project, entry) {
  return {
    project: project.name,
    branch: entry.branch ?? '(unknown)',
    path: entry.path,
    hasNodeModules: fs.existsSync(path.join(entry.path, 'node_modules')),
  };
}

async function getProjectWorktrees(project) {
  if (!project.exists) return [];
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: project.root,
    });
    return parseWorktreePorcelain(stdout).map((entry) => toWorktree(project, entry));
  } catch {
    return [];
  }
}

export async function getWorktrees() {
  const projects = loadProjects();
  const lists = await Promise.all(projects.map(getProjectWorktrees));
  return lists.flat();
}
