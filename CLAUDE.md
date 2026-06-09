# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun monorepo. All commands run from the repo root.

```bash
bun install                       # one-time setup

bun dev                           # server :7878 + Vite SPA :5173 in parallel
bun dev:server                    # server only
bun dev:web                       # SPA only

bun --filter '*' typecheck        # all 7 workspaces
bun --filter '*' test             # all workspaces
bun --filter @keelson/server test # one workspace
bun test apps/server/test/memory-store.test.ts  # one file
bun run check                     # Biome lint + format (required pre-PR)
bun run check:fix                 # auto-fix safe lint/format

# CLI from workspace bin (or `alias keelson="bun $(pwd)/apps/cli/bin/keelson.ts"`):
bun apps/cli/bin/keelson.ts doctor
bun apps/cli/bin/keelson.ts workflow run smoke-test --watch
```

`CONTRIBUTING.md` mandates `bun run check`, `bun --filter '*' typecheck`, and `bun --filter '*' test` all green before opening a PR.

## Architecture

Keelson is a **local-only agent harness**, not a hosted service. The harness is the deliverable; capabilities live in **ribs** (extensions) bolted on via a typed contract.

- `apps/cli/` — `keelson` CLI. Commands (`workflow run`, `chat`, `doctor`) route to the server over HTTP/WS when it's up, and fall back to in-process execution (`apps/cli/src/in-process/`) when it's down. Stable exit codes: `0` success, `1` failure, `2` bad args, `3` server required but down, `4` not found.
- `apps/server/` — Bun HTTP/WS server (`:7878`). Owns the SQLite store, keytar credentials, redaction pipeline, chat/memory/workflow/snapshot handlers, and the `bootstrapRibs()` composition root in `src/index.ts`.
- `apps/web/` — React 19 + Vite SPA (`:5173`) — Chat and Workflows surfaces. `/api` is proxied to the server.
- `packages/shared/` — public types. The `Rib` interface (`src/rib.ts`) is the extension contract; `SnapshotManager`/`SnapshotFrame` (`src/snapshots.ts`) is the generic streaming substrate ribs plug into.
- `packages/workflows/` — DAG executor + YAML schema. Concepts borrowed from [Archon](https://github.com/coleam00/Archon) (MIT); the loader (`src/loader.ts`) is intentionally lenient — unknown fields warn rather than hard-error. Node taxonomy: `prompt` / `bash` / `command` / `loop` / `script` / `approval` / `cancel` / `subprocess`.
- `packages/providers/` — pluggable coding-agent SDKs behind `IAgentProvider` (Copilot, Claude, stub).
- `.keelson/` — runtime data home: `keelson.db` (SQLite), `workflows/`, `commands/`.

**Rib activation is discovery-based.** No in-tree ribs ship. `bootstrapRibs()` discovers installed `@keelson/rib-*` packages from `node_modules/@keelson/` at boot (`apps/server/src/rib-discovery.ts`); `bun add @keelson/rib-osdu` is enough to wire one in. `KEELSON_RIBS=<id1>,<id2>` filters which discovered ribs activate (unset = all). Embedders can bypass discovery by handing `bootstrapRibs({ available: { id: rib } })` an explicit map — the path tests use.

**State.** SQLite (sessions, runs, node outputs, memory rows) + keytar (credentials). Schema migrations live in `apps/server/src/db/migrations.ts`; `keelson doctor` checks `schema_version` matches.

**Provider/tool determinism.** `KEELSON_WORKFLOW_PROVIDER` pins the provider workflows use for `prompt` nodes; `KEELSON_WORKFLOW_TOOL_DENYLIST` is an operator floor for per-node tool filtering. `KEELSON_USE_STUBS=1` is a test-only env var (CI + bun test setup) — no production code reads it.

## Comments

Comments live in source long after the PR that motivated them merges. Default to **none**. Only add a comment when it captures non-obvious **why** a future reader would need — a hidden constraint, a workaround for a specific bug, a non-obvious order dependency, an invariant from another module.

- **No multi-paragraph blocks or bulleted `/* */` explanations.** A single sentence soft-wrapped over two lines is fine; the rule targets verbose narration, not line count.
- **No PR-point-in-time narration.** No "Codex flagged X, so we Y" / "Per CodeRabbit review…" / "Addresses #N" / "M5 wire shape evolved to…" — that content belongs in the commit message or PR body, not in source.
- **No what-just-changed notes.** If a comment explains what this PR is doing, delete it and put it in the PR description.
- **No restating the code.** Well-named identifiers do that; a comment that paraphrases the next line is noise.

`CONTRIBUTING.md` is the authoritative version of this rule. `.coderabbit.yaml` disables CodeRabbit's docstring-coverage check to keep the policy consistent — don't re-enable it.

## Conventions

- **Commit messages**: conventional (`feat:`, `fix:`, `chore:`, `docs:`, `style:`, `test:`). One sentence subject under 70 chars.
- **PR bodies**: three sections — *What*, *Why now*, *Test plan*. Skim recent merged PRs (`gh pr list --state merged --limit 3`) for voice. No "Generated with" footers.
- **Workflow descriptions**: bundled workflows in `.keelson/workflows/` use the `Use when / Triggers / Does / NOT for` structured convention so the SPA workflow cards render scannably. Match that shape when adding new ones.

## Documentation

The docs site lives in `docs/` — a self-contained **Astro Starlight** project (not a Bun workspace; it has its own `bun install` and lockfile). Two parts share one "blueprint" identity: a bespoke hand-authored landing in `docs/public/` and the Starlight docs tier (Markdown/MDX) under `docs/src/content/docs/`. **`docs/STYLE.md` is the authoritative style guide — read it before adding or editing any docs page.** It locks the voice, palette, components, figure conventions, widths, and the route map (landing at `/`, docs under `/docs/`). Build and preview locally with `cd docs && bun install && bun run build && bun run preview`. `.github/workflows/docs.yml` builds and deploys it to GitHub Pages. Do not introduce a second site generator or fork the palette per page.
