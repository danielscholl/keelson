---
description: Prime understanding of the keelson harness — architecture, the rib contract, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working mental model of keelson — a local-only agent harness whose
    capabilities live in ribs (extensions) — fast enough to navigate the
    monorepo and respect its contracts before making a change.
  </objective>

  <constraints>
    <rule>Stay bounded. Read the named contract files in full (they are small and
      load-bearing); for everything else, LIST and skim, don't deep-read.</rule>
    <rule>DO NOT read test files — note their existence and count only.</rule>
    <rule>DO NOT read SPA component internals or provider SDK adapters — list them.</rule>
    <rule>DO NOT launch subagents — this is a single-pass orientation.</rule>
    <rule>CLAUDE.md is already in context as project instructions; don't re-read
      it, build on it.</rule>
  </constraints>

  <phase number="1" name="orient">
    <step name="layout">
      <action>Map the monorepo shape — workspaces and rough size, not every file.</action>
      <command>git ls-files | sed 's#/.*##' | sort | uniq -c | sort -rn | head -20</command>
      <note>Seven Bun workspaces: apps/{cli,server,web} and
        packages/{shared,workflows,providers,skills}.</note>
    </step>
    <step name="readme">
      <action>Read README.md.</action>
      <extract>The pitch: harness is the deliverable, ribs bolt on capabilities.
        Surfaces (Chat / Workflows / Memory), and how to run it.</extract>
    </step>
  </phase>

  <phase number="2" name="load-the-contracts">
    <intent>These few files ARE the architecture. Read them — understanding them
      is understanding keelson.</intent>
    <step name="rib-contract">
      <action>Read packages/shared/src/rib.ts</action>
      <extract>The `Rib` interface — the typed extension contract. What a rib may
        contribute (views, actions, tools, workflows, snapshot keys, agent turns)
        and which accessors are optional / fail closed.</extract>
    </step>
    <step name="snapshots">
      <action>Read packages/shared/src/snapshots.ts</action>
      <extract>`SnapshotManager` / `SnapshotFrame` — the domain-free streaming
        substrate ribs (and workflow runs) publish onto.</extract>
    </step>
    <step name="composition-root">
      <action>Read apps/server/src/rib-discovery.ts, then skim the bootstrapRibs()
        path in apps/server/src/index.ts.</action>
      <extract>Discovery is at boot: installed `@keelson/rib-*` packages under
        node_modules/@keelson/ are wired automatically; `KEELSON_RIBS` filters
        which activate; embedders can pass an explicit `available` map. No ribs
        ship in-tree.</extract>
    </step>
    <step name="workflow-engine">
      <action>Skim packages/workflows/src/loader.ts.</action>
      <extract>The lenient YAML loader (unknown fields warn, don't hard-error)
        and the node taxonomy: prompt / bash / command / loop / script / approval
        / cancel.</extract>
    </step>
  </phase>

  <phase number="3" name="runtime-topology">
    <action>List (don't deep-read) the three apps to fix the request flow in mind.</action>
    <points>
      <point>apps/cli — the `keelson` CLI. Commands route to the server over
        HTTP/WS when it's up, else fall back to in-process (apps/cli/src/in-process/).
        Stable exit codes 0–4.</point>
      <point>apps/server — Bun HTTP/WS server on :7878. Owns the SQLite store,
        keychain credentials, the redaction pipeline, and the chat / memory /
        workflow / snapshot handlers. Schema migrations in src/db/migrations.ts.</point>
      <point>apps/web — React 19 + Vite SPA on :5173 (Chat + Workflows). `/api`
        proxies to the server.</point>
      <point>packages/providers — coding-agent SDKs behind `IAgentProvider`
        (Copilot, Claude, stub). packages/skills — bundled skills.</point>
    </points>
  </phase>

  <phase number="4" name="inventory">
    <step name="workflows"><command>ls .keelson/workflows/</command></step>
    <step name="ribs"><command>ls node_modules/@keelson/ 2>/dev/null | grep '^rib-' || echo "(no ribs installed)"</command></step>
    <step name="commands"><command>ls .claude/commands/ 2>/dev/null</command></step>
    <step name="tests">
      <action>Count test files per workspace; report counts only.</action>
      <command>git ls-files '*.test.ts' '*.test.tsx' | sed 's#/.*##' | sort | uniq -c</command>
    </step>
  </phase>

  <phase number="5" name="conventions">
    <action>Skim CONTRIBUTING.md for the rules that gate a PR.</action>
    <points>
      <point>Required green before a PR: `bun run check`, `bun --filter '*' typecheck`,
        `bun --filter '*' test` (and `bun --filter '*' build`).</point>
      <point>Comments: default to none; capture non-obvious *why*; no milestone/issue
        tokens or what-just-changed narration (see CONTRIBUTING "Comments").</point>
      <point>Commits: conventional, one-sentence subject. PR body: What / Why now /
        Test plan, plus an optional Risk & rollback block.</point>
      <point>Architecture rule: core never imports `@keelson/rib-*`; new tools live
        in a rib, not core.</point>
    </points>
  </phase>

  <phase number="6" name="summarize">
    <format>Concise markdown — no multi-page dump:</format>
    <sections>
      <section>Project: 1–2 sentences (local-only agent harness; ribs add capability).</section>
      <section>Architecture: the harness ⇄ rib seam, in 2–3 sentences.</section>
      <section>Workspaces: the 7, one line each on responsibility.</section>
      <section>Key contracts: rib.ts, snapshots.ts, rib-discovery/bootstrapRibs, loader.ts.</section>
      <section>Commands: dev / typecheck / test / check.</section>
      <section>Workflows &amp; ribs: bundled workflows; installed ribs (or none).</section>
      <section>Conventions: comments, commits, PR shape, the core/rib boundary.</section>
      <section>Where to start: which file to open first for the kind of change at hand.</section>
    </sections>
  </phase>

  <anti-patterns>
    <avoid>Reading every source file to "understand patterns" — read the named
      contracts, list the rest.</avoid>
    <avoid>Reading test files or SPA component internals to "understand the approach".</avoid>
    <avoid>Launching subagents.</avoid>
    <avoid>Producing a multi-page summary.</avoid>
  </anti-patterns>
</prime-command>
