import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorktrees } from './worktrees.js';
import { startServer, stopServer, getStatus, getLogs } from './runner.js';
import { getLanIPv4 } from './netinfo.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = path.join(repoRoot, 'public', 'index.html');

const PORT = Number(process.env.LOCAL_PM_PORT) || 7420;
const DEV_PORT = 3000;

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
  sendJson(res, 200, {
    worktrees: await getWorktrees(),
    status: getStatus(),
    logs: getLogs(),
    lanUrl: `http://${lanIp}:${DEV_PORT}`,
    serverPort: PORT,
  });
}

async function findWorktreeMeta(targetPath) {
  const match = (await getWorktrees()).find((w) => w.path === targetPath);
  return match ? { project: match.project, branch: match.branch } : undefined;
}

async function handleStart(req, res) {
  const { path: worktreePath } = await readJsonBody(req);
  if (!worktreePath) return sendJson(res, 400, { error: 'path is required' });
  const worktrees = await getWorktrees();
  const known = worktrees.find((w) => w.path === worktreePath);
  if (!known || !fs.existsSync(worktreePath)) {
    return sendJson(res, 400, { error: `unknown or missing worktree path: ${worktreePath}` });
  }
  const meta = { project: known.project, branch: known.branch };
  await startServer(worktreePath, meta);
  sendJson(res, 200, getStatus());
}

async function handleStop(res) {
  await stopServer();
  sendJson(res, 200, getStatus());
}

async function route(req, res) {
  const { method } = req;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (method === 'GET' && url.pathname === '/') return serveIndex(res);
  if (method === 'GET' && url.pathname === '/api/state') return handleState(res);
  if (method === 'POST' && url.pathname === '/api/start') return handleStart(req, res);
  if (method === 'POST' && url.pathname === '/api/stop') return handleStop(res);
  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIPv4();
  console.log(`local-pm listening`);
  console.log(`  local: http://localhost:${PORT}`);
  console.log(`  LAN:   http://${lanIp}:${PORT}`);
});
