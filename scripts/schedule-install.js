import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePath = process.execPath;
const serverPath = path.join(repoRoot, 'src', 'server.js');

// Delete any existing task first so install is idempotent (delete-then-create).
// Swallow the failure when the task doesn't exist yet (first install).
try {
  execFileSync('schtasks', ['/delete', '/tn', 'local-pm', '/f'], { stdio: 'pipe' });
} catch {
  // task not registered yet — nothing to delete
}

execFileSync(
  'schtasks',
  [
    '/create',
    '/tn',
    'local-pm',
    '/tr',
    `"${nodePath}" "${serverPath}"`,
    '/sc',
    'onlogon',
    '/rl',
    'limited',
    '/f',
  ],
  { stdio: 'inherit' }
);

console.log("Task 'local-pm' installed. It will run automatically at next log-on.");
console.log('Token is stored in token.local — start the server once first if you haven\'t already.');
