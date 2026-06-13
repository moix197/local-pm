import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjects } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Parse the output of `git worktree list --porcelain` into worktree entries.
 * Handles normal branches (stripping the `refs/heads/` prefix), detached HEAD
 * (branch `(detached)`), and bare worktrees with no branch line (branch `null`).
 * @param {string} stdout raw porcelain output
 * @returns {Array<{ path: string, branch: string | null }>} parsed entries
 */
export function parseWorktreePorcelain(stdout) {
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

/**
 * Discover git worktrees across all configured projects.
 * Projects whose root does not exist (or whose `git` call fails) contribute an
 * empty list rather than throwing, so a missing project root degrades gracefully.
 * @returns {Promise<Array<{ project: string, branch: string, path: string, hasNodeModules: boolean }>>}
 *   flattened list of worktrees across all projects
 */
export async function getWorktrees() {
  const projects = loadProjects();
  const lists = await Promise.all(projects.map(getProjectWorktrees));
  return lists.flat();
}
