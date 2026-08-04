// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { evaluateCondition } from "../src/conditions.ts";
import { bundledWorkflowsDir } from "../src/seed.ts";

const tmps: string[] = [];
type WorkflowNode = {
  id: string;
  bash?: string;
  prompt?: string;
  when?: string;
  depends_on?: string[];
  trigger_rule?: string;
  allowed_tools?: string[];
  output_format?: {
    required?: string[];
    properties?: Record<string, { enum?: string[]; type?: string }>;
  };
};

const document = parse(readFileSync(join(bundledWorkflowsDir(), "fix-issue.yaml"), "utf8")) as {
  nodes: WorkflowNode[];
};

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function workflowNode(nodeId: string): WorkflowNode {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Missing ${nodeId} node in fix-issue`);
  return node;
}

function makeArtifacts(): string {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-fix-issue-brief-"));
  tmps.push(artifacts);
  return artifacts;
}

function runBash(nodeId: string, artifacts: string, env: Record<string, string> = {}): string {
  const script = workflowNode(nodeId).bash;
  if (!script) throw new Error(`Missing bash script for ${nodeId} in fix-issue`);
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env: {
      ...(process.env as Record<string, string>),
      KEELSON_ARTIFACTS_DIR: artifacts,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
  return proc.stdout.toString();
}

function extractBrief(body: string, artifacts = makeArtifacts()): { criteria: string[] } {
  runBash("extract-brief", artifacts, {
    KEELSON_NODE_fetch_issue_OUTPUT: JSON.stringify({
      url: "https://github.com/danielscholl/keelson/issues/720",
      title: "Coverage extraction",
      body,
    }),
  });
  return JSON.parse(readFileSync(join(artifacts, "brief.json"), "utf8")) as {
    criteria: string[];
  };
}

function conditionResult(nodeId: string, outputNodeId: string, output: string) {
  const condition = workflowNode(nodeId).when;
  if (!condition) throw new Error(`Missing when condition for ${nodeId}`);
  return evaluateCondition(
    condition,
    new Map([[outputNodeId, { state: "completed" as const, output }]]),
  );
}

// Gated on the tools the asset needs rather than on platform — Windows ships
// both, and skipping it there would hide real portability failures.
const hasShellTools =
  Bun.spawnSync({ cmd: ["bash", "-c", "command -v jq"], stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;
const shellDescribe = hasShellTools ? describe : describe.skip;

shellDescribe("fix-issue brief extraction", () => {
  test.each([
    [
      "exact acceptance criteria",
      "## Acceptance Criteria\n\n- Runs the divergence check\n- Reports missing coverage\n",
      ["Runs the divergence check", "Reports missing coverage"],
    ],
    [
      "trailing parenthetical",
      "## Acceptance criteria (must all hold)\n\n- Keeps structured extraction\n",
      ["Keeps structured extraction"],
    ],
    [
      "requirements synonym",
      "## Requirements\n\n1. Extract numbered requirements\n2. Preserve their order\n",
      ["Extract numbered requirements", "Preserve their order"],
    ],
    [
      "definition of done synonym",
      "## Definition of done\n\n* Coverage runs before approval\n",
      ["Coverage runs before approval"],
    ],
    [
      "success criteria synonym",
      "## Success criteria\n\n- The PR body states the check status\n",
      ["The PR body states the check status"],
    ],
  ])("extracts bullets from a %s heading", (_name, body, criteria) => {
    expect(extractBrief(body).criteria).toEqual(criteria);
  });

  test("folds wrapped criteria continuation lines", () => {
    const body = `## Acceptance Criteria

- \`errors.py\` defines \`EXIT_ENV_NOT_READY = 6\`; \`aggregate_exit_code\` covers it;
  callers preserve the not-ready envelope
  without converting it to a generic failure.
- Unit tests cover: ready envelope, each not-ready reason, apiVersion mismatch,
  and malformed payload handling.
- Existing exit codes remain unchanged.
`;

    expect(extractBrief(body).criteria).toEqual([
      "`errors.py` defines `EXIT_ENV_NOT_READY = 6`; `aggregate_exit_code` covers it; callers preserve the not-ready envelope without converting it to a generic failure.",
      "Unit tests cover: ready envelope, each not-ready reason, apiVersion mismatch, and malformed payload handling.",
      "Existing exit codes remain unchanged.",
    ]);
  });

  test("leaves a bug-report-shaped prose expectation for fallback extraction", () => {
    const body = `## What happened?

The approval callout omitted the coverage status.

## What did you expect?

The approval callout should state whether the divergence check ran.

## Steps to reproduce

1. Run fix-issue for a prose-only report.
2. Open the approval callout.

## Environment

macOS with the Copilot provider.
`;

    expect(extractBrief(body).criteria).toEqual([]);
  });

  test("skips the LLM fallback when awk extracted criteria", () => {
    const artifacts = makeArtifacts();
    const expected = ["Runs the divergence check"];
    extractBrief(
      `## Acceptance Criteria

- ${expected[0]}
`,
      artifacts,
    );

    // Raw, not trimmed: the executor feeds a node's output to `when` verbatim,
    // so trimming here would test a stream the runtime never produces.
    const initialCount = runBash("criteria-count-initial", artifacts);
    expect(initialCount.trim()).toBe("1");
    expect(conditionResult("extract-brief-llm", "criteria-count-initial", initialCount)).toEqual({
      result: false,
      parsed: true,
    });
    expect(workflowNode("extract-brief-llm").allowed_tools).toEqual([]);
    expect(workflowNode("brief-ready").trigger_rule).toBe("all_done");

    runBash("brief-ready", artifacts);
    const finalCount = runBash("criteria-count", artifacts).trim();
    expect(finalCount).toBe("1");
    expect(conditionResult("coverage-check", "criteria-count", finalCount)).toEqual({
      result: true,
      parsed: true,
    });
    expect(JSON.parse(readFileSync(join(artifacts, "brief.json"), "utf8")).criteria).toEqual(
      expected,
    );
  });

  test.each([
    [
      "issue 720",
      `## What happened?

The acceptance-criteria check skips for prose-only issue bodies.

## What did you expect?

Either the criteria are found, or the run says out loud that it is proceeding without a divergence check.

## Steps to reproduce

1. File an issue using the bug report template.
2. Run fix-issue.
`,
      "The run finds criteria or visibly reports that the divergence check did not run.",
    ],
    [
      "issue 722",
      `## What happened?

A review node can end after narration without producing a verdict.

## What did you expect?

A reviewer that does not produce a verdict should fail its node, or at minimum be reported as no verdict.

## Steps to reproduce

1. Run fix-issue on a non-trivial change.
2. Inspect the review outputs.
`,
      "A reviewer without a verdict fails or is reported as having no verdict.",
    ],
    [
      "bug report template",
      `## What happened?

The approval callout omitted the coverage status.

## What did you expect?

The approval callout should state whether the divergence check ran.

## Steps to reproduce

1. Run fix-issue for a prose-only report.
2. Open the approval callout.

## Environment

macOS with the Copilot provider.
`,
      "The approval callout states whether the divergence check ran.",
    ],
  ])("merges fallback criteria for a prose-only %s body", (_name, body, criterion) => {
    const artifacts = makeArtifacts();
    expect(extractBrief(body, artifacts).criteria).toEqual([]);

    // Raw, not trimmed — see the sibling case above.
    const initialCount = runBash("criteria-count-initial", artifacts);
    expect(initialCount.trim()).toBe("0");
    expect(conditionResult("extract-brief-llm", "criteria-count-initial", initialCount)).toEqual({
      result: true,
      parsed: true,
    });
    expect(workflowNode("extract-brief-llm").prompt).toContain("$fetch-issue.output");

    runBash("brief-ready", artifacts, {
      KEELSON_NODE_extract_brief_llm_OUTPUT: JSON.stringify({ criteria: [criterion] }),
    });
    const finalCount = runBash("criteria-count", artifacts).trim();
    expect(finalCount).toBe("1");
    expect(conditionResult("coverage-check", "criteria-count", finalCount)).toEqual({
      result: true,
      parsed: true,
    });
    expect(JSON.parse(readFileSync(join(artifacts, "brief.json"), "utf8")).criteria).toEqual([
      criterion,
    ]);
  });

  test("keeps coverage gated when both extractors find no criteria", () => {
    const artifacts = makeArtifacts();
    extractBrief("## What happened?\n\nThe command failed.\n", artifacts);
    expect(runBash("criteria-count-initial", artifacts).trim()).toBe("0");

    runBash("brief-ready", artifacts, {
      KEELSON_NODE_extract_brief_llm_OUTPUT: JSON.stringify({ criteria: [] }),
    });
    const finalCount = runBash("criteria-count", artifacts).trim();
    expect(finalCount).toBe("0");
    expect(conditionResult("coverage-check", "criteria-count", finalCount)).toEqual({
      result: false,
      parsed: true,
    });
  });

  test("keeps the existing brief when fallback output is invalid", () => {
    const artifacts = makeArtifacts();
    extractBrief("## What happened?\n\nThe command failed.\n", artifacts);

    runBash("brief-ready", artifacts, {
      KEELSON_NODE_extract_brief_llm_OUTPUT: "not JSON",
    });

    expect(JSON.parse(readFileSync(join(artifacts, "brief.json"), "utf8")).criteria).toEqual([]);
  });
});

describe("fix-issue PR divergence status", () => {
  test("requires coverage details or an explicit skipped line in every PR body", () => {
    const prompt = workflowNode("create-pr").prompt;
    expect(prompt).toContain("$ARTIFACTS_DIR/brief.json");
    expect(prompt).toContain("$ARTIFACTS_DIR/coverage.json");
    expect(prompt).toContain("- [COVERED] {criterion} -> {step}");
    expect(prompt).toContain("- [MISSING] {criterion}");
    expect(prompt).toContain("COVERAGE: SKIPPED — no acceptance criteria found in the issue body");
  });
});

describe("fix-issue CI triage criteria", () => {
  test("binds triage to the brief and exposes criteria conflicts", () => {
    const triage = workflowNode("triage-ci");
    const schema = triage.output_format;

    expect(triage.depends_on).toEqual(["await-ci", "brief-ready", "criteria-count"]);
    expect(triage.prompt).toContain("$brief-ready.output");
    expect(triage.prompt).toContain("$criteria-count.output");
    expect(triage.prompt).toContain("CRITERIA_RECEIVED: {criteria_count}");
    expect(triage.prompt).toContain("candidate fix that deletes");
    expect(triage.prompt).toContain("skips, inverts, or stops running");
    expect(schema?.required).toEqual(
      expect.arrayContaining(["conflicts", "criteria_count", "brief_status"]),
    );
    expect(schema?.properties?.ci_status?.enum).toContain("conflict");
    expect(schema?.properties?.brief_status?.enum).toEqual([
      "received",
      "empty",
      "missing",
      "invalid",
    ]);
  });

  test("blocks criteria conflicts and validates fixes before push", () => {
    const prompt = workflowNode("fix-ci").prompt;

    expect(prompt).toContain('If `ci_status` is "conflict"');
    expect(prompt).toContain("`conflicts` is non-empty");
    expect(prompt).toContain("$ARTIFACTS_DIR/.ci-conflict");
    for (const antiPattern of [
      "`skip`",
      "`skipIf`",
      "`.only`",
      "`xit`",
      "`xdescribe`",
      "`test.todo`",
    ]) {
      expect(prompt).toContain(antiPattern);
    }
    expect(prompt).toContain('bash "$ARTIFACTS_DIR/verify.sh"');
    expect(prompt).toContain("If it fails, do not commit or push");
    expect(prompt.indexOf('bash "$ARTIFACTS_DIR/verify.sh"')).toBeLessThan(
      prompt.indexOf("Only after `verify.sh` passes, commit"),
    );
  });

  test("surfaces conflicts and red final CI in the operator report", () => {
    const report = workflowNode("report");

    expect(report.depends_on).toEqual(["finalize-pr"]);
    expect(report.prompt).toContain("$triage-ci.output");
    expect(report.prompt).toContain("$finalize-pr.output");
    expect(report.prompt).toContain("FIX-ISSUE — {COMPLETE | CI CONFLICT | CI RED}");
    expect(report.prompt).toContain("For CONFLICT, name every criterion and check");
    expect(report.prompt).toContain("For RED, say");
    expect(report.prompt).toContain("the final pushed SHA is red");
    expect(report.prompt).toContain("criteria enforcement was UNKNOWN");
    expect(report.prompt).not.toContain("FIX-ISSUE — COMPLETE\n");
  });
});
