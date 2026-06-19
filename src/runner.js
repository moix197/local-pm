import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { releasePort, buildEnvForTarget } from './ports.js';

const execFileAsync = promisify(execFile);

const LOG_LIMIT = 300;

// Per-target server state, keyed by worktree path.
const active = new Map(); // path -> ServerEntry
const inProgress = new Map(); // path -> bool (start/stop in flight for that path)
const logs = new Map(); // path -> string[]

// Per-target ad-hoc command state, keyed by worktree path — mirrors the
// active/inProgress/logs Maps so a command in one path never blocks another.
const commands = new Map(); // path -> CommandEntry
const commandInProgress = new Map(); // path -> bool (command spawn in flight for that path)

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

// Production docker stop — accepts optional projectName for scoped compose down.
async function _defaultDockerDown(cwd, projectName) {
  try {
    const args = projectName
      ? ['compose', '--project-name', projectName, 'down']
      : ['compose', 'down'];
    await execFileAsync('docker', args, { cwd });
  } catch {
    /* worktree may have no compose file */
  }
}

let _dockerDownFn = _defaultDockerDown;

/** @internal — unit tests only */
export function _setDockerDownFn(fn) { _dockerDownFn = fn; }

// Production docker-running check
async function _defaultDockerRunning() {
  try { await execFileAsync('docker', ['info']); return true; }
  catch { return false; }
}

let _dockerRunningFn = _defaultDockerRunning;

/** @internal — unit tests only */
export function _setDockerRunningFn(fn) { _dockerRunningFn = fn; }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function worktreeUsesDocker(worktreePath) {
  const composeFiles = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
  ];
  return composeFiles.some((f) => fs.existsSync(path.join(worktreePath, f)));
}

function appendLog(worktreePath, line) {
  let buffer = logs.get(worktreePath);
  if (!buffer) {
    buffer = [];
    logs.set(worktreePath, buffer);
  }
  buffer.push(line);
  if (buffer.length > LOG_LIMIT) buffer.splice(0, buffer.length - LOG_LIMIT);
}

function streamToLog(worktreePath, stream) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.length) appendLog(worktreePath, line);
    }
  });
}

function runNpmInstall(worktreePath, env) {
  return new Promise((resolve) => {
    appendLog(worktreePath, '[local-pm] installing dependencies…');
    const child = _spawn('npm.cmd', ['install'], {
      cwd: worktreePath,
      shell: true,
      env: { ...process.env, ...env },
    });
    streamToLog(worktreePath, child.stdout);
    streamToLog(worktreePath, child.stderr);
    child.on('close', () => resolve());
    child.on('error', (err) => {
      appendLog(worktreePath, `[local-pm] npm install error: ${err.message}`);
      resolve();
    });
  });
}

// devCmd originates from detect.js's package.json scan or the setup form, never
// raw user input. Falls back to `npm run dev` when no command was stored.
function spawnDevServer(worktreePath, meta, env) {
  const devCmd = meta?.devCmd || 'npm run dev';
  // shell:true lets the stored command string run through the shell, matching the
  // existing npm.cmd invocation (npm.cmd on Windows preserves cross-platform behavior).
  const cmd = process.platform === 'win32' ? devCmd.replace(/^npm /, 'npm.cmd ') : devCmd;
  // Pass the full command as a single string with empty args + shell:true, mirroring
  // the (_cmd, _args, opts) shape of the npm.cmd install spawn so the shell parses it.
  const child = _spawn(cmd, [], {
    cwd: worktreePath,
    shell: true,
    env: { ...process.env, ...env },
  });
  // child.pid is the shell (cmd.exe) PID on Windows with shell:true — assigned synchronously
  active.set(worktreePath, {
    project: meta?.project ?? null,
    branch: meta?.branch ?? null,
    path: worktreePath,
    pid: child.pid,
    port: env?.PORT ?? env?.APP_PORT ?? null,
    env,
    startedAt: Date.now(),
  });
  appendLog(worktreePath, `[local-pm] dev server started (pid ${child.pid}) at ${worktreePath}`);
  streamToLog(worktreePath, child.stdout);
  streamToLog(worktreePath, child.stderr);
  child.on('close', () => {
    const entry = active.get(worktreePath);
    if (entry && entry.pid === child.pid) {
      appendLog(worktreePath, `[local-pm] dev server exited at ${worktreePath}`);
      active.delete(worktreePath);
      releasePort(worktreePath);
    }
  });
  child.on('error', (err) => {
    appendLog(worktreePath, `[error] failed to start ${meta?.branch ?? worktreePath}: ${err.message}`);
    // Explicitly reset to idle here so state is correct regardless of when
    // 'error' fires (sync or async) relative to startServer's finally block.
    const entry = active.get(worktreePath);
    if (entry && entry.pid === child.pid) {
      active.delete(worktreePath);
      releasePort(worktreePath);
    }
    inProgress.set(worktreePath, false);
  });
}

function spawnCommand(worktreePath, label, cmd) {
  appendLog(worktreePath, '[cmd] ' + label);
  const child = _spawn(cmd, { cwd: worktreePath, shell: true });
  commands.set(worktreePath, {
    cwd: worktreePath,
    label,
    pid: child.pid,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
  });
  streamToLog(worktreePath, child.stdout);
  streamToLog(worktreePath, child.stderr);
  child.on('close', (code) => finalizeCommand(worktreePath, code));
  child.on('error', (err) => failCommand(worktreePath, err));
}

function finalizeCommand(worktreePath, code) {
  const command = commands.get(worktreePath);
  // A stopped command is authoritative: a late close event (e.g. taskkill on
  // Windows can report exit 0) must not flip status back to 'done'.
  if (command?.stopped) return;
  appendLog(worktreePath, `[cmd] exited ${code}`);
  if (command) {
    command.exitCode = code;
    command.status = code === 0 ? 'done' : 'failed';
  }
  commandInProgress.set(worktreePath, false);
}

function failCommand(worktreePath, err) {
  const command = commands.get(worktreePath);
  if (command?.stopped) return;
  appendLog(worktreePath, `[cmd] error: ${err.message}`);
  if (command) {
    command.status = 'failed';
  }
  commandInProgress.set(worktreePath, false);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startServer(worktreePath, meta) {
  // Per-target guard: reject concurrent starts on the same path (rapid double-click).
  if (inProgress.get(worktreePath)) return getStatus(worktreePath);
  inProgress.set(worktreePath, true);
  try {
    if (worktreeUsesDocker(worktreePath) && !(await _dockerRunningFn())) {
      appendLog(worktreePath, '[local-pm] Docker is not running — start Docker Desktop first, then try again.');
      return getStatus(worktreePath);
    }
    if (active.has(worktreePath)) await stopServer(worktreePath);
    const safeMeta = { project: null, branch: null, type: 'plain', ...(meta ?? {}), path: worktreePath };
    const derivedEnv = buildEnvForTarget(safeMeta);
    if (!fs.existsSync(path.join(worktreePath, 'node_modules'))) {
      await runNpmInstall(worktreePath, derivedEnv);
    }
    spawnDevServer(worktreePath, meta, derivedEnv);
  } finally {
    inProgress.set(worktreePath, false);
  }
  return getStatus(worktreePath);
}

export async function stopServer(worktreePath) {
  const entry = active.get(worktreePath);
  if (!entry) return getStatus(worktreePath);
  active.delete(worktreePath);
  await _killFn(entry.pid);
  try {
    const projectName = entry.env?.COMPOSE_PROJECT_NAME ?? null;
    await _dockerDownFn(entry.path, projectName);
  } catch {
    /* docker down errors are always ignored */
  }
  releasePort(worktreePath);
  appendLog(worktreePath, `[stopped] ${entry.path} (pid ${entry.pid})`);
  return getStatus(worktreePath);
}

export async function stopAll() {
  await Promise.all([...active.keys()].map((p) => stopServer(p)));
}

export async function runCommand(worktreePath, { cmd, label }) {
  // Per-path guards only: a command in another path must not block this one.
  if (commandInProgress.get(worktreePath)) return getStatus(worktreePath);
  const existing = commands.get(worktreePath);
  if (existing && existing.status === 'running') {
    appendLog(worktreePath, '[cmd] a command is already running');
    return getStatus(worktreePath);
  }
  commandInProgress.set(worktreePath, true);
  spawnCommand(worktreePath, label, cmd);
  return getStatus(worktreePath);
}

export function stopCommand(worktreePath) {
  const command = commands.get(worktreePath);
  if (!command || command.status !== 'running') return getStatus(worktreePath);
  // Mark stopped BEFORE killing so the child's late close/error handler no-ops
  // instead of flipping status back to 'done' (taskkill can report exit 0).
  command.stopped = true;
  command.status = 'failed';
  _killFn(command.pid);
  appendLog(command.cwd, `[cmd] stopped (pid ${command.pid})`);
  commandInProgress.set(worktreePath, false);
  return getStatus(worktreePath);
}

function isInstalling(worktreePath) {
  return inProgress.get(worktreePath) === true && !active.has(worktreePath);
}

/**
 * Status for a single target path: its server entry (or null), installing flag,
 * and that path's own command entry (or null).
 */
export function getStatus(worktreePath) {
  return {
    active: active.get(worktreePath) ?? null,
    installing: isInstalling(worktreePath),
    command: commands.get(worktreePath) ?? null,
  };
}

/** One status object per currently-running server. */
export function getAllStatuses() {
  return [...active.values()].map((entry) => ({ ...entry }));
}

/** Log lines for a single target path (copy — caller mutation is safe). */
export function getLogs(worktreePath) {
  return (logs.get(worktreePath) ?? []).slice();
}
