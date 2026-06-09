# Changelog

All notable changes to Keelson are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
`0.1.0` is the first **tagged, installable** release — the version line that
GitHub Releases publish and `keelson update` moves between. The dated entries
under [Pre-release milestones](#pre-release-milestones) used an internal
milestone numbering (0.2–0.4); they predate the install path and were never
published as artifacts, and are kept here for history.

## [0.4.0] — 2026-06-09 — Browser UI from `keelson serve`

The installed harness now has a browser UI. `keelson serve` serves the built
React SPA — Chat, Workflows, and every rib's surfaces — at `http://127.0.0.1:7878`,
the same origin as the API. No separate dev server.

### Added

- `keelson serve` serves the built SPA at the root: static assets with an
  immutable cache, an `index.html` SPA fallback for client-side routes, and the
  `/api/*` + WebSocket routes unchanged. The SPA talks to its own origin
  (relative `/api`, `window.location.host` WebSockets), so same-origin "just
  works".
- `scripts/build-release.ts` builds `@keelson/web` and ships it inside the
  `@keelson/cli` tarball under `web/`; the server resolves it from the bundle
  location (overridable via `KEELSON_WEB_DIR`). A source checkout has no build,
  so dev stays API-only and the Vite server on `:5173` owns the UI.

## [0.3.0] — 2026-06-09 — Registry-free rib install

Keelson no longer keeps a list of which ribs exist. `keelson rib add` takes any
source `bun` understands, so anyone can publish a rib without being coded into
the harness.

### Changed

- `keelson rib add <source>` accepts a github URL, `github:owner/repo`, a git
  URL, an npm name, or a local path, and hands it to `bun add` unchanged (only
  relative paths are absolutized). The built-in `chamber`/`osdu` id shortcuts are
  removed — install by source, e.g.
  `keelson rib add https://github.com/danielscholl/keelson-rib-osdu`.
- `keelson update` advances **every** installed `@keelson/rib-*` dependency
  regardless of how it was added (`bun update` moves a floating git ref to its
  newest commit and no-ops a pinned tag/tarball/path), fixing ribs added via a
  plain `https://` URL or `owner/repo` shorthand not being advanced.

## [0.2.0] — 2026-06-09 — `keelson update`

In-place upgrades. `keelson update` moves an installed home to the latest
release and advances the ribs you installed, showing the release notes for the
versions it crosses.

### Added

- `keelson update` — resolves the latest GitHub release, re-pins the home's
  `@keelson/cli` + `@keelson/shared` to that version's asset URLs, runs
  `bun install`, then `bun update`s github-sourced ribs to their latest tracked
  commit. `--check` reports the available version without applying, `--force`
  re-applies at the current version, and `--no-ribs` / `--no-notes` opt out of
  the rib advance and the notes fetch. Release notes for the
  `(installed, latest]` window come from the Releases API and print before the
  upgrade applies.

## [0.1.0] — 2026-06-09 — Installable harness

Keelson becomes a real, installable `keelson` CLI: a GitHub-release `install.sh`
provisions a managed home (`~/.keelson`) as a single Bun project, `keelson serve`
runs the server in-process, and `keelson rib add <id>` installs ribs into that
home. The topology resolves one `@keelson/shared` (hence one Zod) so rib tool
schemas survive `z.toJSONSchema()` across the harness↔rib boundary.

### Added

- `install.sh` (built by `scripts/build-release.ts`, published by
  `.github/workflows/release.yml` on a `v*` tag) provisions `$KEELSON_HOME`,
  pins the CLI + `@keelson/shared` tarballs, and drops a launcher on PATH.
- `keelson serve` runs the server in-process via `startServer()` /
  `serveUntilSignal()`; `keelson rib add/remove/list` manage ribs in the home
  (known ids `chamber`/`osdu` resolve to `github:danielscholl/keelson-rib-*`).
- `@keelson/shared/paths`: `resolveKeelsonHome` / `keelsonPaths` /
  `resolveRibsRoot` — the single home resolver shared by CLI and server.

### Changed

- Release artifacts pin **versioned** download URLs
  (`/releases/download/v<x.y.z>/`), not `/latest/`, so re-running a newer
  `install.sh` upgrades in place: the dependency string changes between
  versions, which is what lets `bun install` re-resolve instead of serving the
  URL-keyed cache.
- `release.yml` fails fast unless the pushed tag matches the package version.

<a id="pre-release-milestones"></a>
## Pre-release milestones

Development milestones before the install path existed (internal numbering,
never tagged or published).

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
