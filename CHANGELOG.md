# Changelog

All notable changes to Keelson are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
