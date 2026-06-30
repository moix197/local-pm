# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module | Responsibility (one line) | Path | Related docs |
| ------ | ------------------------- | ---- | ------------ |
| server | HTTP + WS entry: routes `/`, static `/vendor//js//css/*`, `/api/*`; guards only `/api/*` with bearer auth | `src/server.js` | [node-builtins-only](decisions/node-builtins-only.md) |
| runner | Per-target dev-server + ad-hoc command lifecycle (start/stop, install, logs) | `src/runner.js` | [windows-process-tree-kill](decisions/windows-process-tree-kill.md) |
| token | Generates/loads `token.local`; timing-safe bearer check for `/api/*` | `src/token.js` | [lan-bearer-token-auth](decisions/lan-bearer-token-auth.md) |
| config | Project store: atomic `projects.json` read/write + PATCH whitelist | `src/config.js` | — |
| detect | Classifies a folder as git-wt / docker / plain; sources devCmd from scripts | `src/detect.js` | — |
| ports | In-memory 3100–3199 port pool (assign/release) + type-dependent env build for spawn | `src/ports.js` | [hybrid-port-models](decisions/hybrid-port-models.md) |
| worktrees | Enumerates git worktrees per project (porcelain parse) with synthetic-root fallback | `src/worktrees.js` | — |
| pty | In-memory terminal sessions: spawn shell/claude PTY, scrollback ring, attach/detach, idle reaper | `src/pty.js` | — |
| ws | WS upgrade auth (query-token + origin allowlist) and terminal frame routing to pty sessions | `src/ws.js` | — |
| mcp | Standalone MCP stdio adapter: 4 tools forwarding to daemon `/api/*`; zero state | `mcp/index.js` | [standalone-mcp-package](decisions/standalone-mcp-package.md) |
| dashboard | Modular native-ESM browser UI (thin `index.html` shell + `js/*` + `css/`): 2s state poll, sidebar nav, selection-driven main pane, WS xterm terminals, desktop modal keyboard layer (`js/keynav/*`). Per-module map in `public/js/README.md`. | `public/index.html`, `public/js/`, `public/css/` | [frontend-native-esm-modules](decisions/frontend-native-esm-modules.md), [terminal-macros-localstorage](decisions/terminal-macros-localstorage.md), [terminal-session-reattach-localstorage](decisions/terminal-session-reattach-localstorage.md), [desktop-modal-keyboard-nav](decisions/desktop-modal-keyboard-nav.md), [quicknav-mru-localstorage](decisions/quicknav-mru-localstorage.md) |
| netinfo | Resolves the machine's primary external LAN IPv4 (fallback `127.0.0.1`) | `src/netinfo.js` | — |
| browse | Host folder browser for the UI: lists subdirs, flags project-looking folders, dir guard | `src/browse.js` | — |

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |

> Empty scaffold. Add the first row when the first module lands. Update via the
> `sync-knowledge` skill — don't hand-edit drift in.
