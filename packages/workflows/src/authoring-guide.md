# Keelson Workflow Authoring Guide

## Overview

A keelson workflow is one YAML file describing a DAG of nodes. Workflows live in
two scopes:

- **global** — `<keelson home>/workflows/`, visible everywhere.
- **project** — `<project root>/.keelson/workflows/`, visible only to
  conversations and runs inside that project. A project workflow **shadows** a
  same-named global one within its project.

The catalog hot-reloads: a saved file is listable and runnable immediately, no
server restart. The workflow's `name:` field — not the filename — is its
catalog key, and the two must match.

## Authoring flow

1. Call `workflow_get` on a similar existing workflow and adapt its shape —
   starting from a working example beats a blank page.
2. Draft the YAML. Prefer inline `prompt` / `bash` / `script` nodes; a
   `command:` node references a markdown file that must already exist on disk
   and cannot be authored from chat.
3. Call `workflow_validate` with the draft. Fix every error and re-validate
   until it parses cleanly. Treat warnings as advisory but read them.
4. Show the user the complete final YAML and confirm the scope ("project" =
   this conversation's project, "global" = all projects) and whether an
   existing file may be overwritten.
5. Call `workflow_save`. The save validates again and refuses to write a
   broken workflow.

## Top-level fields

Required:

- `name` — kebab-case identifier (`pr-review`, not `PR Review`). Must equal
  the name you save under. `runs` is reserved.
- `description` — see the description format section below.
- `nodes` — non-empty list of DAG nodes.

Optional:

- `provider` — `claude`, `copilot`, or `stub`; omitted = the runner's default.
- `model` — default model for AI nodes.
- `modelReasoningEffort` — `minimal` | `low` | `medium` | `high` | `xhigh`.
- `webSearchMode` — `disabled` | `cached` | `live`.
- `interactive: true` — required when any loop node sets
  `loop.interactive: true`.
- `tags` — list of strings for filtering.
- `worktree` — `{ enabled: true|false, branch: "template" }` pins git-worktree
  isolation per run; `branch` accepts `{workflow}` and `{run_id_short}`
  placeholders.
- `requiresProject: true` — marks a repo-scoped workflow; `workflow_run` refuses
  to start it unless the resolved working directory is a git repo.
- `converge` — `{ gate, max_rounds, on_exhaust }` re-runs the gate node's
  dependency subgraph until the gate completes or the round budget exhausts.
- `effort` (`low`|`medium`|`high`|`max`) and `thinking`
  (`adaptive`|`enabled`|`disabled` or `{type, budgetTokens}`) — claude-only
  reasoning controls.

Accepted but ignored at runtime (the loader warns and drops them): `sandbox`,
`betas`, `fallbackModel`, `additionalDirectories`, `mutates_checkout`.

## Description format

Use the structured block-scalar convention — the Workflows UI cards and the
`workflow_list` tool parse these labels:

```yaml
description: |
  Use when: a PR needs a structured review before merge
  Triggers: "review PR 42", "look at this pull request"
  Does: fetches the diff, reviews it, posts findings as a comment
  NOT for: writing new code or fixing the issues it finds
```

All four labels are optional but `Use when:` and `Does:` should always be
present. Keep each to one line.

## Node types

Every node has an `id` plus **exactly one** of these seven mode fields:

`prompt` — an inline AI instruction. The default choice for agent work:

```yaml
- id: summarize
  prompt: |
    Read the test output in $run-tests.output and summarize failures.
```

`bash` — a deterministic shell script; stdout becomes the node's output.
Optional `timeout` in ms:

```yaml
- id: run-tests
  bash: bun test 2>&1 | tail -50
  timeout: 120000
```

`script` — inline TypeScript/JavaScript (`runtime: bun`) or Python
(`runtime: uv`); `runtime` is required, optional `deps` lists packages:

```yaml
- id: parse
  script: |
    const data = JSON.parse(await Bun.stdin.text());
    console.log(data.items.length);
  runtime: bun
```

`approval` — pauses the run for a human decision. `capture_response: true`
exposes the reply as the node's output; `on_reject` re-prompts on rejection:

```yaml
- id: gate
  approval:
    message: "Apply this plan?"
    capture_response: true
```

Before an approval gate, a workflow may attach a run brief by writing
`$ARTIFACTS_DIR/brief.json` as `{ sourceUrl?, title?, criteria: string[] }`.
When the brief has criteria, a preceding reasoning node can write
`$ARTIFACTS_DIR/coverage.json` as `{ coverage: [{ criterion, covered, step }] }` —
a covered row must name a string `step`; an uncovered row must use `step: null`.
The server reconciles it against `brief.criteria` (every criterion is rendered, in
brief order; a criterion the model omitted, reordered, or marked covered without a
step shows **MISSING**), persists the brief, and renders the checklist into the
approval message. A missing or invalid coverage artifact renders every criterion
**MISSING** (fail-visible); an empty-criteria brief is a no-op.

`loop` — repeats an AI prompt until `until` text appears in the output (or
`until_bash` exits 0), bounded by `max_iterations`; `fresh_context: true`
starts a new session each iteration. `loop.interactive: true` requires
workflow-level `interactive: true` and a `gate_message`:

```yaml
- id: fix-until-green
  loop:
    prompt: "Run the tests, fix one failure, reply DONE when all pass."
    until: "DONE"
    max_iterations: 5
```

`cancel` — terminates the run with a reason; pair with `when` for guard
branches:

```yaml
- id: bail
  cancel: "nothing to do"
  when: "$classify.output == 'NONE'"
```

`command` — runs a named markdown prompt from `.keelson/commands/`. The file
must already exist on disk; from chat, use an inline `prompt` node instead.

## Common node fields

- `depends_on: [other-id, ...]` — DAG edges; omitted = root node.
- `when: "<condition>"` — skip the node unless the condition holds. Compare
  upstream outputs: `$classify.output == 'BUG'`,
  `$check.output.count != '0'`; operators `==`, `!=`, `<`, `>`, `<=`, `>=`,
  combined with `&&` / `||`.
- `trigger_rule` — join semantics when multiple dependencies finish:
  `all_success` (default) | `one_success` | `none_failed_min_one_success` |
  `all_done`.
- `model`, `provider` — per-node overrides (AI nodes).
- `context: fresh | shared` — `fresh` forces a new AI session for the node.
- `allowed_tools` / `denied_tools` — tool-name filters for AI nodes.
  Rib-registered tools are default-off; opt in with `allowed_tools`.
- `output_schema` — JSON-Schema subset the node output must satisfy.
- `output_format` — provider structured-output request (claude).
- `retry: { max_attempts, delay_ms, on_error }` — `max_attempts` 1–5
  (required), `delay_ms` 1000–60000 (doubled each attempt), `on_error`
  `transient` (default) | `all`. Not allowed on loop nodes.
- `always_run: true` — re-execute this node on a resumed run even if it
  succeeded before (a gate/validation re-checks instead of replaying a stale
  pass). Off by default: a succeeded node is skipped on resume.
- `fail_on_tool_error: true` — fail the node if any invoked tool errored.
- `idle_timeout` — ms of AI-stream silence before the node fails.
- `systemPrompt`, `effort`, `thinking` — claude-only per-node controls.
- `memory` / `notebook` — recall/writeback blocks wired to the memory store
  and project notebook.
- `hooks` — fully honored only by the claude provider.

Ignored with a warning on any node: `agents`, `sandbox`, `betas`,
`fallbackModel`, `maxBudgetUsd`, `mcp`, `skills`. AI-only fields on
non-AI nodes (bash/script/loop/approval/cancel) are also ignored with a
warning.

## Variables and data flow

- `$ARGUMENTS` — the free-form text the run was started with.
- `$1` … `$9` — positional words of `$ARGUMENTS`; `\$` escapes a literal `$`.
- `$<nodeId>.output` — full text output of an upstream node; the node must be
  an ancestor via `depends_on`. Forward or sibling references are validation
  errors.
- `$<nodeId>.output.<field>` — a field of the upstream output after JSON
  parsing (empty string when the output isn't JSON).
- `$ARTIFACTS_DIR` — per-run scratch directory in prompt text; bash nodes see
  it as the `$KEELSON_ARTIFACTS_DIR` environment variable.
- `$converge.round` — current converge round while a node runs inside a
  `converge` subgraph; empty outside converge rounds.

Reserved node ids (they collide with substitution namespaces): `inputs`,
`ARGUMENTS`, `ARTIFACTS_DIR`, `memory`, `converge`.

## Control flow patterns

Fan-out/fan-in — independent nodes run in parallel, a join waits for all:

```yaml
nodes:
  - id: lint
    bash: bun run check
  - id: types
    bash: bun --filter '*' typecheck
  - id: verdict
    prompt: "Summarize: lint=$lint.output types=$types.output"
    depends_on: [lint, types]
```

Conditional branch — classify, then gate each branch with `when`:

```yaml
  - id: classify
    prompt: "Reply with exactly BUG or FEATURE for: $ARGUMENTS"
  - id: fix
    prompt: "Investigate and fix: $ARGUMENTS"
    depends_on: [classify]
    when: "$classify.output == 'BUG'"
```

Approval gate — plan, pause for a human, then act on approval:

```yaml
  - id: plan
    prompt: "Draft a plan for: $ARGUMENTS"
  - id: gate
    approval:
      message: "Run this plan?"
    depends_on: [plan]
  - id: execute
    prompt: "Execute the plan: $plan.output"
    depends_on: [gate]
```

Converge — re-run a gate's dependency subgraph until the gate passes:

```yaml
converge:
  gate: checks
  max_rounds: 3
  on_exhaust: approval
nodes:
  - id: fix
    prompt: "Fix the failing checks (round $converge.round)."
  - id: checks
    depends_on: [fix]
    bash: gh pr checks --watch
  - id: summarize
    depends_on: [checks]
    prompt: "Summarize the final checks: $checks.output"
```

`gate` names an existing node. Each round runs that gate plus its transitive
`depends_on` ancestors, then resets those outputs before the next round so
`$node.output` refs are round-scoped. `max_rounds` is 1–10. `on_exhaust` is
`fail` (default) or `approval`; approval pauses for a human override after the
last failed round. The gate cannot be a `loop` node and cannot declare `retry:`
because a failed gate means "start another round"; non-gate nodes may still use
`retry:` inside a round.

## Validation

`workflow_validate` (and `workflow_save`) run the real loader. Errors block a
save: YAML syntax, missing `name`/`description`/`nodes`, per-node schema
violations, more than one mode field, duplicate node ids, unknown
`depends_on` targets, dependency cycles, reserved names/ids, and
`$<nodeId>.output` references to non-ancestor nodes.

Not checked until run time: whether `provider`/`model` ids are valid for the
runner, and whether `command:` / named `script:` files exist on disk.

## Scopes and saving

- `scope: "project"` writes `<project root>/.keelson/workflows/<name>.yaml`
  and requires the conversation to have a project.
- `scope: "global"` writes `<keelson home>/workflows/<name>.yaml`.
- The `name` input, the YAML `name:` field, and the filename must agree;
  kebab-case (lowercase letters, digits, hyphens).
- Saving over an existing file requires `overwrite: true` — ask the user
  first.
- A project save that shadows a global name (or the reverse) is reported in
  the save result; mention it to the user.

## Example

A complete three-node workflow — deterministic check, AI summary, human gate:

```yaml
name: test-triage
description: |
  Use when: the test suite is failing and you want a triaged summary
  Triggers: "triage the tests", "why are tests failing"
  Does: runs the suite, summarizes failures, waits for approval to file notes
  NOT for: fixing the failures themselves
nodes:
  - id: run-tests
    bash: bun test 2>&1 | tail -80
    timeout: 300000
  - id: summarize
    prompt: |
      Summarize these test failures by root cause, most likely culprit first:
      $run-tests.output
    depends_on: [run-tests]
  - id: confirm
    approval:
      message: "File these findings to the project notebook?"
    depends_on: [summarize]
```

Pre-save checklist: validate is clean; description uses the structured
labels; `name` is kebab-case and matches the YAML; every `$ref` points at an
ancestor; the user approved the YAML, the scope, and any overwrite.
