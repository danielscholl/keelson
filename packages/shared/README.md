# @keelson/shared

Shared types, [zod](https://github.com/colinhacks/zod) schemas, and the
`Rib` extension contract for the [Keelson](https://github.com/danielscholl/keelson)
local agent harness.

## Install

```bash
bun add @keelson/shared
# or
npm install @keelson/shared
```

## What you get

- **`Rib` contract** — the interface external rib packages implement to
  register tools with the harness.
- **Wire schemas** — chat / workflow / WebSocket frame shapes the server
  emits, validated with zod.
- **Shared types** — `ToolDefinition`, `MessageChunk`, `ContentBlock`,
  `WorkflowRunStatus`, etc.

## Subpath exports

| Import | What's there | Runtime |
|---|---|---|
| `@keelson/shared` | Rib contract + wire schemas + UI/server-safe types | any |
| `@keelson/shared/chat` | Chat message + content-block schemas | any |
| `@keelson/shared/tools` | Tool registration types | any |
| `@keelson/shared/exec` | `runText` / `runJSON` helpers built on `Bun.spawn` | **Bun only** |

The root export deliberately omits `exec` so a browser build of a rib's
shared types compiles cleanly.

## Example: minimal rib

```ts
import type { Rib, RibContext } from "@keelson/shared";

export const myRib: Rib = {
  id: "my-rib",
  displayName: "My Rib",
  registerTools(ctx: RibContext) {
    // ctx.registerTool({ name: ..., description: ..., handler: ... })
    return { registered: [] };
  },
};
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party
attribution.
