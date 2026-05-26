# Changelog

All notable changes to Keelson are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions track the milestones in the README Status table.

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
