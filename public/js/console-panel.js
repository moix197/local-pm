import { authHeaders } from './api.js';
import { requestRender, signalAuthError } from './app-events.js';

// Set of worktree paths whose console panel is currently open. Logs are
// fetched lazily — only while a panel is open — so idle servers cost nothing.
export const openConsoles = new Set();
let consoleInterval = null;

export async function refreshConsole(path) {
  const pre = document.querySelector(`pre[data-console="${CSS.escape(path)}"]`);
  if (!pre) return;
  // PRD 2: replace poll with WebSocket stream (node-pty+xterm.js) — out of scope here
  const res = await fetch('/api/logs?path=' + encodeURIComponent(path), { headers: authHeaders() });
  if (res.status === 401) return signalAuthError();
  const body = await res.json();
  const text = (body.logs ?? []).join('\n');
  if (text === pre.textContent) return;
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = text;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

export function pollConsoles() {
  for (const path of openConsoles) refreshConsole(path);
}

export function ensureConsolePolling() {
  if (consoleInterval || openConsoles.size === 0) return;
  consoleInterval = setInterval(pollConsoles, 2000);
}

export function stopConsolePolling() {
  if (openConsoles.size === 0 && consoleInterval) {
    clearInterval(consoleInterval);
    consoleInterval = null;
  }
}

export function toggleConsole(path) {
  if (openConsoles.has(path)) openConsoles.delete(path);
  else openConsoles.add(path);
  stopConsolePolling();
  requestRender();
  ensureConsolePolling();
  if (openConsoles.has(path)) refreshConsole(path);
}

export function makeConsolePanel(path) {
  const pre = document.createElement('pre');
  pre.className = 'console';
  pre.dataset.console = path;
  return pre;
}
