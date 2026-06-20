import {
  authHeaders,
  apiSend,
  apiSendChecked,
  refreshAfterMutation,
  AuthError,
} from './api.js';
import { signalAuthError } from './app-events.js';
import { selected, setSelected } from './selection.js';

function setAddError(msg) {
  document.getElementById('addError').textContent = msg ?? '';
}

function clearSetup() {
  document.getElementById('addSetup').innerHTML = '';
}

// Build an inline setup/edit form. `values` pre-fills the fields; `onSubmit`
// receives the collected patch. Used both for the post-add setup fallback and
// the per-project Edit button — same form, different seed values.
export function buildSetupForm({ title, hint, values, onSubmit, onCancel }) {
  const form = document.createElement('div');
  form.className = 'setup-form';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  form.appendChild(h3);
  if (hint) {
    const p = document.createElement('p');
    p.textContent = hint;
    form.appendChild(p);
  }

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = values.name ?? '';

  const devLabel = document.createElement('label');
  devLabel.textContent = 'Dev command';
  const devInput = document.createElement('input');
  devInput.type = 'text';
  devInput.placeholder = 'npm run dev';
  devInput.value = values.devCmd ?? '';

  const portsLabel = document.createElement('label');
  portsLabel.textContent = 'Port variables (comma-separated, e.g. APP_PORT,WS_HOST_PORT)';
  const portsInput = document.createElement('input');
  portsInput.type = 'text';
  portsInput.value = (values.portVars ?? []).map((v) => v.varName ?? v).join(', ');

  form.append(nameLabel, nameInput, devLabel, devInput, portsLabel, portsInput);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.className = 'start';
  save.textContent = 'Save';
  save.onclick = () => {
    const portVars = portsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((varName) => ({ varName }));
    onSubmit({ name: nameInput.value.trim(), devCmd: devInput.value.trim(), portVars });
  };
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = onCancel;
  actions.append(save, cancel);
  form.appendChild(actions);
  return form;
}

// Windows "Copy as path" wraps the value in double quotes; strip surrounding
// single/double quotes (and whitespace) so fs.stat does not 400 on them.
export function cleanPath(raw) {
  return raw.trim().replace(/^["']+|["']+$/g, '').trim();
}

// --- Folder browser -----------------------------------------------------
// Path currently shown in the browser panel; drives the "Use this folder"
// action. The panel lives in the static #browsePanel container so it
// survives the 2s poll (which only rebuilds #projects).
let browseCwd = null;

async function fetchBrowse(dirPath) {
  const qs = dirPath ? '?path=' + encodeURIComponent(dirPath) : '';
  const res = await fetch('/api/browse' + qs, { headers: authHeaders() });
  if (res.status === 401) throw new AuthError('unauthorized');
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

function closeBrowser() {
  browseCwd = null;
  document.getElementById('browsePanel').innerHTML = '';
}

async function openBrowser(dirPath) {
  try {
    const { ok, body } = await fetchBrowse(dirPath);
    if (!ok) {
      renderBrowser({ error: body.error ?? 'Could not list folder.' });
      return;
    }
    browseCwd = body.path;
    renderBrowser(body);
  } catch (err) {
    if (err instanceof AuthError) return signalAuthError();
    renderBrowser({ error: 'Could not reach server.' });
  }
}

function makeDriveSwitcher(drives) {
  const wrap = document.createElement('span');
  wrap.className = 'drives';
  for (const drive of drives) {
    const btn = document.createElement('button');
    btn.textContent = drive.replace(/\/$/, '');
    btn.onclick = () => openBrowser(drive);
    wrap.appendChild(btn);
  }
  return wrap;
}

function makeDirItem(entry) {
  const item = document.createElement('div');
  item.className = 'dir-item' + (entry.isProject ? ' is-project' : '');
  const name = document.createElement('span');
  name.textContent = entry.name;
  item.appendChild(name);
  if (entry.isProject) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'project';
    item.appendChild(tag);
  }
  item.onclick = () => openBrowser(joinBrowsePath(entry.name));
  return item;
}

function joinBrowsePath(name) {
  const base = browseCwd.replace(/[\\/]+$/, '');
  return base + '/' + name;
}

function renderBrowser(data) {
  const panel = document.getElementById('browsePanel');
  panel.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'browser';

  const crumbs = document.createElement('div');
  crumbs.className = 'crumbs';
  const up = document.createElement('button');
  up.textContent = '↑ Up';
  up.disabled = !data.parent;
  up.onclick = () => openBrowser(data.parent);
  crumbs.appendChild(up);
  const cwd = document.createElement('span');
  cwd.className = 'cwd';
  cwd.title = data.path ?? '';
  cwd.textContent = data.path ?? '';
  crumbs.appendChild(cwd);
  if ((data.drives ?? []).length) crumbs.appendChild(makeDriveSwitcher(data.drives));
  box.appendChild(crumbs);

  const error = document.createElement('div');
  error.className = 'browse-error';
  error.textContent = data.error ?? '';
  box.appendChild(error);

  if (data.path) {
    const list = document.createElement('div');
    list.className = 'dir-list';
    const entries = data.entries ?? [];
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty';
      empty.textContent = 'No subfolders.';
      list.appendChild(empty);
    } else {
      for (const entry of entries) list.appendChild(makeDirItem(entry));
    }
    box.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const use = document.createElement('button');
    use.className = 'start';
    use.textContent = 'Use this folder';
    use.onclick = () => {
      document.getElementById('addPath').value = browseCwd;
      closeBrowser();
      submitAddProject();
    };
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.onclick = closeBrowser;
    actions.append(use, close);
    box.appendChild(actions);
  }

  panel.appendChild(box);
}

export function toggleBrowser() {
  if (browseCwd !== null) { closeBrowser(); return; }
  const seed = cleanPath(document.getElementById('addPath').value);
  openBrowser(seed || undefined);
}

// Open/close the add-project panel. Lightweight close affordance (✕ button,
// backdrop, auto-close after a setup-free add); Phase 4 promotes this to a full
// `.overlay` modal wrapping the same markup.
export function openAddPanel() {
  document.getElementById('addProject').classList.remove('hidden');
  document.getElementById('addBackdrop').classList.remove('hidden');
}

export function closeAddPanel() {
  document.getElementById('addProject').classList.add('hidden');
  document.getElementById('addBackdrop').classList.add('hidden');
}

export async function submitAddProject() {
  const input = document.getElementById('addPath');
  const folderPath = cleanPath(input.value);
  if (!folderPath) return;
  setAddError('');
  clearSetup();
  try {
    const { ok, body } = await apiSend('POST', '/api/projects/add', { path: folderPath });
    if (!ok) {
      setAddError(body.error ?? 'Could not add project.');
      return;
    }
    input.value = '';
    const { project, detection } = body;
    // The chosen dev command MUST be visible before any Start — show the
    // setup form (pre-filled) whenever detection is inconclusive.
    if (detection.needsSetup) {
      const setup = buildSetupForm({
        title: `Set up ${project.name}`,
        hint: detection.devCmd
          ? 'Confirm the detected dev command and any port variables, then Save.'
          : 'No dev/start script was detected — enter the command to run, then Save.',
        values: { name: project.name, devCmd: detection.devCmd, portVars: detection.portVars },
        onSubmit: async (patch) => {
          const ok = await apiSendChecked('PATCH', '/api/projects', { root: project.root, patch }, 'save project');
          if (!ok) return;
          clearSetup();
          refreshAfterMutation();
        },
        onCancel: () => { clearSetup(); refreshAfterMutation(); },
      });
      document.getElementById('addSetup').appendChild(setup);
    } else {
      // No setup needed — the add is complete, so close the panel.
      closeAddPanel();
    }
    refreshAfterMutation();
  } catch (err) {
    if (err instanceof AuthError) return signalAuthError();
    setAddError('Could not reach server.');
  }
}

// Root of the project whose inline Edit form is currently open, or null.
// Tracked at module scope so the 2s poll can re-render the form (it lives
// inside a `.project` section that renderProjects rebuilds on every poll).
let openEditRoot = null;

export function getOpenEditRoot() {
  return openEditRoot;
}

export function setOpenEditRoot(value) {
  openEditRoot = value;
}

export function closeEditForm(container) {
  const f = container?.querySelector('.setup-form');
  if (f) f.remove();
  openEditRoot = null;
}

// Read the live edit form's current field values so a poll-driven re-render
// reseeds with what the user has typed rather than the stored project values.
export function captureEditValues(container) {
  const form = container?.querySelector('.setup-form');
  if (!form) return null;
  const inputs = form.querySelectorAll('input[type="text"]');
  const [name, devCmd, ports] = inputs;
  return {
    name: name?.value,
    devCmd: devCmd?.value,
    portVars: (ports?.value ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export function renderEditForm(container, project, seed) {
  const values = seed ?? { name: project.name, devCmd: project.devCmd, portVars: project.portVars };
  const form = buildSetupForm({
    title: `Edit ${project.name}`,
    values,
    onSubmit: async (patch) => {
      const ok = await apiSendChecked('PATCH', '/api/projects', { root: project.root, patch }, 'save project');
      if (!ok) return;
      openEditRoot = null;
      refreshAfterMutation();
    },
    onCancel: () => closeEditForm(container),
  });
  container.appendChild(form);
}

export function openEditForm(container, project) {
  if (openEditRoot === project.root) { closeEditForm(container); return; }
  openEditRoot = project.root;
  renderEditForm(container, project);
}

// Confirm + DELETE the project, then clear the selection if it pointed at this
// project (its overview is about to vanish) and re-render. Selection state is
// cleared directly via selection.js (a leaf — no import cycle).
export async function removeProject(project) {
  if (!confirm('Remove project ' + project.name + '?')) return;
  const ok = await apiSendChecked('DELETE', '/api/projects', { root: project.root }, 'remove project');
  if (!ok) return;
  if (selected && selected.type === 'project' && selected.path === project.name) setSelected(null);
  if (openEditRoot === project.root) openEditRoot = null;
  refreshAfterMutation();
}
