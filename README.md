# Keelson

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

**The backbone for your coding agent.**

Keelson is a single-user, local-only **harness** that wraps a coding agent —
GitHub Copilot or Claude — with persistent state, deterministic YAML workflows,
and a browser UI. It runs on your laptop and never round-trips through a hosted
service.

The harness is useful on its own. When you need more, you bolt on **ribs** —
installable extensions that add tools, workflows, and whole new surfaces without
forking the harness.


## What you get

- **Local agent harness** — runs on your laptop, no hosted control plane, no round-trips.
- **Provider abstraction** — drive Copilot, Claude, Codex, Pi, or an offline `stub` behind one interface.
- **Deterministic workflows** — YAML DAGs for repeatable, agent-adjacent work.
- **Persistent state** — conversations, runs, outputs, and memory in SQLite; credentials in your OS keychain.
- **Browser UI + CLI** — work visually at `:7878` or script it from the terminal.
- **Ribs** — install capabilities from any git URL; each adds tools, workflows, and surfaces.

## Install

You need [Bun](https://bun.sh/) on your PATH — the harness and every rib run on it.

**macOS / Linux / WSL** — provisions `~/.keelson` and drops a `keelson` launcher in `~/.local/bin`:

```bash
curl -fsSL https://github.com/danielscholl/keelson/releases/latest/download/install.sh | sh
```

**Windows** — provisions `%USERPROFILE%\.keelson`, drops `keelson.cmd` in `%LOCALAPPDATA%\keelson\bin`, and adds it to your user `PATH`:

```powershell
irm https://github.com/danielscholl/keelson/releases/latest/download/install.ps1 | iex
```

> Run this from PowerShell (Windows PowerShell 5.1 or 7). From `cmd.exe`, start `pwsh` (or `powershell`) first, then paste it.

Make sure `~/.local/bin` is on your `PATH` (Windows handles PATH for you). Re-run
the installer any time to upgrade or repair — your installed ribs are preserved.
Once installed, `keelson update` does the same in place (`--check` reports what's
available).

## Quick Start

```bash
keelson start                # server + web UI + WS on :7878, in the background
open http://127.0.0.1:7878   # Chat, Workflows, and your ribs' surfaces
keelson doctor               # health sweep: toolchain, server, DB, auth, ribs
```

Real agents need a Copilot subscription or an Anthropic API key. No keys? Set
`KEELSON_PROVIDERS=stub` for an offline echo provider to try the harness without
credentials. `keelson start --foreground` runs the server attached instead;
`keelson stop` shuts the background server down.

By default Keelson loads only Copilot, leaving the offline `stub`, Claude, Pi
(a multi-vendor community agent), and Codex (OpenAI's coding agent) opt-in. Pick
which providers load and which one chat defaults to in `~/.keelson/config.json`:

```json
{
  "providers": { "copilot": true, "claude": true, "pi": true, "codex": true },
  "defaultProvider": "claude"
}
```

`KEELSON_PROVIDERS` still overrides the file when set. See the
[configuration guide](https://danielscholl.github.io/keelson/docs/guides/configuration/)
for every setting, the `KEELSON_*` variables, and how Pi's and Codex's
self-managed auth works.

> **Windows note.** The `bash` workflow node (and `loop` `until_bash`) need a
> POSIX shell — install [Git for Windows](https://git-scm.com/download/win) and
> Keelson auto-discovers its `bash.exe` (`KEELSON_BASH` overrides). The `prompt`,
> `command`, and `script` node types have no such requirement.

## Add ribs

A keelson is the beam fastened over a ship's keel — the spine the rest of the
hull bolts onto. The harness is the beam; **ribs** are the units that register
tools, supply context, and own external-system integrations.

No ribs ship in-tree, and Keelson keeps no registry of which ribs exist — anyone
can publish one. `keelson rib add <source>` hands the source to `bun` and the
server discovers whatever installs as an `@keelson/rib-*` package at boot:

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-chamber   # multi-agent rooms + agent genesis
keelson rib add https://github.com/danielscholl/keelson-rib-osdu      # OSDU CIMPL cluster / platform lanes
keelson rib add github:you/keelson-rib-yours                          # or shorthand, a git URL, npm name, or local path
keelson rib list --installed
keelson rib remove osdu                                               # by rib id
```

| Surface | Convention |
|---|---|
| GitHub repo | `keelson-rib-<name>` |
| npm package | `@keelson/rib-<name>` |
| Contract | `Rib` interface from `@keelson/shared` |
| Activation | discovered from `node_modules/@keelson/`, filtered by `KEELSON_RIBS` |

## Write a rib

A rib default-exports an object implementing the `Rib` contract. The smallest
useful one registers a tool that reaches the chat agent and workflow `prompt`
nodes with no extra wiring:

```ts
import type { Rib, ToolDefinition } from "@keelson/shared";
import { z } from "zod";

const weatherTool: ToolDefinition = {
  name: "weather_now",
  description: "Report the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  async execute(input, ctx) {
    const { city } = input as { city: string };
    ctx.emit({ type: "tool_result", toolUseId: "", content: `Clear skies over ${city}.` });
  },
};

const rib: Rib = {
  id: "weather",
  displayName: "Weather",
  registerTools: () => [weatherTool],
};

export default rib;
```

See [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) for the full
contract — snapshots, views, surfaces, workflow contributions — and the
[docs](https://danielscholl.github.io/keelson/) for a walkthrough.

## Use from other agents (MCP)

The keelson server exposes every registered tool — your installed ribs' tools plus
the workflow tools — over the [Model Context Protocol](https://modelcontextprotocol.io)
at `http://127.0.0.1:7878/api/mcp`. The endpoint comes up automatically with the
server (`keelson start`), so any MCP-capable agent (Claude Code, Cursor, Copilot CLI,
Codex CLI) can call them. Tools run **inside** the keelson server, where each rib
keeps its credentials and exec access — so an external agent gets a rib's real
capabilities, not a reimplementation.

By default the endpoint is open on loopback (no token) and exposes only **read-only**
tools. Point a client at it:

```jsonc
// Claude Code / Cursor: an HTTP MCP server
{ "mcpServers": { "keelson": { "type": "http", "url": "http://127.0.0.1:7878/api/mcp" } } }
```

```toml
# Codex CLI (~/.codex/config.toml): the HTTP endpoint, or the stdio bridge below
[mcp_servers.keelson]
command = "keelson"
args = ["mcp"]
```

`keelson mcp` is a stdio bridge for clients that only speak stdio MCP — it pipes them
to the running server (and exits non-zero if the server is down).

Tune it in `~/.keelson/config.json` (or the matching env overrides
`KEELSON_MCP_DISABLED`, `KEELSON_MCP_EXPOSE_STATE_CHANGING`,
`KEELSON_MCP_REQUIRE_TOKEN`, `KEELSON_MCP_DENYLIST`):

```json
{ "mcp": { "enabled": true, "exposeStateChanging": false, "requireToken": false, "toolDenylist": [] } }
```

The read-only endpoint exposes `workflow_list`/`workflow_status` and a rib's read
tools. Set `exposeStateChanging: true` to also surface state-changing tools —
`workflow_run`/`workflow_respond` and a rib's mutation tools (e.g. OSDU cluster
suspend), all hidden by default. `requireToken: true` gates the endpoint behind a
bearer token recorded in `~/.keelson/server.json`.

## How it fits

| Piece | What it is |
|---|---|
| **Surfaces** | React 19 + Vite SPA (Chat, Workflows) and the `keelson` CLI |
| **Providers** | One `IAgentProvider` over Copilot SDK, Claude Agent SDK, OpenAI's Codex SDK, the multi-vendor Pi agent, and a `stub` (offline/test, no keys) |
| **Ribs** | Capabilities that register tools through the typed `Rib` contract, each in its own repo |
| **Workflows** | Deterministic YAML DAG: `prompt` / `bash` / `command` / `loop` / `script` / `approval` / `cancel` nodes |
| **State** | SQLite (conversations, runs, node outputs, memory) plus your OS keychain for credentials |

When the server is up, CLI commands route over HTTP/WS; `workflow run` and `chat`
fall back to in-process execution when it's down. Every command takes `--json`,
with stable exit codes: `0` success, `1` failure, `2` bad args, `3` server
required but down, `4` not found.

The workflow engine borrows its schema and DAG concepts from
[Archon](https://github.com/coleam00/Archon) (MIT, by Cole Medin): a fantastic and well thought out project go check it out and support his [channel](https://www.youtube.com/@ColeMedin). 
Full attribution lives in [NOTICE](NOTICE).

## Documentation

- **[danielscholl.github.io/keelson](https://danielscholl.github.io/keelson/)** — the documentation site (concepts, guides, the rib contract)
- [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) — the `Rib` contract
- [`packages/workflows/assets/workflows/`](packages/workflows/assets/workflows/) — bundled starter workflows
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, required checks, PR hygiene
- [SECURITY.md](SECURITY.md) — threat model and how to report

## Uninstall

```bash
rm -f ~/.local/bin/keelson
rm -rf ~/.keelson
```

```powershell
# Windows (also remove %LOCALAPPDATA%\keelson\bin from your user PATH)
Remove-Item -Recurse -Force "$env:USERPROFILE\.keelson", "$env:LOCALAPPDATA\keelson\bin"
```

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
third-party attribution.
