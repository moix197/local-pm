import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as nodePty from 'node-pty';
import { getWorktrees } from './worktrees.js';

export const MAX_SESSIONS = 10;

const SCROLLBACK_MAX_CHUNKS = 5000;
const SCROLLBACK_MAX_BYTES = 512000;
const IDLE_TIMEOUT_MS = (Number(process.env.LOCAL_PM_IDLE_TIMEOUT_MINUTES) || 30) * 60 * 1000;
const HIGH_WATER = 1 << 20; // 1 MB

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

// Injectable timer seam
let _timerFn = setInterval;
export function _setTimerFn(fn) { _timerFn = fn; }

// Injectable seam for grace-period timeout (tests drive via fake)
let _timeoutFn = setTimeout;
export function _setTimeoutFn(fn) { _timeoutFn = fn; }

// Injectable seam for cancelling grace timers (tests assert cancellation)
let _clearTimeoutFn = clearTimeout;
export function _setClearTimeoutFn(fn) { _clearTimeoutFn = fn; }

// Tracks sessions with a pending grace-kill timer so shutdown() can cancel them
const _pendingGrace = new Set();
export function _clearPendingGrace() {
  for (const session of _pendingGrace) {
    _clearTimeoutFn(session._graceTimer);
  }
  _pendingGrace.clear();
}

/** @type {Map<string, {id:string, ptyProcess:object, worktreePath:string, kind:string, scrollback:string[], scrollbackBytes:number, ws:object|null, idleAt:number}>} */
const sessions = new Map();

function clampDim(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

export async function spawnSession({ worktreePath, kind, cols, rows, sessionId }) {
  if (!(kind in COMMANDS)) {
    const err = new Error(`invalid kind: ${kind}`);
    err.code = 4403;
    throw err;
  }

  const worktrees = await _getWorktrees();
  const entry = worktrees.find((w) => w.path === worktreePath);
  if (!entry) {
    const err = new Error(`unknown worktree path: ${worktreePath}`);
    err.code = 4403;
    throw err;
  }

  if (sessions.size >= MAX_SESSIONS) {
    const err = new Error('session cap reached');
    err.code = 4429;
    throw err;
  }

  const safeCols = clampDim(cols);
  const safeRows = clampDim(rows);

  const cmdDef = COMMANDS[kind];
  const cwd = entry.path;

  const ptyProcess = _spawnFn(SHELL, cmdDef.args, {
    name: 'xterm-color',
    cols: safeCols,
    rows: safeRows,
    cwd,
    env: process.env,
  });

  const id = (sessionId && typeof sessionId === 'string' && sessionId.length > 0) ? sessionId : crypto.randomUUID();
  const session = { id, ptyProcess, worktreePath: cwd, kind, scrollback: [], scrollbackBytes: 0, ws: null, idleAt: 0 };
  sessions.set(id, session);

  // Wire onData ONCE at spawn. Appends to scrollback ring always; sends live only when a client is attached.
  ptyProcess.onData((data) => {
    // Append to scrollback ring (byte cap + chunk-count cap, evict from front)
    session.scrollback.push(data);
    session.scrollbackBytes += data.length;
    while (session.scrollbackBytes > SCROLLBACK_MAX_BYTES && session.scrollback.length > 0) {
      const evicted = session.scrollback.shift();
      session.scrollbackBytes -= evicted.length;
    }
    while (session.scrollback.length > SCROLLBACK_MAX_CHUNKS) {
      const evicted = session.scrollback.shift();
      session.scrollbackBytes -= evicted.length;
    }
    // Live send with backpressure guard — reads session.ws dynamically so it follows attach/detach
    if (session.ws && session.ws.readyState === session.ws.constructor.OPEN && session.ws.bufferedAmount < HIGH_WATER) {
      session.ws.send(data);
    }
  });

  return session;
}

export function attachClient(id, ws) {
  const session = sessions.get(id);
  if (!session) return;
  // Supersede any client already attached to this session so a reattach never
  // leaves an orphaned authorized socket (e.g. two tabs reusing a sessionId).
  if (session.ws && session.ws !== ws) {
    session.ws.close();
  }
  // Replay existing scrollback to the new client in order
  for (const chunk of session.scrollback) {
    ws.send(chunk);
  }
  // Set active client — onData handler (wired at spawn) reads this dynamically
  session.ws = ws;
}

export function detachClient(id) {
  const session = sessions.get(id);
  if (!session) return;
  session.ws = null;
  session.idleAt = Date.now();
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

// Graceful session teardown: write exit sequence to prompt claude to flush its
// incremental session JSONL, then unconditionally force-kill after a short grace
// window. claude already writes JSONL as the conversation progresses — this
// hardens the last-turn flush for a cleaner /resume listing on close. It is NOT
// the primary fix for refresh continuity (Phase 1 handles that). On SIGINT/SIGTERM,
// shutdown() skips this path and kills synchronously; do not block daemon exit here.
function finalizeSession(session) {
  _pendingGrace.add(session);
  // Best-effort exit sequence — each op individually swallowed so a dead pty
  // cannot throw past the kill
  try { session.ptyProcess.write('\x03'); } catch {}
  try { session.ptyProcess.write('/exit\r'); } catch {}
  // Unconditional force-kill after grace — fires regardless of whether claude
  // honored the exit sequence, preventing zombie ConPTY processes on Windows
  session._graceTimer = _timeoutFn(() => {
    _pendingGrace.delete(session);
    try { session.ptyProcess.kill(); } catch {}
  }, 1500);
}

export function killSession(id) {
  const session = sessions.get(id);
  if (!session) return; // idempotent: second call for same id is a no-op
  sessions.delete(id); // remove immediately so MAX_SESSIONS cap stays correct
  finalizeSession(session);
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

export function getAllSessions() {
  return [...sessions.values()];
}

// Idle reaper
let _reaperInterval = null;

function startReaper() {
  _reaperInterval = _timerFn(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (!session.ws && session.idleAt > 0 && now - session.idleAt > IDLE_TIMEOUT_MS) {
        console.log(`[pty] reaped idle session ${id}`);
        killSession(id);
      }
    }
  }, 60000);
  // unref so the interval doesn't prevent Node.js from exiting when idle
  if (_reaperInterval && typeof _reaperInterval.unref === 'function') {
    _reaperInterval.unref();
  }
}

startReaper();

export function _restartReaper() {
  if (_reaperInterval !== null) {
    clearInterval(_reaperInterval);
    _reaperInterval = null;
  }
  startReaper();
}

export function shutdown() {
  if (_reaperInterval !== null) {
    clearInterval(_reaperInterval);
    _reaperInterval = null;
  }
  // Force-kill sessions still in the map synchronously — do NOT use the async
  // grace window on process exit (SIGINT/SIGTERM must terminate promptly).
  for (const session of [...sessions.values()]) {
    sessions.delete(session.id);
    try { session.ptyProcess.write('\x03'); } catch {}
    try { session.ptyProcess.write('/exit\r'); } catch {}
    try { session.ptyProcess.kill(); } catch {}
  }
  // Cancel grace timers from any prior killSession calls so no timer leaks
  // survive daemon exit and no pty fires a redundant second kill
  for (const session of _pendingGrace) {
    _clearTimeoutFn(session._graceTimer);
    try { session.ptyProcess.kill(); } catch {}
  }
  _pendingGrace.clear();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
