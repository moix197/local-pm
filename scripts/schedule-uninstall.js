import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vbsPath = path.join(repoRoot, 'scripts', 'run-hidden.generated.vbs');

try {
  execFileSync('schtasks', ['/delete', '/tn', 'local-pm', '/f'], { stdio: 'inherit' });
} catch {
  console.log("Task 'local-pm' not found — nothing to remove.");
}

// Remove the generated hidden launcher if present.
try {
  if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
} catch {
  // ignore — leftover launcher is harmless
}
