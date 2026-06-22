# Quick-nav MRU order persists in browser localStorage, not server-side

**Decision:** The quick-nav palette's most-recently-used worktree ordering persists in the browser's `localStorage` under one key, managed by the leaf module `public/js/keynav/mru.js`. No API endpoint, no `projects.json` entry, no daemon involvement. This follows the same frontend-only-localStorage-leaf pattern as [terminal-macros-localstorage](terminal-macros-localstorage.md) — see that record for the shared rationale (zero-backend convenience, tolerant reads, leaf-module DAG discipline); only the MRU-specific points are below.

**Why:** MRU order is a per-device convenience for ranking the palette's empty-query list — it ranks no business data and needs no cross-device sync, so a route + auth + schema would be cost with no benefit, exactly as with macros. Stored paths are reconciled against live state on open: MRU entries whose worktree path no longer exists (e.g. after a project removal) are filtered out, so a stale path never surfaces as a jump target.

**Rejected:** Server-side persistence via a new `/api/*` endpoint — same trade-off rejected for macros (a route/auth/schema for a cosmetic, per-device feature). Reusing the macros key/module — different data shape (ordered path list vs `{label,text}` list) and lifecycle (records on jump, prunes stale paths), so a sibling leaf is cleaner than overloading `term-macros.js`.

**Constraints it creates:** MRU order is per-device — it does not sync across browsers or machines. `mru.js` must stay a leaf (no DOM, no app imports) so the import graph stays a DAG, and must mirror the macros store's tolerance: corrupt/missing data → empty list, quota/disabled-storage writes swallowed so a jump handler never throws.
