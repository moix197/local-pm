import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjects } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Parse the output of `git worktree list --porcelain` into worktree entries.
 * Handles normal branches (stripping the `refs/heads/` prefix), detached HEAD
 * (branch `(detached)`), and bare worktrees (branch `(bare)`).
 * @param {string} stdout raw porcelain output
 * @returns {Array<{ path: string, branch: string }>} parsed entries
 */
export function parseWorktreePorcelain(stdout) {
  const entries = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: '(unknown)' };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('detached') && current) {
      current.branch = '(detached)';
    } else if (line.startsWith('bare') && current) {
      current.branch = '(bare)';
    }
  }
  return entries;
}

const DEFAULT_COMMANDS = [
  { label: 'npm install', cmd: 'npm install' },
  { label: 'npm run build', cmd: 'npm run build' },
  { label: 'npm run lint', cmd: 'npm run lint' },
];

/**
 * Merge a project's `commands` onto the defaults (EXTENDS semantics): start from
 * DEFAULT_COMMANDS, append the project's commands, then dedupe by `label` with the
 * project entry winning on collision.
 * @param {Array<{ label: string, cmd: string }>} [projectCommands]
 * @returns {Array<{ label: string, cmd: string }>}
 */
export function mergeCommands(projectCommands = []) {
  const byLabel = new Map();
  for (const c of [...DEFAULT_COMMANDS, ...projectCommands]) byLabel.set(c.label, c);
  return [...byLabel.values()];
}

function toWorktree(project, entry) {
  return {
    project: project.name,
    branch: entry.branch,
    path: entry.path,
    hasNodeModules: fs.existsSync(path.join(entry.path, 'node_modules')),
    commands: mergeCommands(project.commands),
  };
}

/**
 * Synthetic single-row stand-in for a project that has no git worktrees (plain
 * folder, or `git worktree list` failed/empty). Lets the project root itself
 * appear as a startable target instead of rendering zero rows. The branch label
 * falls back to the project's `type` (e.g. 'plain'/'docker') or '(root)'.
 */
function toRootWorktree(project) {
  return toWorktree(project, { path: project.root, branch: project.type || '(root)' });
}

async function getProjectWorktrees(project) {
  if (!project.exists) return [];
  let entries = [];
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: project.root,
    });
    entries = parseWorktreePorcelain(stdout).map((entry) => toWorktree(project, entry));
  } catch {
    entries = [];
  }
  // A project with no git worktrees still gets one synthetic row at its root so
  // it shows up; git projects with real worktrees are returned unchanged.
  return entries.length > 0 ? entries : [toRootWorktree(project)];
}

/**
 * Discover git worktrees across all configured projects.
 * Projects whose root does not exist (or whose `git` call fails) contribute an
 * empty list rather than throwing, so a missing project root degrades gracefully.
 * @param {Array<{ name: string, root: string, exists: boolean }>} [projects]
 *   project list to scan; defaults to the configured projects
 * @returns {Promise<Array<{ project: string, branch: string, path: string, hasNodeModules: boolean, commands: Array<{label:string,cmd:string}> }>>}
 *   flattened list of worktrees across all projects
 */
export async function getWorktrees(projects = loadProjects()) {
  const lists = await Promise.all(projects.map(getProjectWorktrees));
  return lists.flat();
}
