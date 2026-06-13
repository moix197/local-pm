# local-pm

Lightweight local web dashboard to control a dev server per git worktree, one at a
time, accessible over the LAN. No web framework, only Node built-ins. Frontend is a
single static HTML page with vanilla JS — no build step.

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
  { "name": "web_template", "root": "C:/proyectos/web_template" }
]
```

If `projects.json` is missing it's created with the `web_template` default on first run.
Projects whose `root` doesn't exist are flagged and skipped.

## Limitations & assumptions

- **One server at a time.** Parallel servers are future roadmap.
- **Dev mode only.**
- Dev servers are assumed to serve on **port 3000** (the LAN link uses `:3000`).
- `docker compose down` is run on stop; its errors are ignored so worktrees without a
  compose file still stop cleanly.
- Windows-specific: uses `npm.cmd`, `taskkill`, and `shell: true` for `.cmd` resolution.
