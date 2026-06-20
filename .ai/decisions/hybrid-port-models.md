# git-wt targets keep their own fixed port instead of a pool-assigned one

**Decision:** `buildEnvForTarget` injects no `PORT`/`WS_PORT` for git-wt targets. They run on whatever port their own dev server chooses; local-pm observes the actual port from the dev-server's log output rather than assigning one from the 3100–3199 pool. Docker and plain targets, by contrast, get pool-assigned ports.

**Why:** git-wt projects register their dev URL (port/origin) as an OAuth redirect URI with an external identity provider. Redirect URIs are matched exactly, so the port cannot vary per worktree — overriding it with a pool port would break the OAuth callback. The fixed-port requirement is a constraint imposed *outside* this codebase (the provider's registered URIs), so it is not derivable from local-pm's source alone.

**Rejected:** Assigning a pool port to git-wt like the other types — rejected because it would change the redirect URI and break auth flows. (The docker per-compose-var and plain single-PORT branches are not a "decision" worth a record: they fall straight out of how compose ports and plain dev servers consume env, and are documented as mechanics in `architecture.md`.)

**Constraints it creates:** Port selection for git-wt is the dev server's / git-wt's own responsibility (it derives ports via offset + the worktree `.env`), not local-pm's pool — so local-pm must parse the actual port from log output for git-wt targets instead of knowing it up front, and must never inject a pool port that would override the OAuth-registered URL.
