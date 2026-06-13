# local-pm-mcp

A standalone stdio MCP adapter that exposes the local-pm daemon's guarded HTTP API as
Claude tools. It holds no state — a pure forwarding layer over the daemon's `/api/*`
routes. Kept as a standalone **non-workspace** package so the core daemon stays zero-dep.

## Install

First time (or after cloning):

```sh
cd mcp && pnpm install
```

To add/upgrade the SDK explicitly:

```sh
cd mcp && pnpm add @modelcontextprotocol/sdk
```

Pinned SDK: `@modelcontextprotocol/sdk@^1.29.0` (plus `zod` for input schemas).

## Run

```sh
node mcp/index.js
```

Starts a stdio MCP server. It does not listen on a port — Claude Code spawns it.

## Tools

| Tool | Params | Forwards to |
|---|---|---|
| `list_worktrees` | — | `GET /api/state` → `worktrees` |
| `status` | — | `GET /api/state` → `status` |
| `start_server` | `path` (string, absolute worktree path) | `POST /api/start` `{path}` |
| `stop_server` | — | `POST /api/stop` |

## Env vars

| Var | Default | Notes |
|---|---|---|
| `LOCAL_PM_URL` | `http://localhost:7420` | Base URL of the daemon. |
| `LOCAL_PM_TOKEN` | _(unset)_ | Optional. When unset, the adapter auto-reads `../token.local` (relative to `mcp/index.js`, i.e. the repo root). Set it only when the adapter and daemon run on **different machines**. |

## Failure behavior

If the daemon is unreachable, returns a non-2xx response, or no token can be resolved,
each tool returns a structured MCP error (`isError: true`) with a descriptive message.
The adapter never crashes — failures are always surfaced as MCP-level errors.

## Add to Claude Code

Register it locally (stored in `~/.claude.json`, not committed to a shared `.mcp.json`):

```sh
claude mcp add local-pm --scope local \
  --env LOCAL_PM_URL=http://localhost:7420 \
  -- node C:/path/to/local_pm/mcp/index.js
```

Or commit a project-scoped `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "local-pm": {
      "command": "node",
      "args": ["C:/path/to/local_pm/mcp/index.js"],
      "env": {
        "LOCAL_PM_URL": "http://localhost:7420"
      }
    }
  }
}
```

Replace `C:/path/to/local_pm` with the absolute path to your repo. The token is read from
`token.local` automatically; add `LOCAL_PM_TOKEN` to `env` only for a remote daemon.
