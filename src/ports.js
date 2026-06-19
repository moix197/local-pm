import { getAllStatuses } from './runner.js';
import fs from 'node:fs';
import path from 'node:path';

const POOL_START = 3100;
const POOL_END = 3199; // inclusive

// path -> port. Source of truth for local-pm pool allocations. A port is
// reserved here at assign time (before the server appears in runner's active
// Map) and removed on releasePort.
const allocated = new Map();

function inUsePorts() {
  const ports = new Set();
  for (const port of allocated.values()) ports.add(port);
  // Cross-check running servers in case an entry was assigned out-of-band.
  for (const status of getAllStatuses()) {
    if (status.port != null) ports.add(Number(status.port));
  }
  return ports;
}

/**
 * Reserve the first free port in the 3100–3199 pool for `worktreePath`.
 * In-process only — does NOT probe the OS for ports held by unrelated processes
 * (acceptable single-instance assumption for a LAN tool). Re-assigning an
 * already-allocated path returns its existing port.
 * @param {string} worktreePath
 * @returns {number} the assigned port
 * @throws {Error} when every slot in the pool is taken
 */
export function assignPort(worktreePath) {
  const existing = allocated.get(worktreePath);
  if (existing != null) return existing;
  const taken = inUsePorts();
  for (let port = POOL_START; port <= POOL_END; port += 1) {
    if (!taken.has(port)) {
      allocated.set(worktreePath, port);
      return port;
    }
  }
  throw new Error(
    `port pool exhausted: all ${POOL_END - POOL_START + 1} slots (${POOL_START}–${POOL_END}) are in use`,
  );
}

/**
 * Release the port previously assigned to `worktreePath`. No-op if none.
 * Also frees any composite keys of the form `${worktreePath}:*` that docker
 * targets allocate via buildEnvForTarget.
 * @param {string} worktreePath
 */
export function releasePort(worktreePath) {
  allocated.delete(worktreePath);
  const prefix = worktreePath + ':';
  for (const key of allocated.keys()) {
    if (key.startsWith(prefix)) allocated.delete(key);
  }
}

/**
 * Resolve the git "common dir" for a worktree path.
 * - If <path>/.git is a directory → that IS the common dir.
 * - If <path>/.git is a FILE → parse `gitdir: <X>`, then read <X>/commondir
 *   (relative path from X to common dir) and resolve to absolute.
 * Returns null when the common dir cannot be determined.
 * @param {string} worktreePath
 * @returns {string | null}
 */
export function resolveGitCommonDir(worktreePath) {
  const gitPath = path.join(worktreePath, '.git');
  let stat;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return gitPath;
  }
  // .git is a file — parse "gitdir: <absolute-path>"
  let content;
  try {
    content = fs.readFileSync(gitPath, 'utf8').trim();
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) return null;
  const gitdirPath = match[1].trim();
  const absGitdir = path.isAbsolute(gitdirPath)
    ? gitdirPath
    : path.resolve(worktreePath, gitdirPath);
  // Read commondir file inside the gitdir
  const commondirFile = path.join(absGitdir, 'commondir');
  let commondirContent;
  try {
    commondirContent = fs.readFileSync(commondirFile, 'utf8').trim();
  } catch {
    return null;
  }
  // commondirContent is a relative path from absGitdir to the common dir
  return path.resolve(absGitdir, commondirContent);
}

const GIT_WT_DEFAULTS = { basePort: 3000, increment: 100, envVars: ['PORT', 'WS_PORT'] };

/**
 * Load git-wt config from <commonDir-parent>/.git-wt.json, merged with defaults.
 * Returns the merged config.
 * @param {string} worktreePath
 * @returns {{ basePort: number, increment: number, envVars: string[] }}
 */
function readGitWtConfig(worktreePath) {
  const commonDir = resolveGitCommonDir(worktreePath);
  if (!commonDir) return { ...GIT_WT_DEFAULTS };
  // .git-wt.json lives in the project root (parent of common dir)
  const projectRoot = path.dirname(commonDir);
  const configPath = path.join(projectRoot, '.git-wt.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { ...GIT_WT_DEFAULTS };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...GIT_WT_DEFAULTS };
  }
  return {
    basePort: parsed.basePort ?? GIT_WT_DEFAULTS.basePort,
    increment: parsed.increment ?? GIT_WT_DEFAULTS.increment,
    envVars: Array.isArray(parsed.envVars) ? parsed.envVars : GIT_WT_DEFAULTS.envVars,
  };
}

/**
 * Read the git-wt offset for a branch from the git common dir's git-wt-ports.json.
 * Returns { offset } where offset may be 0 (valid), or null when:
 * - common dir cannot be resolved
 * - file is absent
 * - JSON is malformed
 * - branch is not in allocations
 * @param {string} worktreePath
 * @param {string} branch
 * @returns {{ offset: number } | null}
 */
export function readGitWtOffset(worktreePath, branch) {
  const commonDir = resolveGitCommonDir(worktreePath);
  if (!commonDir) return null;
  const filePath = path.join(commonDir, 'git-wt-ports.json');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[local-pm] git-wt-ports.json at ${filePath} is malformed JSON — ignoring`);
    return null;
  }
  const alloc = parsed?.allocations?.[branch];
  if (alloc == null) return null;
  // offset 0 is valid (e.g. main/develop branch)
  if (typeof alloc.offset !== 'number') return null;
  return { offset: alloc.offset };
}

/**
 * Scan compose files in projectRoot for port variable placeholders.
 * Returns [{varName, base}] where base is the container-side port number (right of colon),
 * or null if no colon or the right side is not a plain number.
 * Uses no yaml parser — string/regex only.
 * @param {string} projectRoot
 * @returns {Array<{varName: string, base: number|null}>}
 */
export function scanComposePortVars(projectRoot) {
  const composeNames = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
  ];

  const results = [];

  for (const name of composeNames) {
    const filePath = path.join(projectRoot, name);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Track whether we're inside a ports: section.
    let inPorts = false;
    for (const line of lines) {
      const trimmed = line.trim();

      // Detect entering a ports: block.
      if (/^ports\s*:/.test(trimmed)) {
        inPorts = true;
        continue;
      }

      // Leaving ports block when we hit a new top-level key (non-indented non-list line).
      if (inPorts && trimmed && !trimmed.startsWith('-') && /^\w/.test(trimmed)) {
        inPorts = false;
      }

      if (!inPorts) continue;
      if (!trimmed.startsWith('-')) continue;

      // Line has a port entry — look for ${VARNAME} pattern.
      const varMatch = trimmed.match(/\$\{([^}]+)\}/);
      if (!varMatch) continue;

      const varName = varMatch[1];

      // Extract the port mapping. Format: "${VARNAME}:NUMBER" or "${VARNAME}:${OTHER}"
      // Strip surrounding quotes and dashes to get the raw mapping string.
      const mappingMatch = trimmed.match(/-\s*["']?(.+?)["']?\s*$/);
      let base = null;
      if (mappingMatch) {
        const mapping = mappingMatch[1].replace(/^["']|["']$/g, '');
        // Find the colon that separates host:container (not inside ${}).
        const colonIdx = mapping.indexOf(':');
        if (colonIdx !== -1) {
          const rightSide = mapping.slice(colonIdx + 1);
          // Only use as base if it's a plain number (not another variable).
          if (/^\d+$/.test(rightSide.trim())) {
            base = Number(rightSide.trim());
          }
        }
      }

      // Avoid duplicate entries for the same varName.
      if (!results.some((r) => r.varName === varName)) {
        results.push({ varName, base });
      }
    }
  }

  return results;
}

/**
 * Slugify a string for use as a docker compose project name.
 * Replaces non-alphanumeric chars with hyphens, collapses multiples, trims.
 * @param {string} str
 * @returns {string}
 */
function slugify(str) {
  return str
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Returns true if any compose file exists in dirPath.
 * @param {string} dirPath
 * @returns {boolean}
 */
function hasComposeFile(dirPath) {
  return ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(
    (name) => fs.existsSync(path.join(dirPath, name)),
  );
}

/**
 * Build the environment variables to inject when starting a server for a worktree.
 * Dispatches on worktree.type:
 *   - 'git-wt': reads git-wt-ports.json offset, uses git-wt envVars config (PORT, WS_PORT)
 *               with formula basePort + offset * increment; falls back to assignPort
 *   - 'docker': assigns pool ports per compose var; sets COMPOSE_PROJECT_NAME
 *   - everything else (plain): assigns a single PORT from the pool
 * @param {{ project: string, branch: string, path: string, type?: string }} worktree
 * @returns {Record<string, string>}
 */
export function buildEnvForTarget(worktree) {
  const { project, branch, path: wtPath, type } = worktree;

  if (type === 'git-wt') {
    const offsetResult = readGitWtOffset(wtPath, branch);
    if (offsetResult !== null) {
      const { offset } = offsetResult;
      const config = readGitWtConfig(wtPath);
      const port = config.basePort + offset * config.increment;
      const env = {};
      for (const varName of config.envVars) {
        env[varName] = String(port);
      }
      // Only set COMPOSE_PROJECT_NAME when compose files are present.
      if (hasComposeFile(wtPath)) {
        env.COMPOSE_PROJECT_NAME = slugify(`${project}-${branch}`);
      }
      return env;
    }
    // Fall through to plain assignPort if offset not found.
    const port = assignPort(wtPath);
    return { PORT: String(port) };
  }

  if (type === 'docker') {
    const vars = scanComposePortVars(wtPath);
    const env = {};
    for (const { varName, base } of vars) {
      const key = `${wtPath}:${varName}`;
      const port = assignPort(key);
      env[varName] = String(port);
    }
    env.COMPOSE_PROJECT_NAME = slugify(`${project}-${branch}`);
    return env;
  }

  // Plain: single PORT from the pool.
  const port = assignPort(wtPath);
  return { PORT: String(port) };
}
