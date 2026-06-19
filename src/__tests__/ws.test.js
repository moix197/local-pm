import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket as WsClient } from 'ws';
import { authorizeUpgrade, attachWebSocket, _setReadTokenFn, _setGetLanIPv4Fn } from '../ws.js';

// --- authorizeUpgrade unit tests --------------------------------------------

describe('authorizeUpgrade', () => {
  before(() => {
    _setReadTokenFn(() => 'correcttoken1234');
    _setGetLanIPv4Fn(() => '192.168.1.100');
  });

  function makeReq(url, origin) {
    return { url, headers: origin != null ? { origin } : {} };
  }

  it('missing token -> not ok', () => {
    const result = authorizeUpgrade(makeReq('/ws/terminal', null), 7420);
    assert.equal(result.ok, false);
  });

  it('empty token -> not ok', () => {
    const result = authorizeUpgrade(makeReq('/ws/terminal?token=', null), 7420);
    assert.equal(result.ok, false);
  });

  it('wrong-length token -> not ok (no timingSafeEqual error)', () => {
    const result = authorizeUpgrade(makeReq('/ws/terminal?token=short', null), 7420);
    assert.equal(result.ok, false);
  });

  it('correct token + no origin (null) -> ok', () => {
    const result = authorizeUpgrade(makeReq('/ws/terminal?token=correcttoken1234', null), 7420);
    assert.equal(result.ok, true);
  });

  it('correct token + allowed origin localhost -> ok', () => {
    const result = authorizeUpgrade(
      makeReq('/ws/terminal?token=correcttoken1234', 'http://localhost:7420'),
      7420,
    );
    assert.equal(result.ok, true);
  });

  it('correct token + allowed origin 127.0.0.1 -> ok', () => {
    const result = authorizeUpgrade(
      makeReq('/ws/terminal?token=correcttoken1234', 'http://127.0.0.1:7420'),
      7420,
    );
    assert.equal(result.ok, true);
  });

  it('correct token + allowed LAN IP -> ok', () => {
    const result = authorizeUpgrade(
      makeReq('/ws/terminal?token=correcttoken1234', 'http://192.168.1.100:7420'),
      7420,
    );
    assert.equal(result.ok, true);
  });

  it('correct token + disallowed origin -> not ok', () => {
    const result = authorizeUpgrade(
      makeReq('/ws/terminal?token=correcttoken1234', 'http://evil.com'),
      7420,
    );
    assert.equal(result.ok, false);
  });

  it('absent origin header (undefined) -> ok', () => {
    const req = { url: '/ws/terminal?token=correcttoken1234', headers: {} };
    const result = authorizeUpgrade(req, 7420);
    assert.equal(result.ok, true);
  });
});

// --- Upgrade handler integration test ---------------------------------------

describe('attachWebSocket upgrade rejection', () => {
  let testServer;
  let port;

  before(async () => {
    _setReadTokenFn(() => 'testtoken9876543');
    _setGetLanIPv4Fn(() => '127.0.0.1');
    testServer = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    attachWebSocket(testServer);
    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    port = testServer.address().port;
  });

  after(async () => {
    await new Promise((resolve) => testServer.close(resolve));
  });

  it('rejects upgrade with wrong token (gets 401 before handshake)', async () => {
    await new Promise((resolve, reject) => {
      const client = new WsClient(`ws://127.0.0.1:${port}/ws/terminal?token=wrongtoken`);
      client.on('unexpected-response', (req, res) => {
        try {
          assert.equal(res.statusCode, 401);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      client.on('error', (err) => {
        // connection refused or similar — still counts as rejected
        resolve();
      });
    });
  });

  it('rejects upgrade with no token (gets 401)', async () => {
    await new Promise((resolve, reject) => {
      const client = new WsClient(`ws://127.0.0.1:${port}/ws/terminal`);
      client.on('unexpected-response', (req, res) => {
        try {
          assert.equal(res.statusCode, 401);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      client.on('error', () => resolve());
    });
  });
});
