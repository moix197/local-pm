import fs from 'node:fs';
import path from 'node:path';
import { scanComposePortVars } from './ports.js';

const COMPOSE_NAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

/**
 * SECURITY GATE — assert `folderPath` is a real existing directory.
 * Must run before anything else: prevents path-traversal saves to projects.json
 * and the later spawn of a nonexistent path. Throws on failure or non-directory.
 * @param {string} folderPath
 * @throws {Error} 'not a directory' when the path is absent or not a directory
 */
function assertIsDirectory(folderPath) {
  let stat;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    throw new Error('not a directory');
  }
  if (!stat.isDirectory()) throw new Error('not a directory');
}

function isGitWt(folderPath) {
  return (
    fs.existsSync(path.join(folderPath, '.git-wt.json')) ||
    fs.existsSync(path.join(folderPath, '.git', 'git-wt-ports.json'))
  );
}

function hasComposeFile(folderPath) {
  return COMPOSE_NAMES.some((name) => fs.existsSync(path.join(folderPath, name)));
}

/**
 * Read the dev command from the project's own package.json scripts.
 * SECURITY: the command MUST originate from `scripts.dev` or `scripts.start`
 * only — never from raw user input. Returns null when no package.json, no
 * scripts, or neither script present.
 * @param {string} folderPath
 * @returns {string|null}
 */
function readDevCmd(folderPath) {
  const pkgPath = path.join(folderPath, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const scripts = parsed?.scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  if (typeof scripts.dev === 'string') return `npm run dev`;
  if (typeof scripts.start === 'string') return `npm run start`;
  return null;
}

/**
 * Auto-detect a project's type and run configuration from its folder.
 * Validates the directory first (security gate), then classifies as git-wt,
 * docker, or plain and sources the dev command from package.json scripts only.
 * @param {string} folderPath
 * @returns {{ type: 'git-wt'|'docker'|'plain', devCmd: string|null, portVars: Array<{varName:string,base:number|null}>, needsSetup: boolean }}
 * @throws {Error} 'not a directory' when folderPath is absent or not a directory
 */
export function autoDetectProject(folderPath) {
  assertIsDirectory(folderPath);

  const devCmd = readDevCmd(folderPath);

  let type;
  let portVars = [];
  if (isGitWt(folderPath)) {
    type = 'git-wt';
    portVars = scanComposePortVars(folderPath);
  } else if (hasComposeFile(folderPath)) {
    type = 'docker';
    portVars = scanComposePortVars(folderPath);
  } else {
    type = 'plain';
  }

  // Ambiguous when a Docker project exposes port vars but we could not resolve
  // a base for one of them (right side of the colon was not a number).
  // git-wt derives its ports from git-wt (offset + worktree .env), NOT from
  // compose port vars — so compose-var ambiguity is irrelevant there.
  const portVarsAmbiguous = portVars.some((v) => v.base == null);
  const needsSetup =
    type === 'docker' ? devCmd == null || portVarsAmbiguous : devCmd == null;

  return { type, devCmd, portVars, needsSetup };
}
