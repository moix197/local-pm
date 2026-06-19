import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as nodePty from 'node-pty';
import { getWorktrees } from './worktrees.js';

export const MAX_SESSIONS = 10;

function detectShell() {
  if (process.env.LOCAL_PM_SHELL) return process.env.LOCAL_PM_SHELL;
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-Command', 'exit'], { stdio: 'ignore', timeout: 3000 });
    return 'pwsh.exe';
  } catch {}
  return 'cmd.exe';
}

const SHELL = detectShell();

const COMMANDS = SHELL === 'cmd.exe'
  ? { shell: { args: [] }, claude: { args: ['/c', 'claude'] } }
  : { shell: { args: [] }, claude: { args: ['-c', 'claude'] } };

// Injectable seam for tests
let _spawnFn = (shell, args, opts) => nodePty.spawn(shell, args, opts);
export function _setSpawnFn(fn) { _spawnFn = fn; }

// Injectable seam for getWorktrees in tests
let _getWorktrees = getWorktrees;
export function _setGetWorktreesFn(fn) { _getWorktrees = fn; }

/** @type {Map<string, {id:string, ptyProcess:object, worktreePath:string, kind:string}>} */
const sessions = new Map();

function clampDim(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

/**
 * Spawn a new PTY session.
 * @param {{worktreePath:string, kind:string, cols:number, rows:number}} opts
 * @returns {Promise<{id:string, ptyProcess:object, worktreePath:string, kind:string}>}
 */
export async function spawnSession({ worktreePath, kind, cols, rows }) {
  // Invariant 2: kind must be known
  if (!(kind in COMMANDS)) {
    const err = new Error(`invalid kind: ${kind}`);
    err.code = 4403;
    throw err;
  }

  // Invariant 1: worktreePath must match a registered worktree
  const worktrees = await _getWorktrees();
  const entry = worktrees.find((w) => w.path === worktreePath);
  if (!entry) {
    const err = new Error(`unknown worktree path: ${worktreePath}`);
    err.code = 4403;
    throw err;
  }

  // Invariant 3: session cap
  if (sessions.size >= MAX_SESSIONS) {
    const err = new Error('session cap reached');
    err.code = 4429;
    throw err;
  }

  // Invariant 4: cols/rows — clamp to [1, 500]
  const safeCols = clampDim(cols);
  const safeRows = clampDim(rows);

  const cmdDef = COMMANDS[kind];
  // Use the validated path from the registry, never the raw client-supplied path
  const cwd = entry.path;

  const ptyProcess = _spawnFn(SHELL, cmdDef.args, {
    name: 'xterm-color',
    cols: safeCols,
    rows: safeRows,
    cwd,
    env: process.env,
  });

  const id = crypto.randomUUID();
  const session = { id, ptyProcess, worktreePath: cwd, kind };
  sessions.set(id, session);
  return session;
}

export function writeToSession(id, data) {
  const session = sessions.get(id);
  if (!session) return;
  session.ptyProcess.write(data);
}

export function resizeSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return;
  session.ptyProcess.resize(clampDim(cols), clampDim(rows));
}

export function killSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try { session.ptyProcess.kill(); } catch {}
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

export function getAllSessions() {
  return [...sessions.values()];
}
