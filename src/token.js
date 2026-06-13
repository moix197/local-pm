import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultTokenFile = path.join(repoRoot, 'token.local');

/**
 * Resolve the current token: read `token.local` if present, otherwise generate a
 * 64-char hex token, write it, and flag it as newly created.
 * @param {string} [tokenFile] override path (defaults to repoRoot/token.local)
 * @returns {{ token: string, isNew: boolean }}
 */
export function ensureToken(tokenFile = defaultTokenFile) {
  if (fs.existsSync(tokenFile)) {
    return { token: fs.readFileSync(tokenFile, 'utf8').trim(), isNew: false };
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token + '\n', 'utf8');
  return { token, isNew: true };
}

/**
 * Read and trim the current token.
 * @param {string} [tokenFile] override path (defaults to repoRoot/token.local)
 * @returns {string} the trimmed token
 * @throws {Error} if the token file is absent
 */
export function readToken(tokenFile = defaultTokenFile) {
  if (!fs.existsSync(tokenFile)) {
    throw new Error('token.local not found — run the server once to generate it');
  }
  return fs.readFileSync(tokenFile, 'utf8').trim();
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
