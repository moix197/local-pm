import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Markers that make a folder "look like" a project — mirrors detect.js
// classification (package.json → plain; .git-wt.json → git-wt; compose → docker).
const COMPOSE_NAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

const PROJECT_MARKERS = ['package.json', '.git-wt.json', ...COMPOSE_NAMES];

/**
 * Quick heuristic: does `dirPath` contain a project marker (package.json,
 * .git-wt.json, or a docker-compose/compose file)? Used only to visually flag
 * project-looking folders in the browser — never reads file contents.
 * @param {string} dirPath
 * @returns {boolean}
 */
function isProject(dirPath) {
  return PROJECT_MARKERS.some((name) => fs.existsSync(path.join(dirPath, name)));
}

/**
 * SECURITY GATE — assert `dirPath` is a real existing directory (mirrors
 * detect.js). Throws a descriptive error otherwise.
 * @param {string} dirPath
 * @throws {Error} 'not a directory: <path>'
 */
function assertIsDirectory(dirPath) {
  let stat;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    throw new Error(`not a directory: ${dirPath}`);
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${dirPath}`);
}

/**
 * Enumerate existing Windows drive letters (A:..Z:) so the UI can switch drives.
 * Returns [] on non-Windows platforms.
 * @returns {string[]} e.g. ['C:/', 'D:/']
 */
function listDrives() {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:/`;
    if (fs.existsSync(root)) drives.push(root);
  }
  return drives;
}

/**
 * Pick a sensible default directory when the caller supplies none: prefer
 * C:/proyectos when present, otherwise the user's home directory.
 * @returns {string}
 */
function defaultDir() {
  return fs.existsSync('C:/proyectos') ? 'C:/proyectos' : os.homedir();
}

/**
 * Return the parent directory path, or null when `dirPath` is a drive/fs root.
 * @param {string} dirPath
 * @returns {string|null}
 */
function parentDir(dirPath) {
  const parent = path.dirname(dirPath);
  return parent === dirPath ? null : parent;
}

/**
 * List ONLY the immediate subdirectories of `dirPath` (files excluded), each
 * flagged with `isProject`. Entries that throw on stat (e.g. permission denied)
 * are skipped rather than failing the whole listing. Sorted project-looking
 * folders first, then alphabetically.
 * @param {string} dirPath
 * @returns {Array<{ name: string, isProject: boolean }>}
 */
function listSubdirectories(dirPath) {
  const names = fs.readdirSync(dirPath);
  const entries = [];
  for (const name of names) {
    const full = path.join(dirPath, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    entries.push({ name, isProject: isProject(full) });
  }
  entries.sort((a, b) => {
    if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/**
 * List a host directory for the folder browser.
 * @param {string} [dirPath] directory to list; defaults to a sensible root
 * @returns {{ path: string, parent: string|null, drives: string[], entries: Array<{name:string,isProject:boolean}> }}
 * @throws {Error} 'not a directory: <path>' when the path is absent/not a dir
 */
export function listDirectory(dirPath) {
  const target = dirPath && dirPath.trim() ? dirPath : defaultDir();
  assertIsDirectory(target);
  return {
    path: target,
    parent: parentDir(target),
    drives: listDrives(),
    entries: listSubdirectories(target),
  };
}
