# Standalone, non-workspace MCP package

**Decision:** The MCP adapter (`mcp/`) is its own package with its own `package.json` (`@modelcontextprotocol/sdk` + `zod`), deliberately **not** a pnpm workspace member and sharing no code with the daemon. It holds zero state and forwards every tool call to the running daemon over HTTP `/api/*` using the same bearer token.

**Why:** Keeping `mcp/` separate keeps the daemon's dependency footprint at exactly `node-pty` + `ws` — the SDK and zod never enter the daemon's tree, so its install/audit/startup surface stays minimal even though most users never run the MCP adapter. Forwarding (rather than importing the service modules) keeps the **daemon as the single source of truth**: the adapter can't hold a divergent copy of state or spawn processes itself, so MCP and the dashboard always act through the same code path and auth check.

**Rejected:** A workspace package importing `runner`/`config` directly — rejected: it would either drag MCP-only deps into the daemon or fork the logic, and would let the adapter mutate process state out-of-band, breaking the single-source-of-truth guarantee. Bundling MCP into the daemon process — rejected: same dependency-bloat and coupling problem, for a feature that's optional.

**Constraints it creates:** The adapter must reach a running daemon (`LOCAL_PM_URL`, default `http://localhost:7420`) and present a valid token (`LOCAL_PM_TOKEN` env, else `token.local`); it has no fallback when the daemon is down. New MCP tools must be thin forwarders to a daemon endpoint, never local logic. `mcp/` deps must not be promoted into the daemon's `package.json`.
