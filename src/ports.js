import { getAllStatuses } from './runner.js';

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
 * @param {string} worktreePath
 */
export function releasePort(worktreePath) {
  allocated.delete(worktreePath);
}
