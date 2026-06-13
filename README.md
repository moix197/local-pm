# local-pm

Lightweight local web dashboard to control a dev server per git worktree, one at a
time, accessible over the LAN. No web framework, only Node built-ins. Frontend is a
single static HTML page with vanilla JS — no build step.

## Works with git-wt

local-pm is the companion to **[git-wt](https://github.com/moix197/git-wt)** — a
cross-platform Git worktree manager. git-wt *creates and manages* the worktrees
(branching, per-worktree `.env`/port allocation, safe cleanup); local-pm *runs and
stops the dev server* for whichever worktree you're working in. Use git-wt to spin up
a worktree, then use local-pm to start/stop/switch its server from the browser.

## What it does

Automates, per worktree, what you'd otherwise do by hand:

1. Discovers git worktrees for each configured project (`git worktree list`).
2. **Start**: runs `npm install` first if `node_modules` is missing, then `npm run dev`
   in the worktree folder.
3. **Stop**: kills the dev server process tree (`taskkill /T /F`) and runs
   `docker compose down` in the worktree (errors ignored — fine for worktrees with no
   compose file).
4. Switching worktrees stops the current server before starting the new one.

Logs (last ~300 combined stdout/stderr lines) stream into the page.

## Requirements

- **Node.js v22+** (uses the built-in `node:test` runner and modern ESM features).
- pnpm.

## Run

```sh
pnpm start
```

Then open <http://localhost:7420>. On startup it prints the local and LAN URLs.

Override the port with `LOCAL_PM_PORT` (default `7420`).

## Reach from another LAN machine

Open `http://<desktop-ip>:7420` from any device on the same network — the dashboard
binds to `0.0.0.0`. The active dev server link points at `http://<desktop-ip>:3000`.

## Add projects

Edit `projects.json` at the repo root:

```json
[
  { "name": "my-project", "root": "C:/path/to/your/project" }
]
```

If `projects.json` is missing it's created with a generic placeholder on first run.
Projects whose `root` doesn't exist are flagged and skipped. If `projects.json`
contains invalid JSON, startup fails with a descriptive error
(`projects.json is not valid JSON: …`) rather than starting silently broken.

## Limitations & assumptions

- **One server at a time.** Parallel servers are future roadmap.
- **Dev mode only.**
- Dev servers are assumed to serve on **port 3000** (the LAN link uses `:3000`).
- `docker compose down` is run on stop; its errors are ignored so worktrees without a
  compose file still stop cleanly.
- Windows-specific: uses `npm.cmd`, `taskkill`, and `shell: true` for `.cmd` resolution.
