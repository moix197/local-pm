import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const BASE_URL = process.env.LOCAL_PM_URL ?? 'http://localhost:7420';

function getToken() {
  if (process.env.LOCAL_PM_TOKEN) return process.env.LOCAL_PM_TOKEN;
  const tokenPath = path.join(repoRoot, 'token.local');
  if (!fs.existsSync(tokenPath)) {
    throw new Error('LOCAL_PM_TOKEN env not set and token.local not found');
  }
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

async function apiCall(method, apiPath, body) {
  const token = getToken();
  const res = await fetch(BASE_URL + apiPath, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`daemon returned ${res.status}: ${text}`);
  }
  return res.json();
}

function toResult(json) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }] };
}

function toError(err) {
  return { isError: true, content: [{ type: 'text', text: err.message }] };
}

const server = new McpServer({ name: 'local-pm', version: '0.1.0' });

server.tool('list_worktrees', 'List all git worktrees known to the daemon', {}, async () => {
  try {
    const state = await apiCall('GET', '/api/state');
    return toResult(state.worktrees);
  } catch (err) {
    return toError(err);
  }
});

server.tool('status', 'Get the current dev server status from the daemon', {}, async () => {
  try {
    const state = await apiCall('GET', '/api/state');
    return toResult(state.status);
  } catch (err) {
    return toError(err);
  }
});

server.tool(
  'start_server',
  'Start the dev server for a given worktree path',
  { path: z.string().describe('Absolute path to the worktree to start') },
  async ({ path: worktreePath }) => {
    try {
      const result = await apiCall('POST', '/api/start', { path: worktreePath });
      return toResult(result);
    } catch (err) {
      return toError(err);
    }
  },
);

server.tool('stop_server', 'Stop the currently running dev server', {}, async () => {
  try {
    const result = await apiCall('POST', '/api/stop');
    return toResult(result);
  } catch (err) {
    return toError(err);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
