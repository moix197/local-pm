import { TOKEN } from './api.js';
import { loadMacros, addMacro, removeMacro } from './term-macros.js';
import { MODE, setMode } from './keynav/mode.js';
import { assertBadge } from './keynav/mode-badge.js';
import { isDesktop } from './keynav/desktop-gate.js';

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

// Tracks the last group whose terminal received focus (for blurActiveTerminal).
let _activeGroup = null;

// Quick-key buttons: [label, raw byte sequence, aria-label?]. The byte sequence
// is sent to the active PTY on the same channel xterm onData uses. Glyph-only
// labels carry an aria-label; self-describing digits/letters omit it.
const QUICK_KEYS = [
  ['↵', '\r', 'Enter'],
  ['Esc', '\x1b'],
  ['↑', '\x1b[A', 'Up'],
  ['↓', '\x1b[B', 'Down'],
  ['Tab', '\t'],
  ['⇧Tab', '\x1b[Z', 'Shift Tab'],
  ['Ctrl+C', '\x03'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['y', 'y'],
  ['n', 'n'],
];

// Send raw input to the group's currently active session, mirroring the guard
// xterm's onData handler uses. No-op if there's no open socket.
function sendToActive(group, data) {
  const sess = group.sessions.get(group.activeId);
  if (sess && sess.ws && sess.ws.readyState === WebSocket.OPEN && sess.ws.bufferedAmount < TERM_HIGH_WATER) {
    sess.ws.send(data);
  }
}

// Refit the group's active session to its current pane size and push the new
// cols/rows to the PTY — same contract as the per-session ResizeObserver. Called
// after a layout change (focus toggle) where the observer may not fire.
function refitActive(group) {
  const sess = group.sessions.get(group.activeId);
  if (!sess) return;
  sess.fitAddon.fit();
  const cols = clampDim(sess.terminal.cols);
  const rows = clampDim(sess.terminal.rows);
  if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
    sess.ws.send(JSON.stringify({ resize: { cols, rows } }));
  }
}

// Toggle full-screen focus for this group. Marks the group + body with the CSS
// classes that expand it to the viewport; terminals/sockets are never touched.
// After the layout settles the active session is refit to the new size.
function toggleFocus(group, btn) {
  const on = !group.root.classList.contains('terminal-focused');
  group.root.classList.toggle('terminal-focused', on);
  document.body.classList.toggle('terminal-focus', on);
  btn.setAttribute('aria-pressed', String(on));
  requestAnimationFrame(() => refitActive(group));
}

// Build one macro chip (send on tap, ✕ to delete + re-render all strips). Delete
// is identity-based (passes the macro object) so a stale index can't remove the
// wrong entry.
function makeMacroChip(group, macro) {
  const chip = document.createElement('span');
  chip.className = 'term-macro';
  const text = document.createElement('span');
  text.textContent = macro.label;
  text.title = macro.text;
  text.onclick = () => sendToActive(group, macro.text + '\r');
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'term-macro-close';
  del.textContent = '✕';
  del.setAttribute('aria-label', `Delete macro ${macro.label}`);
  del.onclick = () => {
    removeMacro(macro);
    refreshMacroStrips();
  };
  chip.append(text, del);
  return chip;
}

// Rebuild a single group's macro strip from localStorage. The ＋ add button is
// kept stable; only the chips before it are replaced.
function renderMacroStrip(group) {
  const strip = group.macroStrip;
  for (const chip of [...strip.querySelectorAll('.term-macro')]) chip.remove();
  const macros = loadMacros();
  for (const macro of macros) strip.insertBefore(makeMacroChip(group, macro), group.addMacroBtn);
}

// Macros are a global list, so a change in one group must refresh every strip.
function refreshMacroStrips() {
  for (const group of terminalGroups.values()) renderMacroStrip(group);
}

// The persistent bottom toolbar: fixed quick keys + the global macro strip.
// Built once per group in ensureTerminalGroup; never rebuilt by the 2s poll.
function buildToolbar(group) {
  const bar = document.createElement('div');
  bar.className = 'terminal-toolbar';

  const keys = document.createElement('div');
  keys.className = 'term-quickkeys';
  for (const [label, seq, ariaLabel] of QUICK_KEYS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qkey';
    btn.textContent = label;
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
    btn.onclick = () => sendToActive(group, seq);
    keys.appendChild(btn);
  }

  const focusBtn = document.createElement('button');
  focusBtn.type = 'button';
  focusBtn.className = 'qkey term-focus-toggle';
  focusBtn.textContent = '⛶';
  focusBtn.setAttribute('aria-label', 'Toggle full screen');
  focusBtn.setAttribute('aria-pressed', 'false');
  focusBtn.onclick = () => toggleFocus(group, focusBtn);
  keys.appendChild(focusBtn);

  const strip = document.createElement('div');
  strip.className = 'term-macros-strip';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'qkey add-macro';
  addBtn.textContent = '＋';
  addBtn.title = 'Add macro';
  addBtn.setAttribute('aria-label', 'Add macro');
  addBtn.onclick = () => {
    const label = window.prompt('Macro label:');
    if (!label || !label.trim()) return;
    const text = window.prompt('Macro text (sent + Enter):');
    if (!text) return;
    addMacro(label, text);
    refreshMacroStrips();
  };
  strip.appendChild(addBtn);

  bar.append(keys, strip);
  group.macroStrip = strip;
  group.addMacroBtn = addBtn;
  group.toolbar = bar;
  group.root.appendChild(bar);
  renderMacroStrip(group);
}

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
  group = { worktreePath, root, tabs, sessions: new Map(), counts: { shell: 0, claude: 0 }, activeId: null };
  terminalGroups.set(worktreePath, group);
  buildToolbar(group);
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
  group.activeId = sessionId;
  // Reattach if the socket was closed while this tab was in the background.
  if (sess.ws.readyState === WebSocket.CLOSED) connectSession(group, sessionId);
  sess.fitAddon.fit();
  sess.terminal.focus();
  _activeGroup = group;
  if (isDesktop()) { setMode(MODE.WRITING); assertBadge(MODE.WRITING); }
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
    // Closing the last tab while focused would otherwise leave the page
    // scroll-locked with no terminal/exit visible — release focus first.
    if (group.root.classList.contains('terminal-focused')) {
      document.body.classList.remove('terminal-focus');
    }
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
  // Insert before the toolbar so the toolbar stays anchored at the bottom of
  // the group (thumb-reachable on mobile). The toolbar is built once in
  // ensureTerminalGroup and is always the last child of root.
  group.root.insertBefore(pane, group.toolbar);

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

// Focus the active session's xterm terminal for the given worktree path.
// Returns true if a terminal was found and focused, false otherwise.
export function focusTerminalForPath(path) {
  const group = terminalGroups.get(path);
  if (!group || !group.activeId) return false;
  const sess = group.sessions.get(group.activeId);
  if (!sess) return false;
  sess.terminal.focus();
  _activeGroup = group;
  return true;
}

// Blur the currently active terminal (called by keynav on double-Esc exit).
export function blurActiveTerminal() {
  if (!_activeGroup) return;
  const sess = _activeGroup.sessions.get(_activeGroup.activeId);
  if (sess) sess.terminal.blur();
  _activeGroup = null;
}
