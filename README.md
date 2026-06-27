# Keelson

**The backbone for your coding agent.**

A single-user, local-only **harness** that wraps a coding agent — GitHub Copilot
or Claude — with persistent state, deterministic YAML workflows, and a browser
UI. It runs on your laptop and never round-trips through a hosted service.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: Beta](https://img.shields.io/badge/status-beta-blue.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

---

## What is a harness?

A harness is infrastructure. It wraps a coding agent with the plumbing the agent
itself doesn't carry — state, workflows, policy, a UI. The harness is useful on
its own; when you need more, you bolt on **ribs**.

A keelson is the beam fastened over a ship's keel — the spine the rest of the
hull bolts onto. Keelson is the beam; ribs are the structural members that
fasten to it.

| | Harness (Keelson) | Ribs (extensions) |
|---|---|---|
| Ships in-tree | Yes — the deliverable | No — none ship; install from any git URL |
| Provides | state, workflows, providers, UI, policy | tools, surfaces, external-system integrations |
| Who writes it | the project | anyone — `keelson-rib-<name>` |
| When it loads | always | discovered at boot from `node_modules/@keelson/` |

---

## What you get

- **Local agent harness** — runs on your laptop, no hosted control plane, no round-trips.
- **Provider abstraction** — drive Copilot, Claude, Codex, Pi, or an offline `stub` behind one interface.
- **Deterministic workflows** — YAML DAGs for repeatable, agent-adjacent work.
- **Persistent state** — conversations, runs, outputs, and memory in SQLite; credentials in your OS keychain.
- **Browser UI + CLI** — work visually at `:7878` or script it from the terminal (`--json`, stable exit codes `0`–`4`).
- **Ribs** — install capabilities from any git URL; each adds tools, workflows, and surfaces.

---

## Demo

A deterministic workflow exercising every node type — `prompt` / `command` /
`loop` (agent) and `bash` / `script` (deterministic), wired as a DAG and run
against Copilot:

```text
$ keelson workflow run smoke-test --watch
▶ run f112c1e3 (smoke-test)
  · prompt-node …
  · command-node …
  · loop-node …
    iteration 1 of 2
  · bash-json-node …
  · script-bun-node …
    {"status":"ok"}
  ✓ bash-json-node
  ✓ script-bun-node
  ✓ loop-node
  ✓ prompt-node
  ✓ command-node
  · downstream …
  · gated …
    downstream got: ok
  ✓ gated
  ✓ downstream
  · merge …
  ✓ merge
  · assert …
    PASS: all node types verified
  ✓ assert
■ succeeded (4749ms)
```

---

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

Re-run the installer any time to upgrade or repair — your installed ribs are
preserved. Once installed, `keelson update` does the same in place.

---

## Quick start

```bash
keelson start                # server + web UI + WS on :7878, in the background
open http://127.0.0.1:7878   # Chat, Workflows, and your ribs' surfaces
keelson doctor               # health sweep: toolchain, server, DB, auth, ribs
```

Real agents need a Copilot subscription or an Anthropic API key. No keys? Set
`KEELSON_PROVIDERS=stub` for an offline echo provider to try the harness without
credentials. `keelson start --foreground` runs attached; `keelson stop` shuts the
background server down.

### Where to next

| Your goal | Start here |
|---|---|
| Work with an agent interactively | **Chat** — `keelson start`, then the Chat surface at `:7878` |
| Repeat a multi-step task deterministically | **Workflows** — `keelson workflow run <name>` |
| Add an external capability (tools, surfaces) | **Ribs** — `keelson rib add <source>` |
| Expose Keelson's tools to another agent | **MCP** — point an MCP client at `/api/mcp` |

---

## Providers

By default Keelson loads only Copilot, leaving the offline `stub`, Claude, Pi
(a multi-vendor community agent), and Codex (OpenAI's coding agent) opt-in. Pick
which providers load and which one chat defaults to in `~/.keelson/config.json`
(`KEELSON_PROVIDERS` overrides the file when set):

```json
{
  "providers": { "copilot": true, "claude": true, "pi": true, "codex": true },
  "defaultProvider": "claude"
}
```

**Gateways** point a provider at any **OpenAI-compatible** endpoint — OpenRouter,
a local [Ollama](https://ollama.com/) or vLLM, Azure OpenAI, a LiteLLM proxy.
Each registers as a provider and shows up in the model picker:

```bash
keelson gateway add ollama http://localhost:11434/v1 --model qwen3
```

See the [configuration guide](https://danielscholl.github.io/keelson/docs/guides/configuration/)
for every `KEELSON_*` variable, gateway options, and how Pi's and Codex's
self-managed auth works.

---

## Ribs

No ribs ship in-tree, and Keelson keeps no registry — anyone can publish one.
`keelson rib add <source>` hands the source to `bun`; the server discovers
whatever installs as an `@keelson/rib-*` package at boot:

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-chamber   # multi-agent rooms + agent genesis
keelson rib add https://github.com/danielscholl/keelson-rib-osdu      # OSDU CIMPL cluster / platform lanes
keelson rib add github:you/keelson-rib-yours                          # or a git URL, npm name, or local path
keelson rib list --installed
keelson rib remove osdu                                               # by rib id
```

A rib default-exports an object implementing the `Rib` contract — registering
one tool is enough to reach the chat agent and workflow `prompt` nodes.
[**Writing a rib**](WRITING-RIBS.md) is the five-minute quickstart;
[`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) is the full contract,
and the [ribs guide](https://danielscholl.github.io/keelson/docs/guides/managing-ribs/)
covers install and lifecycle.

---

## Governance

Keelson's policy engine can pause, deny, or rewrite a tool call around every turn
— for both Keelson's tools and the agent's own shell/write capabilities. Each
builtin is opt-in:

| Policy | Enable with | Effect |
|---|---|---|
| **Ask** | `KEELSON_ASK_ON_SHELL=1` | Pause shell / file-mutating calls for human approval (resolve over `/api/approvals` or `keelson approval resolve`). |
| **Deny** (budget) | `KEELSON_TURN_BUDGET` / `KEELSON_COST_BUDGET` | A downgrade gate: past the ceiling, deny turns running on a metered model so spend moves off it. |
| **Redact** | `KEELSON_REDACT_PATTERN=<regex>` | Replace matches with `[REDACTED]` before the model — or a downstream workflow node — consumes the output. |

See the [governance guide](https://danielscholl.github.io/keelson/docs/guides/governance/)
for the full policy model and how ribs contribute their own policies.

---

## Use from other agents (MCP)

The keelson server exposes every registered tool — your ribs' tools plus the
workflow tools — over the [Model Context Protocol](https://modelcontextprotocol.io)
at `http://127.0.0.1:7878/api/mcp`, automatically with the server. Tools run
**inside** the keelson server, where each rib keeps its credentials and exec
access, so an external agent gets a rib's real capabilities. Point a client at it:

```jsonc
// Claude Code / Cursor: an HTTP MCP server
{ "mcpServers": { "keelson": { "type": "http", "url": "http://127.0.0.1:7878/api/mcp" } } }
```

The endpoint is open on loopback and exposes **state-changing tools** by default.
`keelson mcp` is a stdio bridge for clients that only speak stdio. See the
[MCP guide](https://danielscholl.github.io/keelson/docs/guides/using-mcp/) to
lock it down (read-only, bearer token, denylist) before proxying it anywhere.

> **Windows note.** The `bash` workflow node needs a POSIX shell — install
> [Git for Windows](https://git-scm.com/download/win) and Keelson auto-discovers
> its `bash.exe`. Some bundled workflows also call `gh`, `jq`, and `pkill`. See
> [troubleshooting](https://danielscholl.github.io/keelson/docs/reference/troubleshooting/).

---

## Documentation

- **[danielscholl.github.io/keelson](https://danielscholl.github.io/keelson/)** — concepts, guides, the rib contract
- [WRITING-RIBS.md](WRITING-RIBS.md) — five-minute rib authoring quickstart
- [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) — the `Rib` contract
- [`packages/workflows/assets/workflows/`](packages/workflows/assets/workflows/) — bundled starter workflows
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, required checks, PR hygiene
- [SECURITY.md](SECURITY.md) — threat model and how to report

---

## Uninstall

```bash
rm -f ~/.local/bin/keelson
rm -rf ~/.keelson
```

```powershell
# Windows (also remove %LOCALAPPDATA%\keelson\bin from your user PATH)
Remove-Item -Recurse -Force "$env:USERPROFILE\.keelson", "$env:LOCALAPPDATA\keelson\bin"
```

---

## License

Licensed under the [Apache License 2.0](LICENSE). The workflow engine borrows its
schema and DAG concepts from [Archon](https://github.com/coleam00/Archon) (MIT, by
Cole Medin) — a well-thought-out project; go support his
[channel](https://www.youtube.com/@ColeMedin). Full attribution lives in [NOTICE](NOTICE).
