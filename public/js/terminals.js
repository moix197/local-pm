import { TOKEN } from './api.js';

// xterm (Terminal) and FitAddon are loaded as globals via <script> tags in index.html.

const TERM_HIGH_WATER = 1 << 20;
const clampDim = (v) => Math.max(1, Math.min(500, v));

// crypto.randomUUID is SecureContext-only and undefined over plain http on a
// LAN IP, so fall back to a local id (used only as a sessions Map key).
const newSessionId = () =>
  crypto.randomUUID?.() ??
  'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

// One terminal group per worktree path. Each group owns a tabs bar and a
// `sessions` Map<sessionId, {ws, terminal, fitAddon, ro, kind, pane, tabEl}>.
// Groups live under #terminals so the 2s poll's innerHTML wipe never removes them.
const terminalGroups = new Map();

export function ensureTerminalGroup(worktreePath) {
  let group = terminalGroups.get(worktreePath);
  if (group) return group;
  const root = document.createElement('div');
  root.className = 'terminal-group';
  const tabs = document.createElement('div');
  tabs.className = 'terminal-tabs';
  const label = document.createElement('span');
  label.className = 'group-label';
  label.title = worktreePath;
  label.textContent = worktreePath.split(/[\\/]/).filter(Boolean).pop() ?? worktreePath;
  tabs.appendChild(label);
  root.appendChild(tabs);
  document.getElementById('terminals').appendChild(root);
  group = { worktreePath, root, tabs, sessions: new Map(), counts: { shell: 0, claude: 0 } };
  terminalGroups.set(worktreePath, group);
  return group;
}

// Build the WS for a session and wire it to the session's terminal. Used on
// first open and when reattaching a tab whose socket has closed. The server
// treats a known sessionId as a reattach (replays scrollback) and an unknown
// one as a new spawn — same code path either way.
export function connectSession(group, sessionId) {
  const sess = group.sessions.get(sessionId);
  const { terminal, fitAddon, kind } = sess;
  const cols = clampDim(terminal.cols);
  const rows = clampDim(terminal.rows);
  const wsUrl = `ws://${location.host}/ws/terminal?token=${encodeURIComponent(TOKEN)}&worktreePath=${encodeURIComponent(group.worktreePath)}&kind=${kind}&cols=${cols}&rows=${rows}&sessionId=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data;
    terminal.write(data);
  };
  sess.ws = ws;
}

export function activateTab(group, sessionId) {
  for (const [id, s] of group.sessions) {
    const active = id === sessionId;
    s.pane.classList.toggle('hidden', !active);
    s.tabEl.classList.toggle('active', active);
  }
  const sess = group.sessions.get(sessionId);
  if (!sess) return;
  // Reattach if the socket was closed while this tab was in the background.
  if (sess.ws.readyState === WebSocket.CLOSED) connectSession(group, sessionId);
  sess.fitAddon.fit();
  sess.terminal.focus();
}

// Closing a tab disconnects the WS (server keeps the session alive per detach
// semantics) and removes the tab + pane. If it was the active tab, switch to
// whichever session remains.
export function closeTab(group, sessionId) {
  const sess = group.sessions.get(sessionId);
  if (!sess) return;
  try { sess.ws.close(); } catch {}
  sess.ro.disconnect();
  sess.terminal.dispose();
  sess.pane.remove();
  sess.tabEl.remove();
  group.sessions.delete(sessionId);
  if (group.sessions.size === 0) {
    group.root.remove();
    terminalGroups.delete(group.worktreePath);
    return;
  }
  const next = [...group.sessions.keys()][0];
  activateTab(group, next);
}

export function openTerminal(worktreePath, kind) {
  const group = ensureTerminalGroup(worktreePath);
  const sessionId = newSessionId();
  const n = (group.counts[kind] += 1);
  const tabLabel = `${kind === 'claude' ? 'Claude' : 'Shell'} #${n}`;

  const terminal = new Terminal({ cursorBlink: true });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  const body = document.createElement('div');
  body.className = 'terminal-body';
  pane.appendChild(body);
  group.root.appendChild(pane);

  const tabEl = document.createElement('span');
  tabEl.className = 'tab';
  const tabText = document.createElement('span');
  tabText.textContent = tabLabel;
  tabText.onclick = () => activateTab(group, sessionId);
  const closeX = document.createElement('span');
  closeX.className = 'close';
  closeX.textContent = '✕';
  closeX.title = 'Close terminal';
  closeX.onclick = () => closeTab(group, sessionId);
  tabEl.append(tabText, closeX);
  group.tabs.appendChild(tabEl);

  const sess = { ws: null, terminal, fitAddon, ro: null, kind, pane, tabEl };
  group.sessions.set(sessionId, sess);

  terminal.open(body);
  fitAddon.fit();

  terminal.onData((d) => {
    if (sess.ws && sess.ws.readyState === WebSocket.OPEN && sess.ws.bufferedAmount < TERM_HIGH_WATER) sess.ws.send(d);
  });

  const ro = new ResizeObserver(() => {
    fitAddon.fit();
    const c = clampDim(terminal.cols);
    const r = clampDim(terminal.rows);
    if (sess.ws && sess.ws.readyState === WebSocket.OPEN) sess.ws.send(JSON.stringify({ resize: { cols: c, rows: r } }));
  });
  ro.observe(body);
  sess.ro = ro;

  connectSession(group, sessionId);
  activateTab(group, sessionId);
}
