# Changelog

All notable changes to Keelson are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions track the milestones in the README Status table.

## [0.4.0] — 2026-05-27 — Dynamic rib discovery

The harness now discovers ribs from `node_modules/@keelson/rib-*` at boot,
removing the embedder-wired manifest as the only activation path. Embedders
who want to bypass discovery still hand `bootstrapRibs` an explicit `available`
map; `KEELSON_RIBS=<id1>,<id2>` still filters which discovered ribs activate.

### Added

- `discoverRibs()` walks `node_modules/@keelson/` (or a caller-supplied root),
  resolves each `rib-*` directory through symlinks, validates the default
  export against `ribIdSchema` / `ribDisplayNameSchema`, and skips entries
  with non-function hooks, mismatched ids, or import failures (warn-and-continue).
- `bootstrapRibs` now runs discovery when no explicit `available` map is
  supplied; existing embedders passing `available` are unaffected.

### Changed

- README updated to describe `bun add @keelson/rib-*` as the activation path
  for end users and `available:` as the embedder override.
- Bundled workflow catalog pruned: `plan-and-apply` and `python-smoke-test`
  removed; `memory-demo` renamed to `memory`.
- SPA workflow cards clamp section bodies to 5 lines with hover tooltips.
- Conversation delete now routes through a `ConfirmModal`; workflow notices
  persist in localStorage.

### Fixed

- Copilot provider clears `reasoningEffort` when all advertised tiers are
  unknown.
- Chat local-id reconciliation no longer races queued follow-up turns:
  `TurnReconcileSnapshot` captures the just-completed turn's client ids
  before the queue flush.

### Removed

- The `discoveryRoot` option on `BootstrapRibsOptions` (tests now compose
  `discoverRibs({ root })` directly into `available`).

## [0.3.0] — 2026-05-26 — Agent memory layer

A governed recall + writeback layer that lets workflows and chat surfaces
persist what was learned during one turn and re-introduce it on the next,
without ever promoting agent-authored memory to instruction-grade without
an explicit operator gesture.

### Added

- SQLite storage foundation: `memories` and adjacency tables with FTS5
  full-text search and per-row instruction-promotion CHECK constraint.
- Wire contracts (`@keelson/shared/memory`): Zod schemas for recall /
  writeback / review request and response shapes, versioned via
  `keelson.memory.*` schemaVersion literals.
- `MemoryStore` service: BM25 + recency-decay recall, idempotent writeback,
  cursor-paginated review/list queries, and confirm/restrict/reject/merge/
  mark-stale review actions. Writeback guardrails detect candidate secrets,
  enforce the 4 KB text cap, and require a source ref for evidence types.
- HTTP routes: `POST /api/memory/recall`, `POST /api/memory/writeback`,
  `POST /api/memory/review`, `GET /api/memory/review`, `GET /api/memory/list`,
  `POST /api/chat/:cid/messages/:mid/remember`. CSRF origin guard on all
  state-changing endpoints.
- Workflow integration: declarative `memory:` block on any node provides
  pre-run recall and post-run writeback. Provenance is locked to `generated`
  at the executor — workflow YAML cannot self-promote memory.
- Chat recall injection: relevant prior memory is prepended to the
  system prompt for non-workflow conversations, with usePolicy filtering
  so only instruction-eligible items reach the model.
- SPA Memory tab: pending and all-memories views with paged listing,
  operator action buttons (confirm / evidence-only / restrict / reject /
  merge / mark-stale), and a pending-count pip on the nav.
- Chat-side capture: ★ Save to memory button on persisted, non-system
  messages dispatches a writeback with the conversation/message URI.

### Schema

- Migration v2 — memory tables, FTS5 virtual table, instruction-promotion
  CHECK constraint.
- Migration v3 — drop the unused `memory_relations` table that v2 created
  in anticipation of a relation-walk feature later cut from v0.3 scope.
