# Changelog

All notable changes to Keelson are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.2] — 2026-06-10 — Starter workflows on first run

A fresh install now ships with workflows. Previously an installed
`keelson serve` came up with "0 workflows discovered" until you installed a rib
or hand-copied YAML — the starter workflows only existed in a source checkout.

### Added

- **Starter workflows seeded on first run.** The release bundle now carries the
  starter workflows (`fix-issue`, `plan-act-evaluate`, `pr-review`,
  `smoke-test`), and the CLI and server seed them into `~/.keelson/workflows` the
  first time they run, so Chat/Workflows and `keelson workflow list` have
  something to show before any rib is installed. Ribs still contribute more, and
  your own YAML in the workflows dir is left untouched.

### Fixed

- **Atomic seeding.** Starters are copied to a temp name and renamed into place,
  so an interrupted or failed first-run seed leaves no partial set behind (the
  next run reseeds the full set) and discovery never reads a half-written file. A
  populated workflows dir is treated as user-owned and never overwritten.

## [0.1.1] — 2026-06-10 — Workflow run provenance & bulk management

Workflow runs now carry provenance — which rib they came from, and whether they
were triggered manually or by the background scheduler — and the Workflows
surface uses it to filter, badge, and bulk-manage.

### Added

- **Run provenance.** Each workflow records its source (a local YAML file or a
  specific rib) and each run records its trigger (`manual` vs `scheduled`) and
  owning rib. Catalog cards and run rows badge by rib, and both are filterable by
  source. (Migration 3 adds `workflow_runs.origin` + `rib_id`.)
- **Bulk run management.** `POST /api/workflows/runs/bulk-delete` removes a group
  of runs by id or by filter (every scheduled run, all runs from a rib); the runs
  feed gains multi-select with select-all and bulk delete.
- **Per-rib hide.** A view-only toggle hides a rib's workflows from the catalog
  and its runs from the feed; the rib's background producers keep refreshing its
  surfaces.

### Changed

- **Scheduled-run retention.** Background producer runs (heartbeat and panel
  refresh) are kept to the newest few per workflow and auto-pruned — cascading
  their linked conversations — so high-cadence rib lanes no longer grow run
  history without bound. The runs feed defaults to manual runs, with a toggle to
  reveal scheduled ones.
- The general `GET /api/workflows/runs` feed (filterable by origin / status /
  rib / workflow) replaces the prior paused-only endpoint; `?status=paused` still
  backs the nav badge.

## [0.1.0] — 2026-06-10 — Installable harness

The first installable Keelson release. A single `keelson` CLI backed by a managed
home, an in-process server with a browser UI, deterministic YAML workflows, a
governed memory layer, multi-provider chat, and discovery-based ribs. Runs on
macOS, Linux, and Windows.

### Added

- **Install and update.** A GitHub-release `install.sh` (and `install.ps1`)
  provisions a managed home (`~/.keelson`) as one Bun project, pinning versioned
  `@keelson/cli` + `@keelson/shared` tarballs and dropping a launcher on PATH.
  `keelson update` moves the home to the latest release and advances installed
  ribs; `--check` reports the available version without applying. The topology
  resolves a single `@keelson/shared` (one Zod), so rib tool schemas survive
  `z.toJSONSchema()` across the harness and rib boundary.
- **Server and browser UI.** `keelson serve` runs the server in-process and
  serves the built React SPA (Chat, Workflows, and every rib's surfaces) at
  `http://127.0.0.1:7878`, the same origin as the API. `keelson serve start` /
  `serve status` / `serve stop` manage a detached background server, with its
  pid, URL, and a token-gated shutdown recorded in the home.
- **Discovery-based ribs.** `keelson rib add <source>` takes any source `bun`
  understands (a github URL, `github:owner/repo`, a git URL, an npm name, or a
  local path); the server discovers installed `@keelson/rib-*` packages at boot,
  and `KEELSON_RIBS` filters which activate. There is no central registry. The
  `Rib` contract lets a rib contribute tools, snapshots, views, surfaces,
  workflows, actions, and an auth probe, all under its own namespace, with no
  harness edits.
- **Deterministic workflows.** A YAML DAG executor with seven node types
  (`prompt` / `bash` / `command` / `loop` / `script` / `approval` / `cancel`),
  `depends_on` / `when:` / `trigger_rule:`, and `$nodeId.output` substitution.
  A node's structured output can republish to a rib snapshot key.
- **Governed memory.** A SQLite recall and writeback layer (FTS5 BM25 plus
  recency decay) with an operator review queue. Agent-authored memory is
  provenance-locked and can never self-promote to instruction-grade.
- **Multi-provider chat.** One `IAgentProvider` over the GitHub Copilot SDK, the
  Claude Agent SDK, and an offline `stub` for credential-free use.
- **Documentation site.** An Astro Starlight set (concepts, guides, tutorials,
  reference, design) on a bespoke "blueprint" landing, deployed to GitHub Pages.

### Changed

- Release artifacts pin **versioned** download URLs
  (`/releases/download/v<x.y.z>/`), so re-running a newer `install.sh` upgrades
  in place. `release.yml` fails fast unless the pushed tag matches the package
  version.

### Schema

- SQLite migrations through v3: sessions, runs, and node outputs; memory tables
  with an FTS5 index and the instruction-promotion CHECK constraint.
