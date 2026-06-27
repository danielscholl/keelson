# Writing a rib

A rib is an installable extension that bolts capability onto the Keelson harness
— tools, surfaces, workflows, policies — through one typed contract. No ribs ship
in-tree; each lives in its own repo or package and is discovered at boot. This is
the five-minute version; the [full `Rib` contract](packages/shared/src/rib.ts) and
the [reference docs](https://danielscholl.github.io/keelson/docs/reference/rib-contract/)
cover every hook.

## The smallest useful rib

A rib default-exports an object implementing the `Rib` contract. Registering one
tool is enough to reach the chat agent and workflow `prompt` nodes — no further
wiring:

```ts
import type { Rib, ToolDefinition } from "@keelson/shared";
import { z } from "zod";

const ping: ToolDefinition = {
  name: "demo_ping", // family "demo" (the substring before the first underscore)
  description: "Echo a message back to the agent.",
  inputSchema: z.object({ message: z.string() }),
  async execute(input, ctx) {
    const { message } = input as { message: string };
    ctx.emit({ type: "tool_result", toolUseId: "", content: `pong: ${message}` });
  },
};

const rib: Rib = {
  id: "demo", // matches the package basename: @keelson/rib-demo
  displayName: "Demo",
  registerTools: () => [ping],
};

export default rib;
```

## What a rib can contribute

Every hook is optional — implement any subset:

- **Tools** (`registerTools`) — reach chat and workflow `prompt` nodes.
- **Snapshots, views, surfaces** — live panels and a top-level nav tab, no per-rib UI code.
- **Workflows** (`contributeWorkflows`) — catalog entries, optionally bound to a snapshot key.
- **Policies** (`contributePolicies`) — ask / deny / redact rules in the governance stack.
- **Agents and slash commands** — seeded chats and composer commands.

## Load it

Package the rib as `@keelson/rib-<id>` (or a `keelson-rib-<name>` GitHub repo),
then point Keelson at any git URL, npm name, or local path:

```bash
keelson rib add ./keelson-rib-demo   # a local path, while developing
keelson rib list --installed
```

The server discovers it at boot; `KEELSON_RIBS=<id1>,<id2>` filters which of the
installed ribs activate (unset activates all).

## Next

- [`packages/shared/src/rib.ts`](packages/shared/src/rib.ts) — the full `Rib` contract
- [Rib contract reference](https://danielscholl.github.io/keelson/docs/reference/rib-contract/) — every hook, the validation rules, and a surface-producing example
- [Managing ribs](https://danielscholl.github.io/keelson/docs/guides/managing-ribs/) — install / inspect / update / remove
