# Plan: Populate the `.ai/` Knowledge Base

**Created:** 2026-06-20
**Branch:** docs/ai-knowledge-base
**Status:** not started

## Context

Future agents currently answer codebase questions by grepping `src/` every research session, re-deriving the same structure each pass and burning tokens. The `.ai/` scaffold exists but ships empty (`index.md`, `architecture.md` are placeholders; `decisions/` and `patterns/` hold only `.gitkeep`).

This plan does the **initial population** of `.ai/` so an agent can answer a codebase question from `.ai/` alone — pulling only the one small file it needs via a reliable index router. The explicit driver is **token savings via granular addressing**: many small single-topic files + a trustworthy `index.md` that points to the exact file.

Scope is locked to **what actually exists in the code today**. ROADMAP vision and future plans are out of scope. `decisions/` captures only the non-obvious *why* behind code that genuinely exists, and only when the *why* could NOT be reconstructed by reading the code (the sync-knowledge answerability filter).

The codebase: a pnpm monorepo — root `local-pm` Node daemon (port 7420 family; serves dashboard + REST + WS) controlling dev servers across git worktrees, plus a standalone `mcp/` adapter. Node built-ins only (`http`, `crypto`, `os`, `net`, `child_process`), runtime deps `node-pty` + `ws` (daemon) and `@modelcontextprotocol/sdk` + `zod` (mcp). No web framework, no build step. Source lives in `src/` (verified: `src/server.js`, `src/runner.js`, `src/ports.js`, `src/worktrees.js`, `src/pty.js`, `src/ws.js`, `src/token.js`, `src/config.js`, `src/detect.js`, `src/netinfo.js`, `src/browse.js`, `public/index.html`, `mcp/index.js`).

## Risk: low

Documentation-only. No source files change, no behavior changes. The risk is *content* risk: docs that restate code (violating the anti-wiki rule) or assert things the source doesn't actually do. Every writing phase mitigates this by requiring the implementer to READ the actual source before writing, and the final phase is a cold-read acceptance gate.

## Dependencies & Risks

- **Format compatibility with `sync-knowledge`.** `.claude/skills/sync-knowledge/SKILL.md` owns the write-side contract going forward. The decision-record shape (`# Title`, `**Decision:**`, `**Why:**`, `**Rejected:**`, `**Constraints it creates:**`) and the index-row protocol are defined there. The formats this plan formalizes into `.ai/README.md` must stay compatible — do not invent a competing shape.
- **Answerability filter is the gate for `decisions/`.** Only document a *why* a competent reader could NOT reconstruct from the code. Candidate decisions are listed per slice, but each is *provisional* — the implementer reads the source and KEEPS ONLY the non-recoverable ones. Several candidates were assessed as recoverable during research and should likely be dropped (see each phase).
- **Plan must not assert doc content.** This plan deliberately does not pre-write the docs. Each phase instructs the implementer to read the actual source first, because the only source of truth is the code as it exists at execution time. Filenames were verified during research but the implementer re-confirms.
- **Source path is `src/`, not repo root.** All daemon modules live under `src/`. Index rows must use real paths.
- **Granularity vs. anti-wiki tension.** "One small file per discrete decision" must not become an excuse to manufacture decisions. If a candidate fails the answerability filter, it gets no file — coverage is measured by subsystem index rows + architecture data flow, not by decision count.
- **Delegate source-reading to subagents (CLAUDE.md).** The per-phase "READ the actual source" legwork and the Phase 5 cold-read run are subagent tasks: each phase's implementer dispatches a subagent to read the slice's source and return only the confirmed facts (route list, constant values, branch logic), keeping the orchestrator context clean. The orchestrator writes the docs from those returned facts.

## Phases

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Create a git worktree for this plan's branch. Always confirm worktree creation with the user before running.

**Steps:**

- [ ] Confirm branch name (`docs/ai-knowledge-base`) and base ref (`main`) with the user
- [ ] Run `git worktree add ../local_pm-ai-kb -b docs/ai-knowledge-base main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: Formalize the formats + lay down the router/architecture skeleton

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** A fresh reader opening `.ai/README.md` can see (a) the fixed `index.md` router-table column format, (b) the required `architecture.md` section headings, and (c) the minimal decision-file and pattern-file templates — and `.ai/index.md` + `.ai/architecture.md` already carry those exact headers/columns as empty skeletons ready to fill. Verifiable without any subsystem content existing yet.

**Allowed-exception justification (non-vertical infra prereq):** Per the format spec, at most one thin non-vertical phase is allowed for a pure prerequisite with no user-facing surface. This phase is exactly that: it pins the formats every later slice must conform to. Without a fixed router-table shape and arch heading set agreed up front, the three vertical slices would each invent their own layout and the index would not be a reliable router. This is the single allowed exception; every subsequent middle phase is a vertical, cold-read-testable slice.

**Commit message:** `docs(ai): formalize .ai formats and lay index/architecture skeleton`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `.ai/README.md` | Append a "Formats" section: the `index.md` router-table column spec (Module \| Responsibility \| Path \| Related docs — names per sync-knowledge), the required `architecture.md` section headings, and minimal decision-file + pattern-file templates. Keep each spec minimal; state explicitly that the decision template mirrors `sync-knowledge`'s shape. |
| modify | `.ai/index.md` | Replace the `_empty_` placeholder rows with the finalized router-table header (the agreed columns) and an empty body, ready for slice rows. Keep the existing intro + cross-cutting table convention. |
| modify | `.ai/architecture.md` | Replace placeholder prose under the three headings (System shape, Dependency direction, Data flow) with the finalized heading set as empty section stubs to be filled by slices. Do not write content yet. |

**Steps:**

- [x] Read `.ai/README.md`, `.ai/index.md`, `.ai/architecture.md` and `.claude/skills/sync-knowledge/SKILL.md` to lock the exact shapes to formalize.
- [x] In `.ai/README.md`, add a concise "Formats" section defining: (1) router-table columns `Module | Responsibility (one line) | Path | Related docs` (column names match sync-knowledge's index.md description: module → one-line responsibility → path → linked docs); (2) `architecture.md` required headings (`System shape`, `Dependency direction`, `Data flow`) and what each holds in one line; (3) a minimal `decisions/<slug>.md` template that is byte-compatible with sync-knowledge (`# Title`, `**Decision:**`, `**Why:**`, `**Rejected:**`, `**Constraints it creates:**`); (4) a minimal `patterns/<slug>.md` template (Pattern / When / Shape), noting patterns are added only on the 2nd real use.
- [x] Update `.ai/index.md` to carry the finalized router-table header with an empty body (preserve the existing "read first" intro and the cross-cutting table).
- [x] Update `.ai/architecture.md` to the finalized empty section stubs under the three headings.
- [x] Keep everything terse — no restating CLAUDE.md, no speculative format fields.

**Tests:**

No automated tests — justified because: pure README/docs change with explicit verification (format presence is checked structurally below). There is no executable logic to extract.

**Verification:**

- [x] `.ai/README.md` contains a Formats section that defines all four shapes (router columns, arch headings, decision template, pattern template), and the decision template matches the sync-knowledge field set verbatim.
- [x] `.ai/index.md` shows the agreed router-table columns with an empty body and no leftover `_empty_` placeholder.
- [x] `.ai/architecture.md` has the three required headings as empty stubs and no leftover placeholder prose.
- [x] No content has been written for any subsystem yet (this phase is skeleton-only).

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn (code-reviewer ran as subagent under /execute-prd)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session (N/A — reviewer ran as isolated subagent)
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file (only cosmetic nits, no changes required)
- [x] Tests for this phase written and passing — or no-tests justification accepted
- [x] Documentation updated (this phase IS documentation)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `docs(ai): formalize .ai formats and lay index/architecture skeleton`
- [x] Phase marked complete

---

### Phase 2: Slice A — Daemon backbone (server lifecycle + HTTP API/auth + configuration)

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** Given ONLY `.ai/`, an agent can answer: "Where is the HTTP API defined and how is `/api/*` authorized?" (routes to `src/server.js` + `src/token.js` via the index, with the auth flow in architecture data-flow), "Where does server start/stop live and what runs before a dev server spawns?" (routes to `src/runner.js`, npm-install-on-missing-node_modules), and "Why bearer-token auth on a LAN-only tool?" (a `decisions/` file gives the non-recoverable why). The backbone's index rows, its kept decision files, and its architecture content are all present and cold-read coherent.

**Commit message:** `docs(ai): document daemon backbone — lifecycle, API/auth, configuration`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `.ai/index.md` | Add router rows for: server/HTTP+WS entry (`src/server.js`), server lifecycle (`src/runner.js`), token auth (`src/token.js`), configuration store (`src/config.js`), project-type detection (`src/detect.js`). |
| modify | `.ai/architecture.md` | Fill the daemon portion of System shape (daemon owns dashboard+REST+WS; node-http only), Dependency direction (entry → services → store; one-way), and the request → auth → handler → runner/config data flow. |
| create | `.ai/decisions/node-builtins-only.md` | Why no web framework / Node built-ins only — if non-recoverable after reading source. |
| create | `.ai/decisions/lan-bearer-token-auth.md` | Why bearer token + timing-safe compare on a LAN-only tool. |
| create | `.ai/decisions/windows-process-tree-kill.md` | Why `taskkill /T /F` (and `shell:true` / `npm.cmd`) for Windows process-tree teardown. |
| create | `.ai/decisions/log-ring-buffer-300.md` | Why the log buffer is capped at 300 lines (only if the specific sizing is judged non-recoverable; otherwise drop). |

**Steps:**

- [x] READ the actual source before writing anything: `src/server.js`, `src/runner.js`, `src/token.js`, `src/config.js`, `src/detect.js`. Confirm route list, the `/api/*` auth guard, `ensureToken()`/`token.local` origin, the `LOG_LIMIT` value, the npm-install prereq, docker compose down + `COMPOSE_PROJECT_NAME`, and the per-target `inProgress` collision maps.
- [x] Add the index router rows for the backbone modules using real `src/` paths and one-line responsibilities; link each row to any decision file kept for it.
- [x] Fill the daemon portion of `architecture.md` under the three headings: System shape (daemon process, no framework, no build), Dependency direction (server entry depends on services `runner`/`config`/`token`; services don't depend on the entry; one-way), Data flow (incoming request → `/api/*` bearer check → route handler → runner/config side effects; log fetch is lazy/on-demand).
- [x] Apply the answerability filter to each candidate decision and write ONLY the non-recoverable ones, using the formalized template:
  - `node-builtins-only` — keep (why-not-a-framework is a context choice, not in code).
  - `lan-bearer-token-auth` — keep (why auth at all on LAN + why timing-safe for a short token is not self-evident).
  - `windows-process-tree-kill` — keep (why `/T /F`, the `shell:true`+`npm.cmd` swap, and the lingering-grandchild caveat need Windows-process knowledge).
  - `log-ring-buffer-300` — keep only if the exact 300 sizing has a non-recoverable rationale; if it reads as an arbitrary hardcoded constant with no defensible *why*, DROP it (do not manufacture a decision).
  - Research also flagged "per-target inProgress guards" and "memoized token cache / query-token-for-WS" as candidates — include a decision file only if, after reading the code, the *why* is genuinely non-recoverable; otherwise leave them out.
  - _Execution result: KEPT `node-builtins-only`, `lan-bearer-token-auth`, `windows-process-tree-kill`. DROPPED `log-ring-buffer-300` (bare constant, no defensible why), `inProgress guards` and `token cache` (code comments already explain — recoverable)._
- [x] Keep every file terse and single-topic. No code restatement.

**Tests:**

No automated tests — justified because: pure docs change. Correctness is verified by structural checks now and by the Phase N cold-read acceptance gate.

**Verification:**

- [x] `index.md` has a row for each backbone module (`server.js`, `runner.js`, `token.js`, `config.js`, `detect.js`) and every path resolves to a real file.
- [x] `architecture.md` daemon content under all three headings is filled and internally consistent (no contradicting the source read in step 1).
- [x] Each created `decisions/` file follows the formalized template and passes the answerability filter (a reviewer agrees the *why* is not recoverable from code).
- [x] Cold-read smoke: a reader given only `.ai/` can name the file holding the API routes and the file holding the auth check, and can cite the lifecycle prerequisite (npm install when `node_modules` absent).

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn (code-reviewer ran as subagent under /execute-prd)
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session (N/A — reviewer ran as isolated subagent)
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file (trimmed anti-wiki nit in windows-process-tree-kill.md)
- [x] Tests for this phase written and passing — or no-tests justification accepted
- [x] Documentation updated (this phase IS documentation)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `docs(ai): document daemon backbone — lifecycle, API/auth, configuration`
- [x] Phase marked complete

---

### Phase 3: Slice B — Worktree & port management

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** Given ONLY `.ai/`, an agent can answer: "Where does port allocation live and what is the pool range?" (routes to `src/ports.js`, 3100–3199), "How does the system decide which port model a project uses?" (git-wt vs docker vs plain, via `src/worktrees.js`/`src/detect.js`), and "Why does git-wt skip PORT injection?" (a decision file gives the non-recoverable why, or architecture explains it if recoverable). This slice is cold-read testable on its own.

**Commit message:** `docs(ai): document worktree discovery and hybrid port management`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `.ai/index.md` | Add router rows for port pool/env injection (`src/ports.js`) and worktree discovery (`src/worktrees.js`). |
| modify | `.ai/architecture.md` | Extend Data flow with the worktree-listing + port-assignment + env-injection path; note the in-memory (non-persistent) pool in System shape if it affects the boundary picture. |
| create | `.ai/decisions/hybrid-port-models.md` | Why three port models (git-wt no-injection / docker per-compose-var / plain single PORT) and why git-wt observes its port from logs instead of assigning — if non-recoverable. |
| create | `.ai/decisions/port-pool-3100-3199.md` | Why the pool is exactly 3100–3199 — only if non-recoverable; otherwise drop. |

**Steps:**

- [ ] READ the actual source first: `src/ports.js`, `src/worktrees.js`, and re-check `src/detect.js` for the type markers. Confirm the 3100–3199 range, `assignPort`/`releasePort` with composite `${path}:${varName}` keys, `buildEnvForTarget` branching by type, `COMPOSE_PROJECT_NAME` slugging, the `git worktree list --porcelain` parse, and the synthetic-root fallback row.
- [ ] Add index router rows for `ports.js` and `worktrees.js` with real paths and terse responsibilities; link to kept decision files.
- [ ] Extend `architecture.md` Data flow: project → worktree enumeration (porcelain parse or synthetic root) → per-target env build (type-dependent) → ports allocated from the in-memory pool → injected into the spawn env. Note pool is process-memory only (lost on restart) if it clarifies the boundary.
- [ ] Apply the answerability filter:
  - `hybrid-port-models` — likely KEEP only the genuinely non-recoverable kernel (e.g., *why* git-wt must keep its own fixed port — OAuth/redirect-URI constraint that the code does not state). Research judged much of the docker/plain branching as recoverable from code+tests; document only the non-recoverable why, and let `architecture.md` carry the recoverable mechanics. If nothing survives the filter, DROP the file and cover the mechanics in architecture only.
  - `port-pool-3100-3199` — KEEP only if a non-arbitrary rationale exists; research found no rationale in code. If it's an undocumented arbitrary choice, DROP rather than invent one.
- [ ] Keep files single-topic and terse.

**Tests:**

No automated tests — justified because: pure docs change. Verified structurally and by the final cold-read gate.

**Verification:**

- [ ] `index.md` has rows for `ports.js` and `worktrees.js`; paths resolve.
- [ ] `architecture.md` Data flow now traces worktree listing → env build → port assignment → spawn env, consistent with the source.
- [ ] Any kept `decisions/` file passes the answerability filter; no manufactured rationale for the pool range.
- [ ] Cold-read smoke: a reader given only `.ai/` answers "where is port allocation + what's the range" and "what selects the port model" with correct file pointers.

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing — or no-tests justification accepted
- [ ] Documentation updated (this phase IS documentation)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `docs(ai): document worktree discovery and hybrid port management`
- [ ] Phase marked complete

---

### Phase 4: Slice C — Process execution (PTY/WS) + MCP adapter + dashboard + network/discovery

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** Given ONLY `.ai/`, an agent can answer: "How does a browser reattach to a running terminal?" (routes to `src/pty.js` scrollback + `src/ws.js` upgrade; session outlives the WS), "What does the MCP adapter expose and where does its token come from?" (routes to `mcp/index.js`; `LOCAL_PM_TOKEN` env then `token.local`), and "Why is `mcp/` a standalone package?" (a decision file gives the non-recoverable why). Dashboard polling and LAN/browse rows are present. Cold-read testable on its own.

**Commit message:** `docs(ai): document PTY/WS terminals, MCP adapter, dashboard, network`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `.ai/index.md` | Add router rows for: PTY sessions (`src/pty.js`), WS protocol/auth (`src/ws.js`), MCP adapter (`mcp/index.js`), dashboard frontend (`public/index.html`), LAN info (`src/netinfo.js`), file browse (`src/browse.js`). |
| modify | `.ai/architecture.md` | Extend System shape with the standalone `mcp/` package boundary (separate deps, forwards to daemon) and the browser↔daemon WS/poll surface; extend Data flow with the terminal attach/detach/reattach + scrollback replay path. |
| create | `.ai/decisions/standalone-mcp-package.md` | Why `mcp/` is a separate non-workspace package (keep daemon zero-extra-dep) — non-recoverable. |
| create | `.ai/decisions/node-pty-over-child-process.md` | Why node-pty/ConPTY over plain `child_process` — only if non-recoverable; research judged this largely recoverable, so likely DROP or fold into architecture. |
| create | `.ai/decisions/mcp-zero-state-forwarding.md` | Why the MCP adapter holds zero state and never crashes — only if the *why* is non-recoverable; otherwise cover in architecture. |

**Steps:**

- [ ] READ the actual source first: `src/pty.js`, `src/ws.js`, `mcp/index.js`, `public/index.html`, `src/netinfo.js`, `src/browse.js`. Confirm the scrollback ring sizing + replay-on-attach, idle reaper timeout, WS query-token auth + origin allowlist (with `netinfo`), the four MCP tools + token resolution order + never-crash wrapping, the 2s dashboard polling + WS terminal connection, and the browse project-detection heuristic + directory guard.
- [ ] Add index router rows for all six modules with real paths and terse responsibilities; link to kept decision files.
- [ ] Extend `architecture.md`: System shape gains the `mcp/` standalone boundary (own `package.json`, SDK+zod deps, no shared package, forwards to daemon `/api/*`) and the dashboard surface; Data flow gains terminal lifecycle (spawn → scrollback always appended → client attach replays scrollback → detach keeps PTY alive → idle reaper).
- [ ] Apply the answerability filter:
  - `standalone-mcp-package` — KEEP (dependency-isolation intent is not visible from the package split alone).
  - `node-pty-over-child-process` — DROP unless reading the code leaves a non-recoverable why; research found the native-PTY requirement is explained by code/comments. If dropped, state the rationale briefly in architecture's System shape instead.
  - `mcp-zero-state-forwarding` — KEEP only the non-recoverable kernel (daemon as single source of truth); if it reads as obvious from the forwarding code, DROP and cover in architecture.
  - Do NOT add `patterns/` files unless a pattern has a genuine 2nd real use in-repo (e.g., the WS query-token auth or the backpressure/high-water guard appearing on both server and client). Only then add one `patterns/<slug>.md`; otherwise add none.
- [ ] Keep files single-topic and terse.

**Tests:**

No automated tests — justified because: pure docs change. Verified structurally and by the final cold-read gate.

**Verification:**

- [ ] `index.md` has rows for `pty.js`, `ws.js`, `mcp/index.js`, `public/index.html`, `netinfo.js`, `browse.js`; all paths resolve.
- [ ] `architecture.md` shows the standalone `mcp/` boundary and the terminal attach/detach/reattach data flow.
- [ ] Kept `decisions/` files pass the answerability filter; dropped candidates are reflected in architecture instead of fabricated as decisions.
- [ ] Cold-read smoke: a reader given only `.ai/` answers terminal-reattach, MCP-token-source, and standalone-mcp-why with correct pointers.

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing — or no-tests justification accepted
- [ ] Documentation updated (this phase IS documentation)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `docs(ai): document PTY/WS terminals, MCP adapter, dashboard, network`
- [ ] Phase marked complete

---

### Phase 5: Final Verification — cold-read acceptance + coverage gate

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- Every subsystem from the inventory appears in `.ai/index.md` with a valid, resolvable path (coverage gate).
- `.ai/architecture.md` has all three headings filled and traces the daemon request flow + worktree/port flow + terminal flow without contradicting the source.
- A fresh subagent given access to `.ai/` ONLY (no grep, no `src/` reads) correctly answers ~5 representative questions with correct file pointers (cold-read acceptance gate).
- Every `decisions/` file present passes the answerability filter; no file restates code; no fabricated rationale.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] **Coverage check:** confirm each subsystem has an `index.md` row with a path that resolves on disk: `server.js`, `runner.js`, `token.js`, `config.js`, `detect.js`, `ports.js`, `worktrees.js`, `pty.js`, `ws.js`, `mcp/index.js`, `public/index.html`, `netinfo.js`, `browse.js`. No row points at a missing path.
- [ ] **Cold-read acceptance:** spawn a subagent restricted to reading `.ai/` ONLY (explicitly forbid grep/source reads) and pose ~5 representative questions spanning the required mix:
  - index routing: "Which file defines the HTTP API routes, and which enforces auth?"
  - index routing: "Where does terminal scrollback live and where is the WS upgrade authorized?"
  - decision why: "Why bearer-token auth on a LAN-only tool?" (or another kept decision)
  - decision why: "Why is `mcp/` a standalone package?"
  - architecture data flow: "Trace what happens from `POST /api/start` to a dev server process running, including the port-injection step."
- [ ] Any question the subagent answers wrong or with a bad pointer → fix the offending `.ai/` doc, then re-run that question.
- [ ] **Anti-wiki pass:** re-read every created file; delete or tighten anything that merely restates code.
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire `.ai/` change end-to-end (coverage + answerability + anti-wiki + sync-knowledge compatibility)
- [ ] Any changes made in response to the final code-reviewer review have been reflected back into this plan file
- [ ] All tests pass (`pnpm test` — confirm the docs change broke nothing; expected: unchanged green)
- [ ] No CLAUDE.md invariants violated (terse, single-topic, no dead/restating content, formats compatible with sync-knowledge)
- [ ] Feature tested manually (the cold-read subagent run IS the golden-path test; edge case: ask one question whose answer is intentionally NOT in `.ai/` and confirm the docs don't falsely claim coverage)
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked

## Documentation

This plan's entire product is documentation, so "documentation location" is the `.ai/` tree itself.

| Change | Documentation location |
| ------ | ---------------------- |
| Formalized formats (router columns, arch headings, templates) | `.ai/README.md` |
| Subsystem map / router | `.ai/index.md` |
| System shape, dependency direction, data flow | `.ai/architecture.md` |
| Non-obvious whys that survive the answerability filter | `.ai/decisions/*.md` |
| Reusable patterns (only on 2nd real use) | `.ai/patterns/*.md` |

## Knowledge Base Impact

This plan's whole product IS the `.ai/` knowledge base. Every artifact below is created or extended by this plan. Decision files are *provisional* — kept only if they survive the answerability filter during execution.

| `.ai/` artifact | Action | What it captures |
| --------------- | ------ | ---------------- |
| `README.md` | update | The formalized index-router columns, required architecture headings, and minimal decision/pattern templates (sync-knowledge-compatible) |
| `index.md` | update | Router rows for all 13 subsystem files → one-line responsibility → real `src/`/`mcp/`/`public/` path → linked docs |
| `architecture.md` | update | System shape (daemon + standalone mcp, no framework, no build), dependency direction (entry → services → store, one-way), data flow (request→auth→handler→runner/config; worktree→port→spawn env; terminal attach/detach/reattach) |
| `decisions/node-builtins-only.md` | create (provisional) | Why no web framework / built-ins only |
| `decisions/lan-bearer-token-auth.md` | create (provisional) | Why bearer + timing-safe compare on a LAN tool |
| `decisions/windows-process-tree-kill.md` | create (provisional) | Why `taskkill /T /F` + `shell:true`/`npm.cmd` |
| `decisions/log-ring-buffer-300.md` | create (provisional) | Why 300-line log cap — drop if arbitrary |
| `decisions/hybrid-port-models.md` | create (provisional) | Why git-wt/docker/plain port strategies differ |
| `decisions/port-pool-3100-3199.md` | create (provisional) | Why the pool range — drop if arbitrary |
| `decisions/standalone-mcp-package.md` | create (provisional) | Why `mcp/` is a separate non-workspace package |
| `decisions/node-pty-over-child-process.md` | create (provisional) | Why node-pty over child_process — likely drop (recoverable) |
| `decisions/mcp-zero-state-forwarding.md` | create (provisional) | Why MCP holds zero state — keep only non-recoverable kernel |
| `patterns/*.md` | create (conditional) | Only if a pattern has a real 2nd use in-repo (e.g., WS query-token auth, backpressure high-water guard) |

`execute-prd` will run `sync-knowledge` at closeout; since this plan *is* the initial population, that closeout step should mainly confirm compatibility and retire nothing.

## Tests

This plan introduces no executable logic — it writes Markdown into `.ai/`. There is nothing to unit-test; correctness is structural (paths resolve, formats match) and behavioral via the cold-read acceptance gate.

| Phase | Logic under test | Test file |
| ----- | ---------------- | --------- |
| Phase 1 | None — pure format/skeleton docs | N/A (justified: docs only; structural verification in-phase) |
| Phase 2 | None — pure docs | N/A (justified: docs only; cold-read gate in Phase 5) |
| Phase 3 | None — pure docs | N/A (justified: docs only; cold-read gate in Phase 5) |
| Phase 4 | None — pure docs | N/A (justified: docs only; cold-read gate in Phase 5) |
| Phase 5 | Cold-read acceptance + coverage (manual subagent run, not automatable) | N/A (justified: acceptance is a subagent cold-read, not a code path) |

Note: `pnpm test` is still run in Phase 5 to confirm the docs change leaves the existing daemon test suite green (it should be untouched).

## Human Summary

**What & why:** We're filling the project's empty `.ai/` knowledge base so future AI agents stop re-reading `src/` every session to answer the same structural questions. The point is token savings: lots of small single-topic files plus a reliable `index.md` router, so an agent grabs just the one file it needs.

**How the phases connect:**
- **Phase 1** is a thin setup step (the one allowed non-vertical phase): it pins down the formats — the index table columns, the architecture headings, and the decision/pattern templates — and writes empty skeletons. Everything after conforms to these.
- **Phases 2–4** are three vertical slices, each landing a working chunk of the knowledge base that can be cold-read on its own: (A) the daemon backbone — server, API/auth, config; (B) worktree & port management; (C) terminals, the MCP adapter, the dashboard, and networking. Each slice adds its index rows, its real architecture content, and only the decision files whose *why* genuinely can't be reconstructed from the code.
- **Phase 5** is the acceptance gate: a fresh agent is given ONLY `.ai/` and must answer ~5 representative questions correctly, and every subsystem must have a valid index row. Anything that fails gets fixed.

**End result:** A small, decision-oriented `.ai/` tree where an agent can route from `index.md` to the exact file, read the *why* behind non-obvious choices, and trace the main data flows — without grepping source.

**Key trade-offs/decisions made in planning:**
- **Strictly code-as-it-exists, no roadmap vision.** Future plans are out of scope.
- **Answerability filter is ruthless.** Many candidate "decisions" were judged recoverable from code during research (e.g., node-pty necessity, most port-model mechanics) and are flagged to DROP rather than written — coverage is measured by index rows + architecture, not decision count. We refuse to manufacture a rationale for arbitrary constants (300-line buffer, 3100–3199 range) just to have a file.
- **Formats stay compatible with `sync-knowledge`**, which owns `.ai/` maintenance going forward — this plan is only the initial population.
- **No source code changes**, so the only real risk is content quality, which the cold-read gate is designed to catch.
