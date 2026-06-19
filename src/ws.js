import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { readToken } from './token.js';
import { getLanIPv4 } from './netinfo.js';
import { spawnSession, writeToSession, resizeSession, killSession } from './pty.js';

const PORT = Number(process.env.LOCAL_PM_PORT) || 7420;
const HIGH_WATER = 1 << 20; // 1MB

// Injectable seams for tests
let _readToken = readToken;
export function _setReadTokenFn(fn) { _readToken = fn; }

let _getLanIPv4Fn = getLanIPv4;
export function _setGetLanIPv4Fn(fn) { _getLanIPv4Fn = fn; }

/**
 * Check the WS upgrade request for a valid token and allowed origin.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port
 * @returns {{ok:boolean, reason?:string}}
 */
export function authorizeUpgrade(req, port) {
  // Parse token from query string — never log the URL
  let token;
  try {
    const url = new URL(req.url, 'http://x');
    token = url.searchParams.get('token') ?? '';
  } catch {
    return { ok: false, reason: 'malformed url' };
  }

  if (!token) return { ok: false, reason: 'missing token' };

  let expected;
  try {
    expected = _readToken();
  } catch {
    return { ok: false, reason: 'token not configured' };
  }

  const providedBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: 'invalid token' };
  }
  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'invalid token' };
  }

  // Origin allowlist
  const origin = req.headers.origin;
  if (origin != null) {
    const allowed = [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://${_getLanIPv4Fn()}:${port}`,
    ];
    if (!allowed.includes(origin)) {
      return { ok: false, reason: 'origin not allowed' };
    }
  }

  return { ok: true };
}

/**
 * Attach the WebSocket server to an existing HTTP server.
 * @param {import('node:http').Server} server
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on('upgrade', (req, socket, head) => {
    const result = authorizeUpgrade(req, PORT);
    if (!result.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      ws.close(4403, 'malformed url');
      return;
    }

    const worktreePath = url.searchParams.get('worktreePath') ?? '';
    const kind = url.searchParams.get('kind') ?? 'shell';
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    // Log only the pathname, never full URL/query
    const pathname = url.pathname;

    spawnSession({ worktreePath, kind, cols, rows })
      .then((session) => {
        const { id, ptyProcess } = session;

        ptyProcess.onData((data) => {
          if (ws.readyState === ws.constructor.OPEN && ws.bufferedAmount < HIGH_WATER) {
            ws.send(data);
          }
        });

        ws.on('message', (data) => {
          try {
            const str = data.toString();
            let parsed;
            try { parsed = JSON.parse(str); } catch { parsed = null; }
            if (parsed && parsed.resize && typeof parsed.resize === 'object') {
              const c = Number(parsed.resize.cols);
              const r = Number(parsed.resize.rows);
              if (Number.isFinite(c) && Number.isFinite(r) && c > 0 && r > 0) {
                resizeSession(id, c, r);
              }
            } else {
              writeToSession(id, str);
            }
          } catch {
            // malformed frame must never throw out of handler
          }
        });

        ws.on('close', () => {
          killSession(id);
        });

        console.log(`[ws] ${pathname} session started`);
      })
      .catch((err) => {
        const code = err.code === 4429 ? 4429 : 4403;
        ws.close(code, err.message ?? 'session error');
        console.log(`[ws] ${pathname} session rejected: ${err.message}`);
      });
  });
}
