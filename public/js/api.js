import {
  setLastState,
  setInFlight,
  requestRender,
  signalAuthError,
} from './app-events.js';

const TOKEN_KEY = 'lpm-token';
export let TOKEN = '';

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setStoredToken(value) {
  localStorage.setItem(TOKEN_KEY, value);
  TOKEN = value;
}

export function clearStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
  TOKEN = '';
}

const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (hashToken) {
  setStoredToken(hashToken);
  history.replaceState(null, '', location.pathname + location.search);
} else {
  TOKEN = getStoredToken();
}

export class AuthError extends Error {}

export function authHeaders(extra = {}) {
  return { Authorization: 'Bearer ' + TOKEN, ...extra };
}

export async function fetchState() {
  const res = await fetch('/api/state', { headers: authHeaders() });
  if (res.status === 401) throw new AuthError('unauthorized');
  return res.json();
}

// Configured projects (root/type/devCmd) — the source of Edit/Remove and
// the devCmd shown on each worktree row. Refreshed on each poll alongside state.
export let projectsByName = new Map();
export let projectsByRoot = new Map();

export async function fetchProjects() {
  const res = await fetch('/api/projects', { headers: authHeaders() });
  if (res.status === 401) throw new AuthError('unauthorized');
  const body = await res.json();
  projectsByName = new Map();
  projectsByRoot = new Map();
  for (const p of body.projects ?? []) {
    projectsByName.set(p.name, p);
    projectsByRoot.set(p.root, p);
  }
}

export async function post(url, body) {
  setInFlight(true);
  requestRender(true);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new AuthError('unauthorized');
    setLastState(await fetchState());
  } catch (err) {
    if (err instanceof AuthError) return signalAuthError();
    throw err;
  } finally {
    setInFlight(false);
    requestRender();
  }
}

// Generic JSON request for non-POST project verbs (DELETE/PATCH). Unlike
// `post`, it returns the parsed body so callers can read the detection result.
export async function apiSend(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('unauthorized');
  const parsed = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: parsed };
}

// Wrap apiSend for mutating verbs: surface a non-ok response to the user
// instead of failing silently. Returns true on success, false otherwise.
export async function apiSendChecked(method, url, body, action) {
  try {
    const { ok, body: resBody } = await apiSend(method, url, body);
    if (!ok) {
      alert(`Could not ${action}: ${resBody.error ?? 'server error'}`);
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof AuthError) { signalAuthError(); return false; }
    alert(`Could not ${action}: could not reach server.`);
    return false;
  }
}

export async function refreshAfterMutation() {
  try {
    await fetchProjects();
    setLastState(await fetchState());
    requestRender();
  } catch (err) {
    if (err instanceof AuthError) return signalAuthError();
    throw err;
  }
}
