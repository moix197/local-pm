# Terminal macros persist in browser localStorage, not server-side

**Decision:** User-defined terminal text macros (the `{label, text}` list behind the input toolbar's chips) live in the browser's `localStorage` under one key (`localpm.termMacros`), managed by the leaf module `public/js/term-macros.js`. No API endpoint, no `projects.json` entry, no daemon involvement.

**Why:** A zero-backend store ships the v1 toolbar without touching the daemon, its REST surface, or its persistence (`config`/`projects.json`) — the macros are a pure-frontend convenience, so keeping them frontend-only avoids new routes, auth surface, and a schema. The store is deliberately tolerant: corrupt/missing data reads back as an empty list, and disabled/full storage (Safari private mode, quota) is swallowed so a button handler never throws.

**Rejected:** Server-side persistence via a new `/api/*` endpoint writing `projects.json` (or a sibling file) — buys cross-device sync but adds a route, auth, and schema for a cosmetic feature, contradicting ship-fast v1. Per-group (per-worktree) macro lists — macros are workflow shortcuts (`y`/`n`/commit text), not project-scoped, so one global list is simpler and what users want.

**Constraints it creates:** Macros are per-device — they do **not** sync across browsers or machines (the known follow-up if cross-device sync is ever wanted; that would move the store server-side). `term-macros.js` must stay a leaf: no DOM, no imports of other app modules, so the import graph stays a DAG. Deletes are identity-based (match label+text), not index-based, so a concurrent edit can't remove the wrong entry.
