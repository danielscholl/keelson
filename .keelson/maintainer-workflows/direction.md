# Keelson Direction

The `repo-triage` workflow consults this document to classify issues and to
reason about which contributions fit the project. It is committed and shared.
Edit it deliberately: when a triage decision needs justification, add a clause
here so the next run reaches the same conclusion. When noting that something runs
against the project, cite the clause (e.g. `direction.md §not-a-hosted-service`).

---

## What Keelson IS

- **A local-only, single-user agent harness.** It runs on one person's machine.
  The server binds to `127.0.0.1` and state-changing endpoints are gated to
  loopback origins. The harness is the deliverable.
- **A harness, not a monolith.** Capabilities live in **ribs**: installable
  `@keelson/rib-*` packages discovered at boot. The core never imports a rib.
- **Useful on its own.** Chat, Workflows, and Memory ship and work standalone
  with just a provider. Ribs extend the harness; they do not enable it.
- **Provider-agnostic.** One `IAgentProvider` over Copilot, Claude, Codex, the
  multi-vendor Pi, and an offline `stub`.
- **Deterministic where it counts.** Workflows are YAML DAGs the engine runs the
  same way every time, with the agent's leash declared in the file.
- **Local-state by design.** SQLite for conversations, runs, memory; the OS
  keychain for secrets. Nothing leaves the machine that the user did not send.
- **Alpha.** Claims track the code; known-partial areas are stated honestly.

## What Keelson is NOT

- **§not-a-hosted-service** — Not a hosted service or control plane. No
  multi-tenant accounts, no SaaS scaffolding, no proprietary backend.
- **§no-in-tree-ribs** — No ribs ship in the keelson repo. A new capability or
  tool belongs in a rib package, not in core. "Make it a rib" is usually the
  answer to a domain-integration request.
- **§core-never-imports-a-rib** — The boundary is load-bearing.
- **§ribs-extend-not-enable** — Positioning must never imply a rib is required
  for keelson to be useful.
- **§not-a-workflow-marketplace** — Bundled workflows are reference patterns.
- **§one-docs-identity** — The docs are one Astro Starlight site with a single
  identity; `docs/STYLE.md` is authoritative.
- **§alpha-honesty** — No marketing register, no claims about partial or dormant
  capabilities.

---

## Labels

Triage uses the repository's existing labels only. It never creates labels;
anything it cannot express with an existing label goes in the comment for the
maintainer to handle.

**Area** (the monorepo workspace the work lands in — apply the single most
relevant one, or none):

| Label | Scope |
|---|---|
| `apps/cli` | the `keelson` command, in-process fallback, exit codes |
| `apps/server` | HTTP/WS, store, handlers, composition root |
| `apps/web` | the React SPA surfaces |
| `packages/workflows` | DAG executor, schema, loader |
| `packages/providers` | provider adapters |
| `packages/shared` | the rib contract, snapshots, shared types |
| `packages/skills` | bundled skills |
| `github-actions` | CI, release, repo automation |

**Type** (apply the single best one, or none):

| Label | Meaning |
|---|---|
| `bug` | broken against documented or intended behavior |
| `enhancement` | new capability or improvement |
| `documentation` | docs only |
| `question` | a question or support request, not actionable work |

The repository also carries `duplicate`, `wontfix`, `invalid`, `help wanted`,
`good first issue`, and `dependencies`. Triage does **not** apply these; they are
maintainer judgment calls. If an issue looks like a duplicate, say so with the
`#N` in the comment rather than labeling it.

## Triage guidance

- Apply at most one `area:` and one `type:` label from the lists above, only when
  reasonably confident. Prefer none over a wrong guess.
- Put everything else in a terse, neutral comment for the maintainer:
  - a likely duplicate (cite the `#N`),
  - a stale issue (no recent activity, based on the age the run reports),
  - a bug report missing a reproduction or with an essentially empty body,
  - anything that runs against the project (cite the `direction.md` clause).
- The comment is a starting point for the maintainer, not a verdict. Be brief.
