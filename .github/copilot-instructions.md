# Copilot code review — instructions for keelson

This repo is the **Keelson harness itself** — a local-only agent harness, not a
rib. The harness is the deliverable; capabilities live in **ribs** (external
`@keelson/rib-*` packages) that bolt on through a typed contract. It is a Bun
monorepo of 8 workspaces: `apps/{cli,server,web}` and
`packages/{shared,workflows,providers,skills,mcp}`. The server (`:7878`) owns the
SQLite store, keychain credentials, the redaction pipeline, and the
`bootstrapRibs()` composition root; the CLI routes to it over HTTP/WS and falls
back to in-process; the SPA is React + Vite. See `CLAUDE.md` and
`CONTRIBUTING.md` for the full architecture and rules.

## How to review

Be terse and cite `file:line`. Prefer a few high-signal findings over breadth.
This is single-user, local software — ignore speculative scale, multi-tenant, and
micro-optimization concerns. No poems, jokes, or emoji.

## Comment policy — do NOT push comments or docstrings

`CONTRIBUTING.md` sets a deliberate **no-narration** policy. Do **not**:

- Ask for docstrings or comment coverage. Comments are optional; a one-line
  soft-wrap is fine and should not be flagged.
- Suggest comments that narrate what a PR changed, restate well-named code, recap
  review history, or carry milestone/issue shorthand (`#123`, `Slice 4`, `M7`).

A comment is warranted only when it captures a non-obvious **why** (a hidden
constraint, a workaround, an order dependency, an invariant from another module).
Flag a comment only when it *violates* the policy (narration / what-just-changed),
not when one is merely absent. Never repeat one observation across N sites — make
the point once, on the clearest instance.

## Invariants to flag when a change breaks them

- **The harness/rib boundary holds.** Core (`apps/{cli,server,web}`,
  `packages/{shared,workflows,providers,skills,mcp}`) must never import from
  `@keelson/rib-*`, and new tools belong in a rib, not core. Flag a core import of
  a rib package, a tool registration added to core instead of a rib, or core code
  that hardcodes a specific rib's id/keys.
- **Secrets never enter a snapshot or a log.** Credentials live in the OS keychain
  (`@napi-rs/keyring`); a rib gets a read-only reader scoped to its own namespace
  and cannot reach another rib's keys. Console output is scrubbed only inside a
  `runWithRedaction` scope (the credential-reveal route opens one). Flag any path
  that writes a secret into a published snapshot/frame, persists or logs it outside
  a redaction scope, returns it somewhere other than the direct action result, or
  lets a rib read a credential outside its namespace.
- **Ribs attach only through the `Rib` contract** (`packages/shared/src/rib.ts`),
  a public surface whose breaking changes need a deprecation cycle. Every rib
  snapshot key, view, region, and bound workflow key must live under `rib:<id>:*`
  (enforced by `assertInNamespace` at activation). Flag a change that reaches around
  the contract into harness internals, weakens the namespace guard, or narrows the
  contract without a deprecation path.
- **The workflow YAML loader is intentionally lenient.** Unknown fields surface as
  `warnings` data (and `--strict` refuses them), never a hard parse error, so an
  older harness still loads a newer workflow. Flag a loader change that turns an
  unknown field into a fatal error or otherwise makes the parser reject-by-default.
- **SQLite schema changes go through `db/migrations.ts`.** Migrations are an
  append-only list keyed by version; the runner records each in `schema_version`
  and `doctor` checks it matches `SCHEMA_VERSION`. Flag a new table/column added
  outside a migration entry, an edit to an already-shipped migration, or a schema
  change that doesn't bump `SCHEMA_VERSION` in lockstep.
- **Server lifecycle is token-gated and pid-identity-guarded.** `POST
  /api/server/shutdown` requires the `server.json` bearer token via a
  constant-time compare, and `stopOnce` only clears state / exits when the
  recorded pid is *this* process. Flag a shutdown path that skips the token check
  (or compares non-constant-time), or a stop that signals/clears a pid without
  confirming identity.
- **Producers fail closed through `validate`.** Snapshot registrations and bound
  rib workflows run a `validate` (a zod `.parse`) before a frame is cached or
  broadcast — an invalid payload is dropped and the prior value kept, so nothing
  malformed reaches a trusted renderer. Flag a producer that publishes to a canvas
  key without validation, or a path that broadcasts an unvalidated frame.
- **Provider/tool determinism is operator-owned.** `KEELSON_WORKFLOW_PROVIDER`
  pins the provider for `prompt` nodes; rib tools are registered **default-off** in
  workflow prompt nodes (a node sees a rib tool only via explicit `allowed_tools`);
  `KEELSON_WORKFLOW_TOOL_DENYLIST` is the operator floor the policy engine enforces.
  Flag a change that exposes rib tools to prompt nodes by default or bypasses the
  denylist floor.

## What NOT to flag

- Missing docstrings or comments (see the comment policy above).
- Tests using `bun:test`, fixtures, or mock-vs-real tradeoffs — these are
  intentional.
- Speculative scale, multi-tenant, or micro-optimization concerns — this is
  single-user local software.
- Formatter-owned style: import order, quotes, spacing, and line width are Biome's
  job (`bun run check`), not a review comment.
- The absence of an abstraction — this repo avoids abstractions ahead of a
  concrete second caller.
