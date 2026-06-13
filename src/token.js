import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultTokenFile = path.join(repoRoot, 'token.local');

// Memoized token for the default file so the `/api/*` auth hot path avoids a sync
// disk read per request. Only the default path is cached; injectable override paths
// (used by tests) always read fresh.
let cachedToken = null;

/**
 * Resolve the current token: read `token.local` if present, otherwise generate a
 * 64-char hex token, write it, and flag it as newly created.
 * @param {string} [tokenFile] override path (defaults to repoRoot/token.local)
 * @returns {{ token: string, isNew: boolean }}
 */
export function ensureToken(tokenFile = defaultTokenFile) {
  if (fs.existsSync(tokenFile)) {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (tokenFile === defaultTokenFile) cachedToken = token;
    return { token, isNew: false };
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token + '\n', 'utf8');
  if (tokenFile === defaultTokenFile) cachedToken = token;
  return { token, isNew: true };
}

/**
 * Read and trim the current token. The default token file is memoized after the
 * first read; override paths are always read fresh.
 * @param {string} [tokenFile] override path (defaults to repoRoot/token.local)
 * @returns {string} the trimmed token
 * @throws {Error} if the token file is absent
 */
export function readToken(tokenFile = defaultTokenFile) {
  if (tokenFile === defaultTokenFile && cachedToken !== null) return cachedToken;
  if (!fs.existsSync(tokenFile)) {
    throw new Error('token.local not found — run the server once to generate it');
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (tokenFile === defaultTokenFile) cachedToken = token;
  return token;
}

/**
 * Check the request's `Authorization: Bearer <token>` header against the stored token
 * using a constant-time comparison. Returns false for missing/malformed headers and
 * short-circuits on length mismatch before calling `timingSafeEqual`.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isAuthorized(req) {
  const header = req.headers?.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(readToken());
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
