// Bootstrap / orchestration entry point. Registers the render + auth-error
// callbacks into app-events.js (so lower modules never import main.js back),
// wires login + DOM listeners, and drives the 2s poll. This phase delegates the
// actual DOM rendering to views-legacy.js (deleted in Phase 2).
import {
  TOKEN,
  setStoredToken,
  clearStoredToken,
  fetchState,
  fetchProjects,
  AuthError,
} from './api.js';
import {
  lastState,
  inFlight,
  setLastState,
  registerRender,
  registerAuthError,
} from './app-events.js';
import { renderRunning, renderProjects } from './views-legacy.js';
import { submitAddProject, toggleBrowser } from './add-project.js';

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

function renderAuthError() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  showLoginOverlay('Session expired — please log in again.');
}

function render(state, busy = inFlight) {
  if (!state) return;
  const anyRunning = (state.running ?? []).length > 0;
  document.getElementById('lanUrl').innerHTML = anyRunning
    ? `<a href="${state.lanUrl}" target="_blank">${state.lanUrl}</a>`
    : `<span style="color:var(--muted)">dev url: ${state.lanUrl}</span>`;
  renderRunning(state);
  renderProjects(state, busy);
}

let pollingInterval = null;

async function tick() {
  if (!inFlight) {
    try {
      const [state] = await Promise.all([fetchState(), fetchProjects()]);
      setLastState(state);
      render(lastState);
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
