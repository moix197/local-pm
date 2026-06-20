# Node built-ins only, no web framework

**Decision:** The daemon is built on Node built-ins (`http`, `crypto`, `os`, `net`, `child_process`) with no web framework (no Express/Fastify) and no build step. The only runtime deps are `node-pty` and `ws`, which solve problems built-ins genuinely can't.

**Why:** This is a single-user LAN tool with a tiny route table; a framework's routing/middleware buys nothing here and adds a dependency tree to audit and keep current. Skipping a build step means the source on disk is the running code — no transpile, no source maps, faster iteration. Matches the project rule "build our own before installing."

**Rejected:** A framework (Express et al.) — overkill for ~12 routes and a manual `if (method && pathname)` table reads fine. A bundler/TypeScript build — unnecessary indirection for a process you launch with `node`.

**Constraints it creates:** Reach for a dependency only when a built-in genuinely can't do the job (the bar `node-pty`/`ws` cleared). New endpoints extend the hand-rolled `route()` switch; don't introduce a router. Keep the no-build invariant — code must run directly under Node.
