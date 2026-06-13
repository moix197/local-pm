import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const LOG_LIMIT = 300;

let active = null;
let installing = false;
let inProgress = false;
const logs = [];

// ---------------------------------------------------------------------------
// Injectable seams — replaced in unit tests; defaults are production impls.
// ---------------------------------------------------------------------------

let _spawn = spawn;

/** @internal — unit tests only */
export function _setSpawnFn(fn) { _spawn = fn; }

// Production kill: use taskkill /T /F on Windows
async function _defaultKill(pid) {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    /* process may already be gone */
  }
}

let _killFn = _defaultKill;

/** @internal — unit tests only */
export function _setKillFn(fn) { _killFn = fn; }

// Production docker stop
async function _defaultDockerDown(cwd) {
  try {
    await execFileAsync('docker', ['compose', 'down'], { cwd });
  } catch {
    /* worktree may have no compose file */
  }
}

let _dockerDownFn = _defaultDockerDown;

/** @internal — unit tests only */
export function _setDockerDownFn(fn) { _dockerDownFn = fn; }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function appendLog(line) {
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
}

function streamToLog(stream) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.length) appendLog(line);
    }
  });
}

function runNpmInstall(worktreePath) {
  return new Promise((resolve) => {
    appendLog('[local-pm] installing dependencies…');
    const child = _spawn('npm.cmd', ['install'], { cwd: worktreePath, shell: true });
    streamToLog(child.stdout);
    streamToLog(child.stderr);
    child.on('close', () => resolve());
    child.on('error', (err) => {
      appendLog(`[local-pm] npm install error: ${err.message}`);
      resolve();
    });
  });
}

function spawnDevServer(worktreePath, meta) {
  const child = _spawn('npm.cmd', ['run', 'dev'], { cwd: worktreePath, shell: true });
  // child.pid is the shell (cmd.exe) PID on Windows with shell:true — assigned synchronously
  active = {
    project: meta?.project ?? null,
    branch: meta?.branch ?? null,
    path: worktreePath,
    pid: child.pid,
    startedAt: Date.now(),
  };
  appendLog(`[local-pm] dev server started (pid ${child.pid}) at ${worktreePath}`);
  streamToLog(child.stdout);
  streamToLog(child.stderr);
  child.on('close', () => {
    if (active && active.path === worktreePath) {
      appendLog(`[local-pm] dev server exited at ${worktreePath}`);
      active = null;
    }
  });
  child.on('error', (err) => {
    appendLog(`[error] failed to start ${meta?.branch ?? worktreePath}: ${err.message}`);
    // Explicitly reset to idle here so state is correct regardless of when
    // 'error' fires (sync or async) relative to startServer's finally block.
    if (active && active.path === worktreePath) active = null;
    installing = false;
    inProgress = false;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startServer(worktreePath, meta) {
  // Guard: reject concurrent starts (e.g. rapid double-click)
  if (inProgress) return getStatus();
  inProgress = true;
  try {
    if (active) await stopServer();
    if (!fs.existsSync(path.join(worktreePath, 'node_modules'))) {
      installing = true;
      try {
        await runNpmInstall(worktreePath);
      } finally {
        installing = false;
      }
    }
    spawnDevServer(worktreePath, meta);
  } finally {
    inProgress = false;
  }
  return getStatus();
}

export async function stopServer() {
  if (!active) return getStatus();
  const stopped = active;
  active = null;
  installing = false;
  await _killFn(stopped.pid);
  try {
    await _dockerDownFn(stopped.path);
  } catch {
    /* docker down errors are always ignored */
  }
  appendLog(`[stopped] ${stopped.path} (pid ${stopped.pid})`);
  return getStatus();
}

export function getStatus() {
  return { active, installing };
}

export function getLogs() {
  return logs.slice();
}
