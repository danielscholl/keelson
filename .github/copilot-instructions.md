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
Do not raise comment *wording or style* nits. A comment that is factually wrong,
stale, or security-relevant is still worth flagging on its merits — the goal is to
stop style/coverage nits, not to ignore a substantively broken comment. Flag a
comment *for the policy* only when it violates it (narration / what-just-changed),
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
  `runWithRedaction` scope. Flag any path
  that writes a secret into a published snapshot/frame, persists or logs it outside
  a redaction scope, returns it somewhere other than the direct action result, or
  lets a rib read a credential outside its namespace.
- **Ribs attach only through the `Rib` contract** (`packages/shared/src/rib.ts`),
  a public surface whose breaking changes need a deprecation cycle. Every rib
  snapshot key, view, region, and bound workflow key must live under `rib:<id>` or
  `rib:<id>:*` (enforced by `assertInNamespace` at activation). Flag a change that reaches around
  the contract into harness internals, weakens the namespace guard, or narrows the
  contract without a deprecation path.
- **The loader tolerates unknown fields rather than rejecting.** Extra top-level
  and generic node keys don't fail the parse, so an older harness still loads a
  newer workflow. (The exceptions, which *do* fail: unparseable YAML, a broken DAG,
  and a schema explicitly marked strict — e.g. notebook blocks (`.strict()`).) Flag
  a loader change that makes an unknown *generic* field fatal, or that loosens a
  schema meant to be strict.
- **SQLite schema changes go through `db/migrations.ts`.** Migrations are an
  append-only list keyed by an integer version; the runner records each applied
  version in the `schema_version` table and `doctor` checks the DB is at the
  latest migration. (This is the DB schema — distinct from the wire `SCHEMA_VERSION`
  in `chat.ts`, which is the peer-contract version.) Flag a new table/column added
  outside a migration entry, or an edit to an already-shipped migration.
- **Shutdown is token-gated; clearing `server.json` is pid-guarded.** `POST
  /api/server/shutdown` requires the `server.json` bearer token via a constant-time
  compare. `stopOnce` clears the on-disk state only when the recorded pid is *this*
  process (so it never clobbers a newer server's record), then shuts down and exits.
  Flag a shutdown path that skips the token check (or compares non-constant-time),
  or a `clearServerState` that drops the pid-ownership check.
- **A declared `validate` fails closed.** `validate` is optional on snapshot
  registrations and bound rib workflows, but where one is declared it runs (a zod
  `.parse`) before a frame is cached or broadcast — an invalid payload is dropped
  and the prior value kept, so nothing malformed reaches a trusted renderer. Flag a
  change that weakens or bypasses an existing `validate`, or a producer of
  rib-shaped/attacker-influenced data that publishes to a trusted renderer without one.
- **Provider/tool determinism is operator-owned.** `KEELSON_WORKFLOW_PROVIDER`
  sets the *default* provider for `prompt` nodes — a node's or the workflow's own
  `provider:` overrides it; rib tools are registered **default-off** in
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
