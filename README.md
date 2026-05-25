# Keelson

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)

### A local agent harness — pluggable ribs, deterministic workflows

Keelson is a single-user, local-only **harness** that wraps a coding agent
(GitHub Copilot SDK or Claude Agent SDK) with persistent state, a typed
extension contract, deterministic YAML workflows, and a browser UI. The
harness runs on your laptop, never round-trips through a hosted service,
and stays out of the way of whatever capabilities your **ribs** bring.

The browser UI lives at `http://127.0.0.1:5173`; the `keelson` CLI drives
the same surfaces from the shell, from cron, or from another script.

**Who this is for:**

- Builders who want a multi-provider coding agent (Copilot SDK *and* Claude
  Agent SDK) with a real tool surface, governed by deterministic workflows
- Anyone shipping a domain-specific agent integration who'd rather own the
  capabilities (the ribs) than rebuild the harness around them


## Why Keelson

- **Local-only**: runs on your machine, calls your CLIs directly, no SaaS
- **Multi-provider**: never bound to a single coding-agent vendor — Copilot
  SDK and Claude Agent SDK both ship today
- **Rib architecture**: capabilities live in *ribs* (extensions), each in
  its own repo. The harness is the substrate; ribs register tools through
  a typed `Rib` contract
- **Deterministic when it matters**: repeatable operations live in YAML
  workflows that humans can read, not in chat transcripts; the engine runs
  prompt / bash / command / loop / script / approval nodes through a DAG


## What's a rib?

A keelson is the longitudinal beam fastened on top of a ship's keel — the
reinforcing spine that lets the rest of the structure attach to something
rigid. **Ribs** are the structural members bolted onto it that give the
hull its shape. In Keelson, the harness is the beam; ribs are the units
that register tools, supply context, and own external-system integrations.

Ribs ship as their own packages and repos:

| Surface | Convention |
|---|---|
| GitHub repo | `keelson-rib-<name>` (e.g., `keelson-rib-osdu`) |
| npm package | `@keelson/rib-<name>` |
| Env activation | `KEELSON_RIBS=<id1>,<id2>` |
| TypeScript contract | `Rib` interface from `@keelson/shared` |

v0 ships **no in-tree ribs** — the harness is the deliverable. See
[`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) for the
contract.


## Install

Keelson is currently developed and run from the workspace — there's no
standalone binary yet. The only tool you need is [Bun](https://bun.sh/).

```bash
git clone https://github.com/danielscholl/keelson.git
cd keelson
bun install
```

Alias the workspace bin while developing:

```bash
alias keelson="bun $(pwd)/apps/cli/bin/keelson.ts"
keelson version
keelson help
```


## Quick Start

```bash
# Launch both surfaces (server on :7878, SPA on :5173)
bun dev

# Open http://127.0.0.1:5173 in your browser

# Offline / no-auth — use the stub provider, no API keys required
KEELSON_PROVIDERS=stub bun dev:server
```

### Headless / CLI

```bash
# Health sweep across toolchain, server, DB, auth, workflows
keelson doctor
keelson doctor --strict --json | jq '.data.summary'

# Workflow operations (server up → HTTP; server down → in-process fallback)
keelson workflow list
keelson workflow validate smoke-test
keelson workflow run smoke-test --watch
keelson workflow status                  # paused runs (server required)

# One-shot chat
keelson chat "hello" --provider stub
```

Every command supports `--json` for piping and uses stable exit codes:
`0` success, `1` failure, `2` bad args, `3` server required but down,
`4` not found.


## Development Setup

```bash
git clone https://github.com/danielscholl/keelson.git
cd keelson
bun install
bun --filter '*' typecheck
bun --filter '*' test
bun dev
```

The workspace is a single Bun monorepo; `bun dev` runs the server (port
7878) and the Vite SPA (port 5173) in parallel and proxies `/api` from
the SPA to the server. Run `bun dev:server` or `bun dev:web` to start
one side alone.


## Operating Model

Keelson is a **harness** with a typed `Rib` contract, not a monolith.

The harness owns: provider registry, tool registry, DAG workflow executor,
chat surface, SQLite session persistence, keytar credentials, redaction
pipeline.

Ribs plug in by implementing `registerTools?` and `dispose?`. None ship
in-tree — bring your own and activate them with `KEELSON_RIBS`.

<details>
<summary>Harness layers</summary>

| Layer | What it does |
|---|---|
| **Surface** | React 19 + Vite SPA (Chat / Workflows) and the `keelson` CLI |
| **Provider** | Pluggable coding-agent SDKs behind one `IAgentProvider` (Copilot, Claude, stub) |
| **Tools** | Native TS skills registered by ribs through the manifest |
| **Workflows** | Archon-compatible YAML DAG engine — `prompt`, `bash`, `command`, `loop`, `script`, `approval` nodes with `depends_on`, `when:`, `trigger_rule:` |
| **State** | SQLite (sessions, runs, node outputs) + keytar (credentials) |

</details>

<details>
<summary>Environment overrides</summary>

| Variable | Effect |
|---|---|
| `KEELSON_RIBS=cimpl,osdu` | Activate one or more ribs (comma-separated ids) |
| `KEELSON_PROVIDERS=stub,copilot,claude` | Restrict which agent providers register |
| `KEELSON_WORKFLOW_PROVIDER=claude` | Pin the provider workflows use for `prompt` nodes |
| `KEELSON_WORKFLOW_TOOL_DENYLIST=tool_a,tool_b` | Operator floor: per-node tool denylist |
| `KEELSON_WORKFLOW_PROMPT_TIMEOUT_S=600` | Per-prompt-node timeout in seconds |
| `KEELSON_DB=/tmp/scratch.db` | Override the SQLite path (default: `.keelson/keelson.db`) |
| `KEELSON_USE_STUBS=1` | Hint to ribs that they should use bundled fixtures |

</details>


## Prerequisites

Run `keelson doctor` to verify the environment:

```bash
keelson doctor
keelson doctor --strict --json | jq '.data.summary'
```

The doctor sweeps five categories — toolchain (`bun`), server, DB
(`schema_version` match), auth (`keytar` round-trip), and workflow
validation. Ribs can register their own probes by extending the doctor
surface (see [`apps/cli/src/checks/`](apps/cli/src/checks/)).

**Required**: Bun. **Recommended for live providers**: a Copilot
subscription or Anthropic API key, configured via the SPA's credentials
drawer.


## CLI Reference

```
keelson <command> [options]

Commands:
  serve                    Foreground server supervisor (port 7878 default)
  workflow list            List workflows discovered in .keelson/workflows
  workflow validate NAME   Schema + reference check on one workflow
  workflow run NAME        Run a workflow (server-routed when up, in-process when down)
  workflow status [ID]     Paused-run list, or one run's detail (server required)
  chat MESSAGE             One-shot turn — WebSocket when server is up, in-process otherwise
  doctor                   Non-mutating health sweep across five categories
  version                  Print version (supports --json)
  help                     Show help text
```

Every command supports `--json` for piping. Stable exit codes: `0` success,
`1` failure, `2` bad args, `3` server required but down, `4` not found.


## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — local setup, required checks, PR hygiene
- [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) — the `Rib` contract
- [`packages/workflows/src/schema/`](packages/workflows/src/schema/) — YAML schema (Archon-compatible)
- [`.keelson/workflows/`](.keelson/workflows/) — bundled starter workflows


## Status

| Phase | Deliverable | Status |
|---|---|---|
| v0.1 | Skeleton, providers, workflow engine, CLI, Chat + Workflows SPA, Rib contract | ✅ |
| v0.2 | Snapshot infrastructure (generic `SnapshotManager` + WS streaming) | next |
| v0.3 | Agent memory layer (governed recall/writeback) | — |
| v0.4 | Dynamic rib discovery from `node_modules/@keelson/rib-*` | — |


## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
third-party attribution — the workflow YAML schema is derived from
[Archon](https://github.com/dynamous-community/archon) (MIT) and remains
wire-compatible with the upstream specification.
