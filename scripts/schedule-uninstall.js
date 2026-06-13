import { execFileSync } from 'node:child_process';

try {
  execFileSync('schtasks', ['/delete', '/tn', 'local-pm', '/f'], { stdio: 'inherit' });
} catch {
  console.log("Task 'local-pm' not found — nothing to remove.");
}
