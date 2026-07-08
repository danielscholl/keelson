// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The agent-facing orchestration playbook served by keelson_docs as the
// "keelson-agent" source. It ships inline (not fetched from the docs site) so it
// always matches the exact harness version an external agent is driving and is
// live the instant a client connects. Split on H1 into progressive topics by the
// docs catalog. Rib-agnostic by design: it points at the live tool list and the
// keelson_docs catalog rather than naming any capability, so it never goes stale
// as ribs are installed or removed. Keep it honest about what is actually
// callable over MCP — do not describe tools the connection does not expose.
export const KEELSON_AGENT_GUIDE = `# Driving Keelson as an agent

> Start here. How to orchestrate real work through Keelson instead of doing everything inline.

You are connected to Keelson, a local agent workbench running on the user's machine. It persists work across sessions, runs deterministic human-authored workflows, routes model turns through configured providers, and can be extended by ribs. You reach all of it through the \`keelson_*\` tools on this connection — you do not need, and will not have, Keelson's source code. These docs are the contract; trust them over guessing.

Think of yourself as the orchestrator and Keelson as your durable substrate. Your default instinct — do the task yourself, turn by turn — is right for one-off edits and questions. But when work is **repeatable, long-running, multi-step, or worth reviewing**, prefer routing it through Keelson so it becomes a durable, inspectable run instead of a transcript that disappears when the session ends.

## When to reach for Keelson vs. do it inline

- **Do it inline** when the task is a quick, one-off answer or edit with no value in repeating or auditing it.
- **Run a workflow** when the task matches an existing automation — fixing an issue, reviewing a PR, a smoke test, a build-and-verify loop. Workflows are deterministic, reviewable, and resumable, so they beat re-deriving the same steps by hand each time. Check what already exists before doing it manually.
- **Read the docs first** whenever you are unsure how Keelson behaves or what it offers. \`keelson_docs\` is your only window into the harness; use it the way you would read the source if you had it.

## What you can do over this connection

You have exactly the tools this connection advertises — call \`tools/list\` to see them. That usually includes \`keelson_docs\` (read docs), \`workflow_list\` and \`workflow_status\` (inspect automations and runs), and, when the operator allows state-changing tools, \`workflow_run\` and \`workflow_respond\` (start and steer runs). Installed ribs add their own tools here automatically. Anything not on the list is not available over this connection — do not assume a capability you cannot see. Keelson owns its own persistent state (memory, run history, projects); you influence that state by running its workflows, not by writing to it directly.

# Running work through workflows

> The core orchestration loop: discover, run, steer, inspect.

Workflows are Keelson's deterministic control flow — human-authored, repeatable automations that mix agent turns with shell, script, approval, and loop steps. They are the main lever you have as an orchestrator.

The loop:

1. **Discover.** Call \`workflow_list\` to see what is available. Match the user's intent to a workflow by its name and description — fuzzy matching is fine (\`fix-issue\`, \`pr-review\`, \`smoke-test\`). Never invent a workflow name or search a filesystem for one; only names returned by \`workflow_list\` are real.
2. **Run.** Start it with \`workflow_run\`, passing the workflow name and any inputs it declares. The run executes server-side and persists — it outlives this conversation.
3. **Steer approvals.** A workflow can pause for human approval. When it does, \`workflow_run\` returns with the run paused: relay the pending plan or question to the user in your own words, get their decision, then continue the run with \`workflow_respond\`. Do not answer on the user's behalf on a gated step.
4. **Inspect.** Use \`workflow_status\` to check a run's progress or to read a completed run's node outputs.

Prefer starting a matching workflow over hand-rolling the same steps: the workflow has been reviewed, it records its outputs, and it can be re-run. If nothing fits and the work is worth repeating, say so — authoring a new workflow is itself a Keelson task (done from its chat surface), and you can describe what it should do.

# Discovering what Keelson can do

> Use keelson_docs progressively; ribs extend both the tools and the docs.

\`keelson_docs\` is progressive so a whole corpus never floods your context:

- Call it with **no arguments** to list documentation sources — Keelson's own docs plus a source for every installed rib.
- Call it with a **source id** to get that source's table of contents.
- Call it with a **source id and a topic** to read exactly that topic.

Reach for it whenever you need to know how something in Keelson works — workflows, configuration, providers, the CLI, a rib's behavior — instead of guessing. The user usually cannot see Keelson's internals, so a wrong assumption is invisible to them. The docs are the contract.

**Ribs** are installed extensions. When the user installs one, its tools appear in your \`tools/list\` and its docs appear as a new \`keelson_docs\` source — automatically, after the server restarts, with no change to how you are connected. So if a capability seems missing, re-check \`tools/list\` and \`keelson_docs\`: a rib may have added it. Treat the live tool list and the docs catalog as the source of truth for what is possible right now.
`;
