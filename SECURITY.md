# Security Policy

Thanks for taking the time to make Keelson safer.

## Supported versions

Keelson is pre-1.0 (`0.x`) software. Security fixes land on the latest
minor release line only. Once 1.0 ships, this policy will document a
longer support window.

| Version  | Supported          |
|----------|--------------------|
| 0.1.x    | :white_check_mark: |
| < 0.1    | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.** Public
issues become indexable the moment they're created and give an attacker
a head start on any users who haven't updated yet.

Instead, report privately via one of these channels:

- Email: **degnome@gmail.com** with subject line `[keelson security]`
- GitHub private vulnerability report:
  <https://github.com/danielscholl/keelson/security/advisories/new>

A useful report includes:

- A description of the issue and the impact you observed (or believe is
  possible)
- The Keelson version (`keelson version --json`), Bun version
  (`bun --version`), and OS where you reproduced it
- A minimal proof-of-concept or reproduction steps
- Any mitigations or workarounds you've found

I'll acknowledge new reports within **3 business days** and aim to have a
fix or mitigation plan within **14 days** of acknowledgement, faster for
issues with a public PoC or active exploitation. If a report turns out
to be out of scope, I'll explain why.

## Scope and threat model

Keelson is a **local, single-user** harness. It runs on the operator's
laptop, calls local CLIs, and talks to provider APIs only via
keychain-stored credentials the operator added themselves. The threat
model assumes:

- The operator trusts their own machine and the workflows they author.
- Hostile inputs may arrive over the network from provider responses,
  tool outputs, or fetched URLs.
- Ribs (loaded via the embedder's manifest) run with the same privileges
  as the harness — a malicious rib is equivalent to malicious local
  code and is **outside** the threat model.

### In scope

- Command injection or path traversal in any handler that splices
  untrusted data (provider output, upstream node output, workflow YAML
  fields) into a shell, child process, or filesystem path
- Authentication or credential leakage paths (the keytar store, the
  redacted-console pipeline, the credentials drawer)
- The browser ↔ server channel: origin / WebSocket-upgrade checks
  (`isAllowedOrigin` in `apps/server/src/chat-handler.ts`) and any
  bypasses that would let a non-loopback origin reach the API
- Sandboxing or capability escapes: a workflow node executing code or
  reading files outside the operator's intent
- Supply-chain integrity of bundled assets (the lockfile is the source
  of truth — see `bun.lock`)

### Out of scope

- Behavior under a hostile rib (treat ribs as trusted code; vet them
  before adding to your manifest)
- Issues that require a hostile party to already have local code-
  execution or filesystem access on the operator's machine
- Provider-side issues (Copilot SDK, Claude Agent SDK) — please report
  those upstream
- Cosmetic issues, denial-of-service via large inputs to local-only
  surfaces (you can already crash your own laptop), and CSS / a11y bugs
  (file those as regular issues)

## Disclosure

After a fix lands and is released, I'll publish a GitHub security
advisory with a CVE if one is warranted, credit the reporter (unless
they prefer to stay anonymous), and link to the relevant commits and
release notes.
