# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module | Responsibility (one line) | Path | Related docs |
| ------ | ------------------------- | ---- | ------------ |
| server | HTTP + WS entry: routes `/` + `/api/*`, guards `/api/*` with bearer auth | `src/server.js` | [node-builtins-only](decisions/node-builtins-only.md) |
| runner | Per-target dev-server + ad-hoc command lifecycle (start/stop, install, logs) | `src/runner.js` | [windows-process-tree-kill](decisions/windows-process-tree-kill.md) |
| token | Generates/loads `token.local`; timing-safe bearer check for `/api/*` | `src/token.js` | [lan-bearer-token-auth](decisions/lan-bearer-token-auth.md) |
| config | Project store: atomic `projects.json` read/write + PATCH whitelist | `src/config.js` | — |
| detect | Classifies a folder as git-wt / docker / plain; sources devCmd from scripts | `src/detect.js` | — |

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |

> Empty scaffold. Add the first row when the first module lands. Update via the
> `sync-knowledge` skill — don't hand-edit drift in.
