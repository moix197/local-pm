// Bootstrap / orchestration entry point. Registers the render + auth-error
// callbacks into app-events.js (so lower modules never import main.js back),
// wires login + DOM listeners, and drives the 2s poll. render() resolves the
// selection then orchestrates sidebar.js → main-pane.js → terminal visibility.
import {
  TOKEN,
  setStoredToken,
  clearStoredToken,
  fetchState,
  fetchProjects,
  post,
  AuthError,
} from './api.js';
import {
  lastState,
  inFlight,
  setLastState,
  registerRender,
  registerAuthError,
} from './app-events.js';
import { resolveSelection, setSelected, selected } from './selection.js';
import { renderSidebar } from './sidebar.js';
import { renderMain, updateTerminalVisibility } from './main-pane.js';
import { submitAddProject, toggleBrowser, openAddModal, closeAddModal } from './add-project.js';
import { initKeynav } from './keynav/keynav.js';
import { assertBadge } from './keynav/mode-badge.js';
import { getMode } from './keynav/mode.js';
import { isDesktop } from './keynav/desktop-gate.js';
import { refreshPaletteIfOpen } from './keynav/palette.js';
import { reconnectActiveWorktree } from './terminals.js';

function showLoginOverlay(errorMsg = '') {
  document.getElementById('overlayError').textContent = errorMsg;
  document.getElementById('tokenInput').value = '';
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('tokenInput').focus();
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay').classList.add('hidden');
}

async function submitToken() {
  const candidate = document.getElementById('tokenInput').value.trim();
  if (!candidate) {
    document.getElementById('overlayError').textContent = 'Token cannot be empty.';
    return;
  }
  const btn = document.getElementById('tokenSubmit');
  btn.disabled = true;
  try {
    const res = await fetch('/api/state', {
      headers: { Authorization: 'Bearer ' + candidate },
    });
    if (res.status === 401) {
      document.getElementById('overlayError').textContent = 'Invalid token — try again.';
      return;
    }
    if (!res.ok) {
      document.getElementById('overlayError').textContent = 'Server error — try again.';
      return;
    }
    setStoredToken(candidate);
    setLastState(await res.json());
    try { await fetchProjects(); } catch { /* projects load is non-fatal at login */ }
    hideLoginOverlay();
    render(lastState);
    startPolling();
  } catch {
    document.getElementById('overlayError').textContent = 'Could not reach server.';
  } finally {
    btn.disabled = false;
  }
}

// Mobile drawer toggle. State lives as the `sidebar-open` class on the static
// .app wrapper (not the poll-rebuilt #sidebar), so it survives re-renders.
// sidebar.js closes the drawer on nav selection via the shared CSS class — no
// import back into main.js, keeping the graph a DAG.
function setSidebarOpen(open) {
  document.querySelector('.app').classList.toggle('sidebar-open', open);
  document.getElementById('sidebarToggle').setAttribute('aria-expanded', String(open));
}

function toggleSidebar() {
  setSidebarOpen(!document.querySelector('.app').classList.contains('sidebar-open'));
}

function renderAuthError() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  showLoginOverlay('Session expired — please log in again.');
}

function render(state, busy = inFlight) {
  if (!state) return;
  const anyRunning = (state.running ?? []).length > 0;
  const lanUrl = state.lanUrl;
  document.getElementById('lanUrl').innerHTML =
    lanUrl == null
      ? ''
      : anyRunning
        ? `<a href="${lanUrl}" target="_blank">${lanUrl}</a>`
        : `<span style="color:var(--muted)">dev url: ${lanUrl}</span>`;
  document.getElementById('stopAllBtn').classList.toggle('hidden', !anyRunning);

  const resolved = resolveSelection(state, selected);
  setSelected(resolved);
  renderSidebar(state);
  renderMain(state, resolved, busy);
  updateTerminalVisibility(resolved?.type === 'worktree' ? resolved.path : null);
  if (isDesktop()) assertBadge(getMode());
  refreshPaletteIfOpen();
}

let pollingInterval = null;
let reattached = false;

async function tick() {
  if (!inFlight) {
    try {
      const [state] = await Promise.all([fetchState(), fetchProjects()]);
      setLastState(state);
      render(lastState);
      if (!reattached) { reattached = true; reconnectActiveWorktree(selected?.type === 'worktree' ? selected.path : null); }
    } catch (err) {
      if (err instanceof AuthError) return renderAuthError();
      throw err;
    }
  }
}

function startPolling() {
  if (pollingInterval) return;
  tick();
  pollingInterval = setInterval(tick, 2000);
}

registerRender(render);
registerAuthError(renderAuthError);
initKeynav();

document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
document.getElementById('sidebarBackdrop').addEventListener('click', () => setSidebarOpen(false));
document.getElementById('stopAllBtn').addEventListener('click', () => post('/api/stop'));
document.getElementById('addProjectBtn').addEventListener('click', openAddModal);
document.getElementById('addCloseBtn').addEventListener('click', closeAddModal);
document.getElementById('addModal').addEventListener('click', e => {
  if (e.target.id === 'addModal') closeAddModal();
});
document.getElementById('addBtn').addEventListener('click', submitAddProject);
document.getElementById('browseBtn').addEventListener('click', toggleBrowser);
document.getElementById('addPath').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAddProject();
});
document.getElementById('tokenSubmit').addEventListener('click', submitToken);
document.getElementById('tokenInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitToken();
});
document.getElementById('forgetLink').addEventListener('click', e => {
  e.preventDefault();
  clearStoredToken();
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  showLoginOverlay();
});

if (TOKEN) {
  startPolling();
} else {
  showLoginOverlay();
}
