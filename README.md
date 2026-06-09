# Keelson

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

**The backbone for your coding agent. Multi-provider chat, deterministic YAML workflows, and ribs you bolt on.**

Keelson is a single-user, local-only **harness** that wraps a coding agent
(GitHub Copilot SDK or Claude Agent SDK) with persistent state, a typed
extension contract, deterministic YAML workflows, and a browser UI. It runs
on your laptop and never round-trips through a hosted service. The harness
is the deliverable; your capabilities live in **ribs** you install.

Alpha: the APIs and workflow schema still move. [Read the docs](https://danielscholl.github.io/keelson/).

---

## Quick Start

Keelson installs as a single `keelson` command backed by a managed home at
`~/.keelson` (its SQLite store, workflows, and the ribs you install). You need
[Bun](https://bun.sh/) on PATH — the harness and ribs both run on it.

**1. Install** — provisions `~/.keelson` and drops a `keelson` launcher in `~/.local/bin`:

```bash
curl -fsSL https://github.com/danielscholl/keelson/releases/latest/download/install.sh | sh
```

Make sure `~/.local/bin` is on your `PATH`. Re-run any time to update.

**2. Add the capabilities (ribs) you want:**

```bash
keelson rib add chamber           # multi-agent rooms + agent genesis
keelson rib add osdu              # OSDU CIMPL cluster / platform lanes
keelson rib list --installed
```

> The `osdu` rib needs the OSDU toolchain on PATH to show live data —
> `cimpl`, `kubectl`, `osdu-activity`, `osdu-quality`, `glab` — plus a reachable
> cluster and GitLab auth. Without them it still loads; its lanes just render empty.

**3. Run** the API server, then drive it from the CLI:

```bash
keelson serve                     # API + WS on :7878 (Ctrl-C to stop)
keelson doctor                    # health sweep: toolchain, server, DB, auth, ribs
keelson chat "hello"              # one-shot turn
keelson workflow run smoke-test --watch
```

Real agents need a Copilot subscription or an Anthropic API key. No keys? Add
`KEELSON_PROVIDERS=stub` for an offline echo provider to try the harness without
credentials. (The React Chat/Workflows UI currently runs in dev — see
[CONTRIBUTING.md](CONTRIBUTING.md) — and isn't served by the installed binary yet.)

**Uninstall:**

```bash
rm -f ~/.local/bin/keelson
rm -rf ~/.keelson
```

---

## What's a rib?

A keelson is the beam fastened over a ship's keel, the spine the rest of the
hull bolts onto. Lay the keel, raise the ribs: the harness is the beam, and
**ribs** are the units that register tools, supply context, and own
external-system integrations.

No ribs ship in-tree. `keelson rib add <id>` installs an `@keelson/rib-*`
package into the home, and the server discovers it from
`~/.keelson/node_modules/@keelson/` at boot:

```bash
keelson rib add osdu              # known id → github:danielscholl/keelson-rib-osdu
keelson rib add ./my-rib          # or a local path / git URL / github:owner/repo
keelson rib remove osdu
```

| Surface | Convention |
|---|---|
| GitHub repo | `keelson-rib-<name>` |
| npm package | `@keelson/rib-<name>` |
| Contract | `Rib` interface from `@keelson/shared` |
| Activation | discovered from `node_modules/@keelson/`, filtered by `KEELSON_RIBS` |

`KEELSON_RIBS=<id1>,<id2>` filters which discovered ribs activate; unset activates all.

---

## Write a rib

A rib default-exports an object implementing the `Rib` contract. The smallest
useful one registers a tool:

```ts
import type { Rib, ToolDefinition } from "@keelson/shared";
import { z } from "zod";

const weatherTool: ToolDefinition = {
  name: "weather_now",
  description: "Report the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  async execute(input, ctx) {
    const { city } = input as { city: string };
    // Results travel back as a tool_result chunk; the provider rewrites toolUseId.
    ctx.emit({ type: "tool_result", toolUseId: "", content: `Clear skies over ${city}.` });
  },
};

const rib: Rib = {
  id: "weather", // matches @keelson/rib-weather
  displayName: "Weather",
  registerTools: () => [weatherTool],
};

export default rib;
```

Registered tools reach the chat agent and workflow `prompt` nodes with no
extra wiring. See [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts)
for the full contract (snapshots, views, surfaces, workflow contributions)
and the [docs](https://danielscholl.github.io/keelson/) for a walkthrough.

---

## CLI

Once installed, `keelson` is on your PATH (working from `~/.keelson`):

```bash
keelson rib add chamber                   # install a rib into the home
keelson rib list --installed              # ribs in the home (no server needed)
keelson serve                             # run the API + WS server on :7878
keelson doctor                            # health sweep: toolchain, server, DB, auth, ribs
keelson workflow validate smoke-test      # schema + reference check
keelson workflow run smoke-test --watch   # run and stream output
keelson chat "hello" --provider stub      # one-shot turn
```

(Developing on Keelson itself runs the CLI from source — see [CONTRIBUTING.md](CONTRIBUTING.md).)

When the server is up, commands route over HTTP/WS; `workflow run` and `chat`
fall back to in-process execution when it's down. Every command takes `--json`,
with stable exit codes: `0` success, `1` failure, `2` bad args, `3` server
required but down, `4` not found.

---

## How it fits together

| Piece | What it is |
|---|---|
| **Surfaces** | React 19 + Vite SPA (Chat, Workflows) and the `keelson` CLI |
| **Providers** | One `IAgentProvider` over Copilot SDK, Claude Agent SDK, and a `stub` (offline/test, no keys) |
| **Ribs** | Capabilities that register tools through the typed `Rib` contract, each in its own repo |
| **Workflows** | Deterministic YAML DAG: `prompt` / `bash` / `command` / `loop` / `script` / `approval` / `cancel` nodes with `depends_on`, `when:`, `trigger_rule:` |
| **State** | SQLite (conversations, runs, node outputs, memory) plus your OS keychain for credentials |

The workflow engine borrows its schema and DAG concepts from
[Archon](https://github.com/coleam00/Archon) (MIT, by Cole Medin): most Archon
workflows load directly, and the loader warns rather than hard-errors on fields
it doesn't yet support. Full attribution lives in [NOTICE](NOTICE).

---

## Documentation

- **[danielscholl.github.io/keelson](https://danielscholl.github.io/keelson/)** : the documentation site (concepts, guides, the rib contract)
- [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) : the `Rib` contract
- [`.keelson/workflows/`](.keelson/workflows/) : bundled starter workflows
- [CONTRIBUTING.md](CONTRIBUTING.md) : setup, required checks, PR hygiene
- [SECURITY.md](SECURITY.md) : threat model and how to report

---

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
third-party attribution.
