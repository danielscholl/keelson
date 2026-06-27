# Keelson

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Status: Beta](https://img.shields.io/badge/status-beta-blue.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

**The hull. Not the crew.**

Keelson is a local control plane for coding agents. It turns agent work from one-off chats into durable, repeatable runs with persistent state, workflows with deterministic control flow, provider routing, governance hooks, and a typed extension model called ribs. The same capabilities are available from a browser UI, an interactive terminal, one-shot prompts, or MCP.

Most agent tools are centered on a single chat, model, or editor session. Keelson is centered on the local harness around that work. It keeps state on your machine, captures repeatable tasks as workflows, and lets new capabilities attach as packages instead of forks.

Use Keelson when you want to:

- Turn one-off agent chats into repeatable workflows.
- Mix agent turns with deterministic shell, script, approval, loop, and control steps.
- Keep conversations, runs, outputs, memory, and rib data on your machine.
- Route different providers through one local interface.
- Add capabilities as packages instead of forking the harness.
- Put governance around tool calls and agent turns.
- Expose the same registered tools to other agents over MCP.

## What makes Keelson different

| Capability | What it means |
| --- | --- |
| Durable agent workbench | Agent chats, workflow runs, outputs, projects, and memory survive beyond a single terminal, editor, or model session. |
| Local control plane | One server on your laptop owns the state, providers, API, WebSocket stream, MCP endpoint, and browser UI. |
| One capability set, many surfaces | Reach the same tools, conversations, and runs from a browser UI, an interactive terminal, one-shot prompts, or the MCP endpoint. |
| Provider routing | Route Copilot, Claude, Codex, Pi, and OpenAI-compatible gateways through one interface. |
| Deterministic workflows | Capture repeatable work with explicit control flow, approvals, shell/script steps, and agent turns. |
| Persistent state | Conversations, workflow runs, outputs, projects, and memory live in SQLite. |
| Keychain-backed secrets | Provider keys and rib credentials stay in your OS keychain, not in the home directory. |
| Governance | Optional policies can pause, deny, or redact tool calls around every agent turn. |
| Ribs | Install `@keelson/rib-*` packages that add tools, workflows, snapshots, and UI surfaces. |
| MCP endpoint | External agents can call registered Keelson tools through the local MCP endpoint. |

## What Keelson is not

Keelson is intentionally small in scope.

- It is not a hosted platform or multi-user SaaS.
- It is not a plugin sandbox. A rib is code you choose to run on your machine.
- It is not a general CI system or build farm.
- It is not a replacement for provider auth, execution policies, or sandboxing.

## Install

### Prerequisites

Install [Bun](https://bun.sh/) first. On macOS, Linux, and WSL, make sure `~/.local/bin` is on your `PATH`.

### macOS, Linux, and WSL

```bash
curl -fsSL https://github.com/danielscholl/keelson/releases/latest/download/install.sh | sh
keelson version
```

The installer provisions the managed home at `~/.keelson` and drops a `keelson` launcher in `~/.local/bin`.

### Windows PowerShell

```powershell
irm https://github.com/danielscholl/keelson/releases/latest/download/install.ps1 | iex
keelson version
```

The Windows installer provisions `%USERPROFILE%\.keelson`, installs `keelson.cmd` under `%LOCALAPPDATA%\keelson\bin`, and adds that bin directory to your user `PATH`.

### Upgrade or repair

```bash
keelson update
keelson update --check
```

You can also rerun the installer. Upgrades preserve installed ribs and local data.

## Quick start

Start the server in the background, then open the browser UI:

```bash
keelson start
open http://127.0.0.1:7878
keelson doctor
```

Use `keelson stop` to shut the background server down.

### Chat with an agent

Open an interactive session in the terminal, or fire a single prompt:

```bash
keelson chat                                  # interactive terminal chat
keelson chat "summarize what this repo does"  # one-shot
```

The browser UI at `http://127.0.0.1:7878` is the same chat on the same server. Agent turns need a configured provider: Copilot, Claude, Codex, Pi, or an OpenAI-compatible gateway. No paid keys? Point a gateway at a local model with Ollama or vLLM (see [Providers and gateways](#providers-and-gateways)).

### Run a workflow

A workflow captures repeatable agent work so it can be inspected, rerun, shared, or guarded instead of handled as a one-off chat. Workflows mix agent turns with deterministic shell, script, approval, loop, and control steps.

```bash
keelson workflow list
keelson workflow validate smoke-test
keelson workflow run smoke-test --watch
```

When the server is running, workflow commands route over HTTP and WebSocket. When the server is down, `workflow run` can fall back to in-process execution.

## Add capabilities with ribs

Ribs are packages that Keelson discovers at boot. They can register tools, workflows, snapshots, and UI surfaces.

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-chamber
keelson stop
keelson start
keelson rib list
```

The Chamber rib is a good first example. It adds persistent specialist agents called Minds, multi-agent rooms, and agent-authored lenses.

Other source forms work too:

```bash
keelson rib add github:you/keelson-rib-yours
keelson rib add git@github.com:you/keelson-rib-yours.git
keelson rib add @keelson/rib-yours
keelson rib add ./local-rib
```

Installed ribs live under the Keelson home and activate on the next server boot. To activate only selected ribs, set `KEELSON_RIBS`:

```bash
KEELSON_RIBS=chamber keelson start
```

A rib runs inside your local harness. Install ribs from sources you trust.

## Providers and gateways

Enable providers in `~/.keelson/config.json`:

```json
{
  "providers": {
    "copilot": true,
    "claude": true,
    "codex": true,
    "pi": true
  },
  "defaultProvider": "copilot"
}
```

`KEELSON_PROVIDERS` overrides the file when set. For an OpenAI-compatible endpoint, add a gateway:

```bash
keelson gateway add ollama http://localhost:11434/v1 --model qwen3
```

## Use Keelson from other agents with MCP

When the server is running, registered tools are available over the local MCP endpoint:

```text
http://127.0.0.1:7878/api/mcp
```

Example client configuration:

```jsonc
{
  "mcpServers": {
    "keelson": {
      "type": "http",
      "url": "http://127.0.0.1:7878/api/mcp"
    }
  }
}
```

The endpoint is local by default, but it can expose state-changing tools. Add a token, restrict tools, or make the endpoint read-only before proxying it outside your machine.

## CLI reference

Useful commands:

```bash
keelson start                    # start the local server in the background
keelson stop                     # stop the background server
keelson status                   # report server status
keelson doctor                   # health sweep for toolchain, server, DB, auth, and workflows
keelson chat "hello"             # chat turn (omit the message for interactive)
keelson workflow run <name>      # run a workflow
keelson rib list --installed     # list installed ribs without needing the server
keelson update --check           # check for available updates
keelson --json workflow list     # machine-readable output for scripts
```

For scripting, Keelson supports `--json` output and stable exit codes. See the [CLI reference](https://danielscholl.github.io/keelson/docs/reference/cli/) for details.

## Uninstall

There are two kinds of uninstall: remove a rib, or remove the whole harness.

### Remove a rib only

```bash
keelson rib remove chamber
keelson stop
keelson start
```

This removes the package from the home. Some ribs keep private data under `$KEELSON_HOME/rib-<id>`. Delete that directory only when you want to discard the rib's local data.

Example for Chamber:

```bash
rm -rf "${KEELSON_HOME:-$HOME/.keelson}/rib-chamber"
```

### Full uninstall on macOS, Linux, or WSL

```bash
keelson stop 2>/dev/null || true
KEELSON_HOME="${KEELSON_HOME:-$HOME/.keelson}"
rm -f "$HOME/.local/bin/keelson"
rm -rf "$KEELSON_HOME"
```

This removes the launcher and the managed home. The home contains your database, workflows, installed ribs, rib data directories, server record, and logs.

If you added `~/.local/bin` to your shell profile only for Keelson, remove that PATH entry from `~/.zshrc`, `~/.bashrc`, or the file where you added it.

### Full uninstall on Windows PowerShell

```powershell
keelson stop 2>$null
$KeelsonHome = if ($env:KEELSON_HOME) { $env:KEELSON_HOME } else { Join-Path $HOME ".keelson" }
Remove-Item -Force "$env:LOCALAPPDATA\keelson\bin\keelson.cmd" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $KeelsonHome, "$env:LOCALAPPDATA\keelson" -ErrorAction SilentlyContinue

# Remove Keelson's bin directory from the user PATH.
$KeelsonBin = "$env:LOCALAPPDATA\keelson\bin"
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$NewPath = ($UserPath -split ";" | Where-Object { $_ -and ($_ -ne $KeelsonBin) }) -join ";"
[Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
```

### Optional credential cleanup

Keelson does not store provider secrets in the home directory. Provider keys and rib credentials live in your OS keychain under the `keelson` service. Remove those entries with Keychain Access, Windows Credential Manager, or your Linux secret store if you want a credential-clean uninstall.

## Documentation

- [Keelson docs](https://danielscholl.github.io/keelson/): concepts, guides, workflow reference, CLI reference, and rib contract.
- [Writing ribs](WRITING-RIBS.md): the five-minute rib authoring quickstart.
- [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts): the full `Rib` contract.
- [`packages/workflows/assets/workflows/`](packages/workflows/assets/workflows/): bundled starter workflows.
- [CONTRIBUTING.md](CONTRIBUTING.md): local setup and required checks.
- [SECURITY.md](SECURITY.md): threat model and reporting process.

## License

Keelson is licensed under the [Apache License 2.0](LICENSE). Third-party attribution lives in [NOTICE](NOTICE).
