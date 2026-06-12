# Keelson Direction

The maintainer automation (repo-triage, pr-review-bot) consults this document to
classify issues and PRs and to reason about which contributions fit the project.
It is committed and shared. Edit it deliberately: when a triage or decline
decision needs justification, add a clause here so the next run reaches the same
conclusion. When declining something, cite the clause (e.g.
`direction.md §not-a-hosted-service`).

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
  multi-vendor Pi, and an offline `stub`. Swappable per chat turn and per
  workflow node.
- **Deterministic where it counts.** Workflows are YAML DAGs the engine runs the
  same way every time, with the agent's leash declared in the file.
- **Local-state by design.** SQLite for conversations, runs, memory; the OS
  keychain for secrets. Nothing leaves the machine that the user did not send.
- **A Bun + TypeScript monorepo.** Strict TypeScript. Biome for lint/format.
- **Alpha.** Claims track the code. Known-partial areas are stated honestly
  (process-lifetime-only resume, redaction wired-but-inactive, offline fallback
  is stub-only).

## What Keelson is NOT

- **§not-a-hosted-service** — Not a hosted service or control plane. No
  multi-tenant accounts, no SaaS scaffolding, no proprietary backend. PRs adding
  these conflict with the local-only, single-user thesis.
- **§no-in-tree-ribs** — No ribs ship in the keelson repo. A new capability or
  tool belongs in a rib package, not in core. PRs that add a built-in tool or
  domain integration to the harness are decline candidates; the answer is "make
  it a rib."
- **§core-never-imports-a-rib** — The boundary is load-bearing. PRs that make the
  core depend on a specific rib break it.
- **§ribs-extend-not-enable** — Positioning must never imply a rib is required
  for keelson to be useful. Docs and copy name the standalone value first.
- **§not-a-workflow-marketplace** — Bundled workflows are reference patterns, not
  a distribution hub.
- **§one-docs-identity** — The docs are one Astro Starlight site with a single
  "keelson blueprint" identity. No second site generator, no per-page palette
  fork. `docs/STYLE.md` is authoritative.
- **§alpha-honesty** — No marketing register, no quantified hype, no claims about
  dormant or partial capabilities. Comments and copy serve future readers.

---

## Label taxonomy

Triage applies labels from this fixed set. The automation ensures these exist
(idempotent create) before applying.

**Area** (where the work lands, mirrors the monorepo):

| Label | Scope |
|---|---|
| `area:cli` | `apps/cli` — the `keelson` command, in-process fallback, exit codes |
| `area:server` | `apps/server` — HTTP/WS, store, handlers, composition root |
| `area:web` | `apps/web` — the React SPA surfaces |
| `area:workflows` | `packages/workflows` — DAG executor, schema, loader |
| `area:providers` | `packages/providers` — provider adapters |
| `area:ribs` | `packages/shared` rib contract, discovery, the extension seam |
| `area:docs` | `docs/` — the Starlight site and STYLE.md |
| `area:build` | install, release, CI, `scripts/` |

**Type** (what kind of work):

| Label | Meaning |
|---|---|
| `type:bug` | Something is broken against documented or intended behavior |
| `type:feature` | New capability or enhancement |
| `type:docs` | Documentation only |
| `type:chore` | Maintenance, refactor, dependency, tooling |
| `type:question` | A question or support request, not actionable work |

**Triage flags** (the automation's own signals, never closing on their own):

| Label | Meaning |
|---|---|
| `needs-info` | The report lacks enough detail to act (empty template, no repro) |
| `stale` | No activity for a while; a human should confirm or close |
| `possible-duplicate` | Likely a duplicate of another open issue (cited in a comment) |

## Triage guidance

- Apply exactly one `type:*` and the most-specific `area:*` (or none if unclear).
- Flag `needs-info` when a bug report has no reproduction or an obviously empty
  body, and say what's missing in the comment.
- Flag `possible-duplicate` only with a specific `#N` to compare against, and
  only when the symptom genuinely overlaps. Never close.
- Flag `stale` based on the staleness threshold the run passes in; never close.
- When an issue or PR proposes something the project does NOT do (see "What
  Keelson is NOT"), say so politely in the triage comment and cite the clause.
  Do not close it; surface it for the maintainer to decide.
- Be terse and neutral. The triage comment is a starting point for the
  maintainer, not a verdict.
