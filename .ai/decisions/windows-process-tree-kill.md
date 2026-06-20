# Windows process-tree teardown

**Decision:** Dev servers and commands are spawned with `shell: true` (and `npm` rewritten to `npm.cmd` on Windows), and killed with `taskkill /PID <pid> /T /F`.

**Why:** With `shell: true` on Windows, `child.pid` is the shell (`cmd.exe`) PID, not the real dev server — the actual server is a grandchild. A plain `process.kill(pid)` would kill only the shell and orphan the server (which holds the port). `taskkill /T` kills the whole tree and `/F` forces it, so the port is actually released. `npm` must be invoked as `npm.cmd` because on Windows `npm` is a `.cmd` shim that only resolves through a shell; spawning bare `npm` without the shell fails with ENOENT.

**Rejected:** `process.kill` / `child.kill()` — only signals the direct child (the shell), leaving the server tree alive. Spawning bare `npm` without `shell:true` — not executable on Windows.

**Constraints it creates:** Caveat — a process that re-parents or double-forks past the tree `taskkill` walks can still linger; teardown is best-effort. The kill path is Windows-specific (`taskkill`); a cross-platform port would need a POSIX equivalent (e.g. process-group kill).
