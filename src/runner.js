import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const LOG_LIMIT = 300;

let active = null;
let installing = false;
const logs = [];

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
    const child = spawn('npm.cmd', ['install'], { cwd: worktreePath, shell: true });
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
  const child = spawn('npm.cmd', ['run', 'dev'], { cwd: worktreePath, shell: true });
  streamToLog(child.stdout);
  streamToLog(child.stderr);
  active = {
    project: meta?.project ?? null,
    branch: meta?.branch ?? null,
    path: worktreePath,
    pid: child.pid,
    startedAt: Date.now(),
  };
  appendLog(`[local-pm] dev server started (pid ${child.pid}) at ${worktreePath}`);
}

export async function startServer(worktreePath, meta) {
  if (active) await stopServer();
  if (!fs.existsSync(path.join(worktreePath, 'node_modules'))) {
    installing = true;
    await runNpmInstall(worktreePath);
    installing = false;
  }
  spawnDevServer(worktreePath, meta);
  return getStatus();
}

async function killProcessTree(pid) {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    /* process may already be gone */
  }
}

async function dockerComposeDown(cwd) {
  try {
    await execFileAsync('docker', ['compose', 'down'], { cwd });
  } catch {
    /* worktree may have no compose file */
  }
}

export async function stopServer() {
  if (!active) return getStatus();
  const stopped = active;
  await killProcessTree(stopped.pid);
  await dockerComposeDown(stopped.path);
  active = null;
  installing = false;
  appendLog(`[stopped] ${stopped.path} (pid ${stopped.pid})`);
  return getStatus();
}

export function getStatus() {
  return { active, installing };
}

export function getLogs() {
  return logs.slice();
}
