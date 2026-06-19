import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorktrees } from './worktrees.js';
import {
  startServer,
  stopServer,
  stopAll,
  runCommand,
  stopCommand,
  getStatus,
  getAllStatuses,
  getLogs,
} from './runner.js';
import { getLanIPv4 } from './netinfo.js';
import { ensureToken, isAuthorized } from './token.js';
import { loadProjects, addProject, removeProject, updateProject } from './config.js';
import { autoDetectProject } from './detect.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = path.join(repoRoot, 'public', 'index.html');

const PORT = Number(process.env.LOCAL_PM_PORT) || 7420;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveIndex(res) {
  const html = fs.readFileSync(indexHtml, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function handleState(res) {
  const lanIp = getLanIPv4();
  const running = getAllStatuses();
  const firstPort = running[0]?.port ?? null;
  sendJson(res, 200, {
    worktrees: await getWorktrees(),
    running,
    lanUrl: firstPort ? `http://${lanIp}:${firstPort}` : null,
    serverPort: PORT,
  });
}

function handleLogs(url, res) {
  const worktreePath = url.searchParams.get('path');
  if (!worktreePath) return sendJson(res, 400, { error: 'path is required' });
  sendJson(res, 200, { logs: getLogs(worktreePath) });
}

async function handleStart(req, res) {
  const { path: worktreePath } = await readJsonBody(req);
  if (!worktreePath) return sendJson(res, 400, { error: 'path is required' });
  const worktrees = await getWorktrees();
  const known = worktrees.find((w) => w.path === worktreePath);
  if (!known || !fs.existsSync(worktreePath)) {
    return sendJson(res, 400, { error: `unknown or missing worktree path: ${worktreePath}` });
  }
  const meta = { project: known.project, branch: known.branch, path: worktreePath, type: known.type };
  try {
    await startServer(worktreePath, meta);
  } catch (err) {
    if (/pool exhausted/i.test(err.message)) {
      return sendJson(res, 503, { error: err.message });
    }
    throw err;
  }
  sendJson(res, 200, getStatus(worktreePath));
}

async function handleStop(req, res) {
  const { path: worktreePath } = await readJsonBody(req);
  if (worktreePath) {
    await stopServer(worktreePath);
  } else {
    await stopAll();
  }
  sendJson(res, 200, { running: getAllStatuses() });
}

async function handleCommand(req, res) {
  const { path: worktreePath, cmd, label } = await readJsonBody(req);
  if (!worktreePath || !cmd) return sendJson(res, 400, { error: 'path and cmd are required' });
  const worktrees = await getWorktrees();
  const known = worktrees.find((w) => w.path === worktreePath);
  if (!known || !fs.existsSync(worktreePath)) {
    return sendJson(res, 400, { error: `unknown or missing worktree path: ${worktreePath}` });
  }
  await runCommand(worktreePath, { cmd, label: label ?? cmd });
  sendJson(res, 200, getStatus(worktreePath));
}

function handleStopCommand(res) {
  stopCommand();
  sendJson(res, 200, getStatus());
}

// --- project CRUD ----------------------------------------------------------

function projectsList() {
  return loadProjects().map(({ exists, ...entry }) => entry);
}

async function handleProjectAdd(req, res) {
  const { path: folderPath } = await readJsonBody(req);
  if (!folderPath) return sendJson(res, 400, { error: 'path is required' });
  let detection;
  try {
    detection = autoDetectProject(folderPath);
  } catch (err) {
    return sendJson(res, 400, { error: `not a valid directory: ${err.message}` });
  }
  const name = path.basename(folderPath);
  const entry = addProject({ name, root: folderPath, type: detection.type });
  sendJson(res, 200, { project: entry, detection });
}

async function handleProjectDelete(req, res) {
  const { root } = await readJsonBody(req);
  if (!root) return sendJson(res, 400, { error: 'root is required' });
  const removed = removeProject(root);
  if (!removed) return sendJson(res, 404, { error: `no project with root: ${root}` });
  sendJson(res, 200, { projects: projectsList() });
}

async function handleProjectPatch(req, res) {
  const { root, patch } = await readJsonBody(req);
  if (!root || !patch) return sendJson(res, 400, { error: 'root and patch are required' });
  const updated = updateProject(root, patch);
  if (!updated) return sendJson(res, 404, { error: `no project with root: ${root}` });
  sendJson(res, 200, { project: updated });
}

function handleProjectsGet(res) {
  sendJson(res, 200, { projects: projectsList() });
}

async function route(req, res) {
  const { method } = req;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/') && !isAuthorized(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (method === 'GET' && url.pathname === '/') return serveIndex(res);
  if (method === 'GET' && url.pathname === '/api/state') return handleState(res);
  if (method === 'GET' && url.pathname === '/api/logs') return handleLogs(url, res);
  if (method === 'POST' && url.pathname === '/api/start') return handleStart(req, res);
  if (method === 'POST' && url.pathname === '/api/stop') return handleStop(req, res);
  if (method === 'POST' && url.pathname === '/api/command') return handleCommand(req, res);
  if (method === 'POST' && url.pathname === '/api/command/stop') return handleStopCommand(res);
  if (method === 'GET' && url.pathname === '/api/projects') return handleProjectsGet(res);
  if (method === 'POST' && url.pathname === '/api/projects/add') return handleProjectAdd(req, res);
  if (method === 'DELETE' && url.pathname === '/api/projects') return handleProjectDelete(req, res);
  if (method === 'PATCH' && url.pathname === '/api/projects') return handleProjectPatch(req, res);
  sendJson(res, 404, { error: 'not found' });
}

export const server = http.createServer((req, res) => {
  route(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
});

// Only bind the port when run as the entry point; importing for tests must not listen.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLanIPv4();
    console.log(`local-pm listening`);
    console.log(`  local: http://localhost:${PORT}`);
    console.log(`  LAN:   http://${lanIp}:${PORT}`);
    const { token, isNew } = ensureToken();
    if (isNew) console.log(`  token: ${token}`);
    else console.log(`  auth token loaded from token.local`);
  });
}
