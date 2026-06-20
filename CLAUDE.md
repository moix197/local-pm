# CLAUDE.md — Project Context for Claude Code

## Communication

- When reporting information to me, be extremely concise and sacrifice grammar for sake of concision.

## Tooling

- **Package manager is pnpm.** Always use `pnpm` (not npm or yarn) for installing, running scripts, and managing dependencies.

## Subagents

- **Always delegate subtasks to subagents.** Any subtask — research, codebase exploration, file searches, multi-step investigation, or self-contained implementation work — must run in a subagent (via the Task/Agent tool), not inline in the main context. This keeps the main context clean and focused on coordination and decisions.
- **Main context coordinates, subagents do the legwork.** Reserve the main thread for synthesizing subagent results and making decisions; push the exploratory and verbose work down into subagents.
- **One subagent per discrete subtask.** Scope each subagent narrowly and have it return only the conclusion or artifact needed, not the raw intermediate output.

## Project Knowledge Base

- **The `.ai/` directory is the source of truth for project knowledge. Any new feature, architectural change, pattern, dependency, or important decision must update the relevant `.ai/` documentation before considering the work complete.
- **When working on changes, always consult the knowledge base first and keep it synchronized with the current codebase.

## Coding principles

- **Keep entry points thin.** Business logic lives in dedicated layers (services, helpers, hooks) — not inside routes, page components, or top-level entry points.
- **Reuse before reinvent.** Check existing helpers, utilities, and components before writing new code. Duplicating logic that already exists somewhere in the codebase is always wrong.
- **Inspect a similar existing implementation before introducing a new pattern.** Match what's already there.
- **When unsure, prefer consistency with the existing codebase over introducing new patterns or abstractions.**
- **Small focused functions.** Functions should do one thing. If a function exceeds ~30 lines, it's doing too much — break it into smaller named functions that describe what they do.
- **Separation of concerns.** Don't mix data fetching, transformation, validation, and side effects in the same function. Each step should be independently readable and ideally reusable.
- **Name functions after what they do, not how they do it.** `getActiveUser()`, not `processData()`. If you can't name it clearly, the function is probably doing too much.
- **Generic / reusable components accept callbacks only** — no business logic, no redirects, no DOM manipulation baked in.
- **Prefer minimal changes over large refactors.** Make the smallest change that solves the problem; don't tidy up surrounding code that wasn't part of the task.
- **Preserve existing behavior** unless explicitly asked to change it.

## Architecture

- **Modular by packages.** Organize the codebase as discrete packages, each owning a single, well-defined responsibility. Prefer splitting along clear boundaries (domain, feature, or layer) over a single monolithic tree.
- **Clear package boundaries.** Each package exposes a deliberate public API; keep internals private. Depend on a package's published surface, not its internal files.
- **No circular dependencies between packages.** Dependencies flow in one direction. If two packages need each other, extract the shared piece into its own package.
- **New code belongs in the package that owns its concern.** Place logic where its responsibility lives; create a new package when a responsibility doesn't fit any existing one.

- **Build our own before installing.** Prefer building our own solution over pulling in an external package. Reach for a dependency only when building it ourselves is clearly impractical (e.g. cryptography, deep protocol/spec implementations) — and when you do, justify why.
- **Minimize the dependency footprint.** Fewer external packages means less surface to maintain, audit, and break. Before adding a dependency, confirm nothing in our own packages already covers it.

## Change strategy

When implementing a feature:

1. **Prefer extending existing patterns over adding custom one-off logic.**
2. **Reuse existing helpers** before creating new ones.
3. **Reuse existing components** before creating new ones.
4. **Follow patterns already used in similar features.**
5. **Make minimal changes** rather than large refactors.
6. **Preserve existing behavior** unless explicitly asked to change it.
7. **Update documentation** alongside code changes — relevant READMEs should reflect new behavior, exported APIs, and notable additions.

## Style

- DRY: don't repeat logic; extract once it's used in more than one place with intent to reuse.
- Modularize as needed — split files and functions when responsibilities are mixing, not preemptively.
- No speculative abstractions — wait for the second or third use case before generalizing.
- No dead code, no commented-out code blocks left "just in case."
- No comments that restate what the code does; only comment the non-obvious _why_.
