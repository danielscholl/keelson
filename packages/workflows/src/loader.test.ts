// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { discoverWorkflows, parseWorkflow } from "./loader.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-procedures-loader-"));
}

describe("parseWorkflow — happy paths", () => {
  test("minimal workflow with one prompt node", () => {
    const yaml = `
name: hello
description: trivial
nodes:
  - id: greet
    prompt: Say hi
`;
    const result = parseWorkflow(yaml, "hello.yaml");
    expect(result.error).toBeNull();
    expect(result.workflow?.name).toBe("hello");
    expect(result.workflow?.nodes.length).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  test("DAG with depends_on, when:, trigger_rule", () => {
    const yaml = `
name: triage
description: classify and act
nodes:
  - id: classify
    prompt: classify the issue
  - id: bug-flow
    prompt: handle as bug
    depends_on: [classify]
    when: "$classify.output == 'bug'"
  - id: feature-flow
    prompt: handle as feature
    depends_on: [classify]
    when: "$classify.output == 'feature'"
  - id: collect
    bash: echo done
    depends_on: [bug-flow, feature-flow]
    trigger_rule: one_success
`;
    const result = parseWorkflow(yaml, "triage.yaml");
    expect(result.error).toBeNull();
    expect(result.workflow?.nodes.length).toBe(4);
  });

  test("workflow with bash and cancel nodes", () => {
    const yaml = `
name: bash-cancel
description: bash plus cancel
nodes:
  - id: precheck
    bash: test -f README.md
  - id: stop
    cancel: precondition failed
    depends_on: [precheck]
`;
    expect(parseWorkflow(yaml, "bash-cancel.yaml").error).toBeNull();
  });
});

describe("parseWorkflow — validation failures", () => {
  test("missing 'name' is rejected", () => {
    const yaml = `
description: anonymous
nodes:
  - id: a
    prompt: x
`;
    const result = parseWorkflow(yaml, "anon.yaml");
    expect(result.workflow).toBeNull();
    expect(result.error?.errorType).toBe("validation_error");
    expect(result.error?.error).toMatch(/name/);
  });

  test("missing 'description' is rejected", () => {
    const yaml = `
name: nameless
nodes:
  - id: a
    prompt: x
`;
    expect(parseWorkflow(yaml, "x.yaml").error?.error).toMatch(/description/);
  });

  test("legacy steps: format is rejected with migration hint", () => {
    const yaml = `
name: legacy
description: old-shape
steps:
  - bash: echo hi
`;
    const result = parseWorkflow(yaml, "legacy.yaml");
    expect(result.error?.error).toMatch(/steps:.*removed/);
  });

  test("empty nodes array is rejected", () => {
    const yaml = `
name: empty
description: no work
nodes: []
`;
    expect(parseWorkflow(yaml, "empty.yaml").error?.error).toMatch(/non-empty 'nodes:'/);
  });

  test("malformed YAML returns parse_error", () => {
    const result = parseWorkflow(`name: broken\n  bad indent\nnodes: [\n`, "broken.yaml");
    expect(result.error?.errorType).toBe("parse_error");
  });

  test("duplicate node id is rejected", () => {
    const yaml = `
name: dup
description: dup ids
nodes:
  - id: a
    prompt: x
  - id: a
    bash: echo x
`;
    expect(parseWorkflow(yaml, "dup.yaml").error?.error).toMatch(/Duplicate node id/);
  });

  test("unknown depends_on target is rejected", () => {
    const yaml = `
name: dangling
description: dangling dep
nodes:
  - id: a
    prompt: x
    depends_on: [missing]
`;
    expect(parseWorkflow(yaml, "dangling.yaml").error?.error).toMatch(/unknown node 'missing'/);
  });

  test("cycle is rejected", () => {
    const yaml = `
name: loop
description: cycle
nodes:
  - id: a
    prompt: x
    depends_on: [b]
  - id: b
    prompt: y
    depends_on: [a]
`;
    expect(parseWorkflow(yaml, "cycle.yaml").error?.error).toMatch(/[Cc]ycle/);
  });

  test("dangling $nodeId.output reference is rejected", () => {
    const yaml = `
name: bad-ref
description: ref to unknown
nodes:
  - id: a
    prompt: "use $missing.output"
`;
    expect(parseWorkflow(yaml, "bad-ref.yaml").error?.error).toMatch(
      /references unknown node '\$missing.output'/,
    );
  });

  test("workflow-level provider strings pass through the loader (runtime resolves)", () => {
    const yaml = `
name: copilot-pin
description: workflow pins copilot
provider: copilot
nodes:
  - id: a
    prompt: x
`;
    const result = parseWorkflow(yaml, "copilot-pin.yaml");
    expect(result.error).toBeNull();
    expect(result.workflow?.provider).toBe("copilot");
  });

  test("per-node provider string passes through the loader (runtime resolves)", () => {
    const yaml = `
name: per-node-override
description: workflow defaults claude, one node pins copilot
provider: claude
nodes:
  - id: a
    prompt: x
  - id: b
    depends_on: [a]
    prompt: y
    provider: copilot
`;
    const result = parseWorkflow(yaml, "per-node-override.yaml");
    expect(result.error).toBeNull();
    const nodeB = result.workflow?.nodes.find((n) => n.id === "b");
    expect((nodeB as { provider?: string } | undefined)?.provider).toBe("copilot");
  });
});

describe("parseWorkflow — warnings (non-fatal)", () => {
  test("hooks on a prompt node parses cleanly and is NOT in the dropped-fields warning", () => {
    const yaml = `
name: hooks-allowed
description: hook field is honored by the claude provider
nodes:
  - id: a
    prompt: x
    hooks:
      PreToolUse:
        - matcher: ".*"
          response: { decision: allow }
`;
    const result = parseWorkflow(yaml, "hooks.yaml");
    expect(result.error).toBeNull();
    // Slice 2 removed `hooks` from PI_IGNORED_FIELDS_PER_NODE; the loader
    // no longer claims the field is dropped.
    expect(
      result.warnings.some((w) => w.kind === "ignored_capability" && w.message.includes("hooks")),
    ).toBe(false);
  });

  test("provider_specific_capability warning fires for hooks (only partially portable to copilot)", () => {
    const yaml = `
name: hooks-field
description: uses hooks
nodes:
  - id: a
    prompt: hi
    hooks:
      PreToolUse:
        - matcher: Bash
          response: { decision: deny }
`;
    const result = parseWorkflow(yaml, "hooks-field.yaml");
    expect(result.error).toBeNull();
    const warning = result.warnings.find((w) => w.kind === "provider_specific_capability");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("hooks");
    expect(warning!.message).toContain("claude");
  });

  test("provider_specific_capability is NOT emitted for allowed_tools / denied_tools (both providers enforce)", () => {
    const yaml = `
name: tool-rails
description: uses allowed_tools + denied_tools
nodes:
  - id: a
    prompt: hi
    allowed_tools: [Read, Glob, Grep]
  - id: b
    prompt: hi again
    denied_tools: [Write]
`;
    const result = parseWorkflow(yaml, "tool-rails.yaml");
    expect(result.error).toBeNull();
    expect(result.warnings.some((w) => w.kind === "provider_specific_capability")).toBe(false);
  });

  test("provider_specific_capability is NOT emitted for nodes without claude-only fields", () => {
    const yaml = `
name: vanilla
description: no per-node config
nodes:
  - id: a
    prompt: hi
`;
    const result = parseWorkflow(yaml, "vanilla.yaml");
    expect(result.error).toBeNull();
    expect(result.warnings.some((w) => w.kind === "provider_specific_capability")).toBe(false);
  });

  test("AI fields on a bash node warn (matches Archon)", () => {
    const yaml = `
name: ai-on-bash
description: misplaced ai fields
nodes:
  - id: a
    bash: echo hi
    model: opus
    allowed_tools: [Read]
`;
    const result = parseWorkflow(yaml, "ai-on-bash.yaml");
    expect(result.error).toBeNull();
    expect(result.warnings.some((w) => w.kind === "ai_fields_on_non_ai_node")).toBe(true);
  });

  test("output_format on a prompt node loads without an ignored_capability warning", () => {
    const yaml = `
name: structured
description: uses output_format
nodes:
  - id: classify
    prompt: classify the issue
    output_format:
      type: object
      properties:
        type:
          type: string
      required: [type]
`;
    const result = parseWorkflow(yaml, "structured.yaml");
    expect(result.error).toBeNull();
    expect(
      result.warnings.some(
        (w) => w.kind === "ignored_capability" && /output_format/.test(w.message),
      ),
    ).toBe(false);
    const node = result.workflow?.nodes[0];
    expect(node?.output_format).toBeDefined();
    expect((node?.output_format as { type?: unknown }).type).toBe("object");
  });

  test("script node loads without an 'unimplemented' warning (handler is wired now)", () => {
    const yaml = `
name: scripty
description: has a script node
nodes:
  - id: x
    script: console.log('hi')
    runtime: bun
`;
    const result = parseWorkflow(yaml, "script.yaml");
    expect(result.error).toBeNull();
    expect(
      result.warnings.some(
        (w) => w.kind === "ignored_capability" && /will fail at runtime/.test(w.message),
      ),
    ).toBe(false);
  });

  test("interactive loop node loads without a runtime-unsupported warning (now wired)", () => {
    const yaml = `
name: int-loop
description: interactive loops are supported when the embedder injects the pause callback
nodes:
  - id: l
    loop:
      prompt: keep going
      until: DONE
      max_iterations: 3
      interactive: true
      gate_message: "type next"
`;
    const result = parseWorkflow(yaml, "il.yaml");
    expect(result.error).toBeNull();
    // No `'loop.interactive' is not yet supported …` warning — the engine
    // now runs interactive loops via the AwaitInteraction callback wired
    // from the server. `interactive_loop_in_non_interactive_workflow` is a
    // separate kind (workflow-level interactive: false vs node-level true)
    // and still fires; this assertion targets only the per-node
    // ignored_capability message about runtime support.
    expect(
      result.warnings.some(
        (w) =>
          w.kind === "ignored_capability" &&
          w.nodeId === "l" &&
          /loop\.interactive.*not yet supported/.test(w.message),
      ),
    ).toBe(false);
  });

  test("node id 'ARTIFACTS_DIR' is rejected (collides with the $ARTIFACTS_DIR substitution namespace)", () => {
    const yaml = `
name: artifacts-dir-node
description: shadows ARTIFACTS_DIR namespace
nodes:
  - id: ARTIFACTS_DIR
    bash: "echo x"
`;
    const result = parseWorkflow(yaml, "artifacts.yaml");
    expect(result.error?.error).toMatch(
      /Node id 'ARTIFACTS_DIR' is reserved.*substitution namespace/,
    );
    expect(result.workflow).toBeNull();
  });

  test("$ARTIFACTS_DIR.output in a bash body loads cleanly (treated as reserved namespace, not an unknown node)", () => {
    const yaml = `
name: artifacts-ref-body
description: $ARTIFACTS_DIR.output is a literal path expansion, not a node ref
nodes:
  - id: a
    bash: 'echo "$ARTIFACTS_DIR.output"'
`;
    const result = parseWorkflow(yaml, "artifacts-body.yaml");
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
  });

  test("$ARTIFACTS_DIR in a when: clause is rejected (evaluateCondition only resolves \\$nodeId.output)", () => {
    const yaml = `
name: artifacts-when
description: when clauses can't use ARTIFACTS_DIR
nodes:
  - id: a
    bash: 'echo hi'
  - id: b
    bash: 'echo gated'
    depends_on: [a]
    when: "'$ARTIFACTS_DIR' != ''"
`;
    const result = parseWorkflow(yaml, "artifacts-when.yaml");
    expect(result.error?.error).toMatch(/\$ARTIFACTS_DIR.*isn't supported in this context/);
  });

  test("workflow named 'runs' is rejected (collides with /api/workflows/runs route family)", () => {
    const yaml = `
name: runs
description: shadows the runs route
nodes:
  - id: x
    prompt: hi
`;
    const result = parseWorkflow(yaml, "runs.yaml");
    expect(result.error?.error).toMatch(/Workflow name 'runs' is reserved.*\/api\/workflows\/runs/);
    expect(result.workflow).toBeNull();
  });

  test("cancel body referencing an unknown node fails at load", () => {
    const yaml = `
name: bad-cancel-ref
description: cancel refs nonexistent node
nodes:
  - id: c
    cancel: "stopped by $lint.output"
`;
    const result = parseWorkflow(yaml, "bc.yaml");
    expect(result.error?.error).toMatch(/references unknown node '\$lint\.output'/);
  });

  test("cancel body referencing a non-ancestor fails at load", () => {
    const yaml = `
name: ancestor-gap
description: cancel skips depends_on chain
nodes:
  - id: a
    bash: "echo a"
  - id: c
    cancel: "stopped because $a.output"
`;
    const result = parseWorkflow(yaml, "ag.yaml");
    expect(result.error?.error).toMatch(/not in its depends_on chain/);
  });

  test("cancel body with a valid in-chain ref loads cleanly", () => {
    const yaml = `
name: ok-cancel-ref
description: cancel reaches an ancestor
nodes:
  - id: a
    bash: "echo a"
  - id: c
    depends_on: [a]
    cancel: "stopped because $a.output"
`;
    const result = parseWorkflow(yaml, "ok.yaml");
    expect(result.error).toBeNull();
  });

  test("loop node with whitespace-only until_bash is rejected (handler would silently skip it)", () => {
    const yaml = `
name: ws-bash
description: whitespace-only probe is silently ignored at runtime — reject upstream
nodes:
  - id: l
    loop:
      prompt: keep going
      until: DONE
      max_iterations: 3
      until_bash: "   "
`;
    const result = parseWorkflow(yaml, "ws-bash.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toMatch(/until_bash/);
  });

  test('loop node with empty until_bash is rejected (avoid `bash -c ""` exit-0 false positive)', () => {
    const yaml = `
name: empty-bash
description: empty probe must not pass schema
nodes:
  - id: l
    loop:
      prompt: keep going
      until: DONE
      max_iterations: 3
      until_bash: ""
`;
    const result = parseWorkflow(yaml, "eb.yaml");
    expect(result.error).not.toBeNull();
    expect(result.error?.error).toMatch(/until_bash/);
  });

  test("loop node with until_bash loads without a runtime-unsupported warning (now wired)", () => {
    const yaml = `
name: bash-probe-loop
description: until_bash is supported when the embedder injects the probe runner
nodes:
  - id: l
    loop:
      prompt: keep going
      until: DONE
      max_iterations: 3
      until_bash: "test -f /tmp/done"
`;
    const result = parseWorkflow(yaml, "ub.yaml");
    expect(result.error).toBeNull();
    expect(
      result.warnings.some(
        (w) =>
          w.kind === "ignored_capability" &&
          w.nodeId === "l" &&
          /loop\.until_bash.*not yet supported/.test(w.message),
      ),
    ).toBe(false);
  });

  test("invalid modelReasoningEffort warns and falls back", () => {
    const yaml = `
name: bad-effort
description: bad effort
modelReasoningEffort: turbo
nodes:
  - id: a
    prompt: x
`;
    const result = parseWorkflow(yaml, "bad-effort.yaml");
    expect(result.error).toBeNull();
    expect(result.workflow?.modelReasoningEffort).toBeUndefined();
    expect(result.warnings.some((w) => w.kind === "invalid_field_value")).toBe(true);
  });

  test("interactive loop in non-interactive workflow warns", () => {
    const yaml = `
name: lonely-loop
description: interactive loop without top-level interactive
nodes:
  - id: l
    loop:
      prompt: keep going
      until: DONE
      max_iterations: 3
      interactive: true
      gate_message: "type next"
`;
    const result = parseWorkflow(yaml, "lonely.yaml");
    expect(result.error).toBeNull();
    expect(
      result.warnings.some((w) => w.kind === "interactive_loop_in_non_interactive_workflow"),
    ).toBe(true);
  });
});

describe("discoverWorkflows", () => {
  test("returns empty when directory does not exist", () => {
    const result = discoverWorkflows([{ dir: "/nonexistent/path", source: "global" }]);
    expect(result.workflows).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("loads .yaml and .yml files, skips other extensions", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "good.yaml"),
      "name: good\ndescription: a\nnodes:\n  - id: x\n    prompt: y\n",
    );
    fs.writeFileSync(
      path.join(dir, "alt.yml"),
      "name: alt\ndescription: a\nnodes:\n  - id: x\n    prompt: y\n",
    );
    fs.writeFileSync(path.join(dir, "ignored.txt"), "not yaml");

    const result = discoverWorkflows([{ dir, source: "project" }]);
    const names = result.workflows.map((w) => w.workflow.name).sort();
    expect(names).toEqual(["alt", "good"]);
    expect(result.workflows.every((w) => w.source === "project")).toBe(true);
  });

  test("later root overrides earlier same-named workflow", () => {
    const bundled = tmpDir();
    const project = tmpDir();
    fs.writeFileSync(
      path.join(bundled, "x.yaml"),
      "name: x\ndescription: bundled\nnodes:\n  - id: a\n    prompt: y\n",
    );
    fs.writeFileSync(
      path.join(project, "x.yaml"),
      "name: x\ndescription: project\nnodes:\n  - id: a\n    prompt: z\n",
    );
    const result = discoverWorkflows([
      { dir: bundled, source: "bundled" },
      { dir: project, source: "project" },
    ]);
    expect(result.workflows.length).toBe(1);
    expect(result.workflows[0].workflow.description).toBe("project");
    expect(result.workflows[0].source).toBe("project");
  });

  test("invalid YAML files are surfaced in errors", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "broken.yaml"), "name: x\nnodes: [\nbad");
    const result = discoverWorkflows([{ dir, source: "project" }]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// memory: block
// ---------------------------------------------------------------------------

describe("parseWorkflow — memory: block", () => {
  test("valid memory block on a prompt node parses successfully", () => {
    const yaml = `
name: memory-block-test
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      recall:
        query: prior context
        limits: { maxItems: 5, recencyDays: 30 }
        entities:
          repos: [keelson]
      writeback:
        on: success
        type: decision
        summary: a summary
        content: a content body
        sourceRefs:
          - { kind: workflow_run, uri: "$inputs.runId" }
`;
    const result = parseWorkflow(yaml, "memory.yaml");
    expect(result.error).toBeNull();
    expect(result.workflow?.nodes[0]).toMatchObject({
      id: "think",
      memory: {
        recall: { query: "prior context" },
        writeback: { type: "decision", summary: "a summary", on: "success" },
      },
    });
  });

  test("workflows without memory: block parse unchanged (backward compat)", () => {
    const yaml = `
name: legacy
description: test
nodes:
  - id: think
    prompt: hello
`;
    const result = parseWorkflow(yaml, "legacy.yaml");
    expect(result.error).toBeNull();
    const node = result.workflow?.nodes[0] as { memory?: unknown };
    expect(node?.memory).toBeUndefined();
  });

  test("$memory.recall.items in prompt does not trigger unknown-node error", () => {
    const yaml = `
name: ref
description: test
nodes:
  - id: think
    prompt: |
      Prior context: $memory.recall.items / trace=$memory.recall.trace
    memory:
      recall:
        query: anything
`;
    const result = parseWorkflow(yaml, "ref.yaml");
    expect(result.error).toBeNull();
  });

  test("a node literally named 'memory' is rejected at parse time", () => {
    const yaml = `
name: clash
description: test
nodes:
  - id: memory
    prompt: hello
`;
    const result = parseWorkflow(yaml, "clash.yaml");
    expect(result.error).toBeDefined();
  });

  test("writeback default for 'on' is 'success'", () => {
    const yaml = `
name: defaults
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      writeback:
        type: lesson
        summary: s
        content: c
`;
    const result = parseWorkflow(yaml, "defaults.yaml");
    expect(result.error).toBeNull();
    const node = result.workflow?.nodes[0] as { memory?: { writeback?: { on?: string } } };
    expect(node?.memory?.writeback?.on).toBe("success");
  });

  test("writeback rejects unknown memory type", () => {
    const yaml = `
name: bad-type
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      writeback:
        type: not_a_real_type
        summary: s
        content: c
`;
    const result = parseWorkflow(yaml, "bad.yaml");
    expect(result.error).toBeDefined();
  });

  test("memory block rejects a provenance field (executor hard-codes 'generated')", () => {
    // Evidence-default invariant: workflow authors cannot opt out by writing
    // a different provenance value. The schema is strict, so an extra
    // 'provenance' key trips it.
    const yaml = `
name: no-provenance
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      writeback:
        type: lesson
        summary: s
        content: c
        provenance: user_confirmed
`;
    const result = parseWorkflow(yaml, "prov.yaml");
    expect(result.error).toBeDefined();
  });

  test("memory.recall.query referencing an unknown node id is rejected", () => {
    const yaml = `
name: bad-recall-ref
description: test
nodes:
  - id: think
    prompt: hello
    memory:
      recall:
        query: "find $missing.output"
`;
    const result = parseWorkflow(yaml, "bad-recall.yaml");
    expect(result.error).toBeDefined();
    expect(result.error?.error).toMatch(/unknown node.*missing/);
  });

  test("memory.recall.query referencing a non-ancestor is rejected", () => {
    const yaml = `
name: non-ancestor-recall
description: test
nodes:
  - id: a
    bash: echo a
  - id: think
    prompt: hello
    memory:
      recall:
        query: "look at $a.output"
`;
    const result = parseWorkflow(yaml, "non-ancestor.yaml");
    expect(result.error).toBeDefined();
    expect(result.error?.error).toMatch(/depends_on/);
  });

  test("memory.recall.query allows an ancestor reference", () => {
    const yaml = `
name: ancestor-recall
description: test
nodes:
  - id: a
    bash: echo a
  - id: think
    depends_on: [a]
    prompt: hello
    memory:
      recall:
        query: "look at $a.output"
`;
    const result = parseWorkflow(yaml, "ancestor.yaml");
    expect(result.error).toBeNull();
  });

  test("memory.writeback.content referencing the node's own output is allowed (self-ref)", () => {
    // The executor adds the just-completed node's output to its
    // substitution context before resolving writeback templates, so
    // self-reference is valid here even though `think` isn't its own
    // ancestor.
    const yaml = `
name: self-ref
description: test
nodes:
  - id: think
    bash: echo done
    memory:
      writeback:
        on: success
        type: lesson
        summary: "captured: $think.output"
        content: "body: $think.output"
`;
    const result = parseWorkflow(yaml, "self-ref.yaml");
    expect(result.error).toBeNull();
  });

  test("memory.writeback.content referencing an unknown node is rejected", () => {
    const yaml = `
name: bad-wb-ref
description: test
nodes:
  - id: think
    bash: echo done
    memory:
      writeback:
        on: success
        type: lesson
        summary: s
        content: "leaks $ghost.output"
`;
    const result = parseWorkflow(yaml, "bad-wb.yaml");
    expect(result.error).toBeDefined();
    expect(result.error?.error).toMatch(/unknown node.*ghost/);
  });

  test("memory.writeback.sourceRefs[].uri references are validated", () => {
    const yaml = `
name: bad-sourceref
description: test
nodes:
  - id: think
    bash: echo done
    memory:
      writeback:
        on: success
        type: artifact_reference
        summary: s
        content: c
        sourceRefs:
          - { kind: workflow_run, uri: "ref-$missing.output" }
`;
    const result = parseWorkflow(yaml, "bad-sourceref.yaml");
    expect(result.error).toBeDefined();
    expect(result.error?.error).toMatch(/unknown node.*missing/);
  });

  test("empty memory: {} block is rejected at parse time", () => {
    // A bare `memory: {}` declares neither recall nor writeback but still
    // trips the headless server-required gate. Reject so authors get a
    // clear schema error rather than an exit-3 surprise.
    const yaml = `
name: empty-memory
description: test
nodes:
  - id: think
    prompt: hello
    memory: {}
`;
    const result = parseWorkflow(yaml, "empty-memory.yaml");
    expect(result.error).toBeDefined();
    expect(result.error?.error).toMatch(/recall.*writeback|writeback.*recall/);
  });

  test("$memory.output (no .recall.) is flagged as an unknown-node reference", () => {
    // The $memory.recall.* namespace doesn't match the `$X.output` regex,
    // so removing `memory` from RESERVED_REF_NAMESPACES makes $memory.output
    // typos fall through to the unknown-node check — catching author
    // mistakes rather than silently substituting empty string at runtime.
    const yaml = `
name: bare-memory-output
description: test
nodes:
  - id: think
    prompt: "leak $memory.output"
    memory:
      recall:
        query: anything
`;
    const result = parseWorkflow(yaml, "bare-memory.yaml");
    expect(result.error).toBeDefined();
    expect(result.error?.error).toMatch(/unknown node.*memory/);
  });

  test("sourceTimestamp must be an RFC3339 datetime with offset", () => {
    // Mirrors the shared sourceRefSchema. A plain string parses here would
    // fail at the server adapter's Zod re-parse — fail fast at load time.
    const yaml = `
name: bad-timestamp
description: test
nodes:
  - id: think
    bash: echo done
    memory:
      writeback:
        on: success
        type: artifact_reference
        summary: s
        content: c
        sourceRefs:
          - { kind: workflow_run, uri: "x", sourceTimestamp: "yesterday" }
`;
    const result = parseWorkflow(yaml, "bad-ts.yaml");
    expect(result.error).toBeDefined();
  });

  test("memory.writeback.content exceeding 4096 chars is rejected", () => {
    // Mirror the shared MEMORY_TEXT_LIMIT cap. Catches a verbose-template
    // mistake at load time rather than at the adapter Zod re-parse.
    const long = "x".repeat(4097);
    const yaml = `
name: too-long
description: test
nodes:
  - id: think
    bash: echo done
    memory:
      writeback:
        on: success
        type: lesson
        summary: s
        content: "${long}"
`;
    const result = parseWorkflow(yaml, "too-long.yaml");
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// notebook: block
// ---------------------------------------------------------------------------

describe("parseWorkflow — notebook: block", () => {
  test("valid notebook block parses with append + section + on", () => {
    const yaml = `
name: notebook-block-test
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: "result: $think.output"
      section: Workflow Log
      on: success
`;
    const result = parseWorkflow(yaml, "notebook.yaml");
    expect(result.error).toBeNull();
    expect(result.workflow?.nodes[0]).toMatchObject({
      id: "think",
      notebook: { append: "result: $think.output", section: "Workflow Log", on: "success" },
    });
  });

  test("on defaults to success when omitted", () => {
    const yaml = `
name: notebook-default
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: a note
`;
    const result = parseWorkflow(yaml, "notebook-default.yaml");
    expect(result.error).toBeNull();
    const node = result.workflow?.nodes[0] as { notebook?: { on?: string; section?: string } };
    expect(node?.notebook?.on).toBe("success");
    expect(node?.notebook?.section).toBeUndefined();
  });

  test("notebook block is valid on a bash node (not just prompt)", () => {
    const yaml = `
name: notebook-bash
description: test
nodes:
  - id: build
    bash: echo done
    notebook:
      append: "built: $build.output"
`;
    const result = parseWorkflow(yaml, "notebook-bash.yaml");
    expect(result.error).toBeNull();
  });

  test("empty append is rejected", () => {
    const yaml = `
name: notebook-empty
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: ""
`;
    const result = parseWorkflow(yaml, "notebook-empty.yaml");
    expect(result.error).toBeDefined();
  });

  test("unknown notebook keys are rejected (strict)", () => {
    const yaml = `
name: notebook-strict
description: test
nodes:
  - id: think
    prompt: hello
    notebook:
      append: a note
      bogus: nope
`;
    const result = parseWorkflow(yaml, "notebook-strict.yaml");
    expect(result.error).toBeDefined();
  });

  test("workflows without notebook: parse unchanged (backward compat)", () => {
    const yaml = `
name: notebook-absent
description: test
nodes:
  - id: think
    prompt: hello
`;
    const result = parseWorkflow(yaml, "notebook-absent.yaml");
    expect(result.error).toBeNull();
    const node = result.workflow?.nodes[0] as { notebook?: unknown };
    expect(node?.notebook).toBeUndefined();
  });
});
