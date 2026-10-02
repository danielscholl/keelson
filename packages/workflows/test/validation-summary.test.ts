// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

type WorkflowNode = { id: string; bash?: string; prompt?: string };
const documents = {
  "fix-issue": parse(readFileSync(join(bundledWorkflowsDir(), "fix-issue.yaml"), "utf8")) as {
    nodes: WorkflowNode[];
  },
  "resolve-pr": parse(readFileSync(join(bundledWorkflowsDir(), "resolve-pr.yaml"), "utf8")) as {
    nodes: WorkflowNode[];
  },
};
type Workflow = keyof typeof documents;
const tmps: string[] = [];

afterEach(() => {
  for (const path of tmps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workflowNode(workflow: Workflow, nodeId: string): WorkflowNode {
  const node = documents[workflow].nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Missing ${nodeId} node in ${workflow}`);
  return node;
}

function makeArtifacts(): string {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-validation-summary-"));
  tmps.push(artifacts);
  return artifacts;
}

function runBash(workflow: Workflow, nodeId: string, artifacts: string) {
  const script = workflowNode(workflow, nodeId).bash;
  if (!script) throw new Error(`Missing bash script for ${nodeId} in ${workflow}`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("KEELSON_NODE_")),
  );
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", script],
    env: { ...env, KEELSON_ARTIFACTS_DIR: artifacts },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const failureLines = [
  "(fail) suite > failing regression",
  "error: expect(received).toEqual(expected)",
  "Exited with code 1",
];

function transcript(failed: boolean): string {
  const lines = Array.from(
    { length: 6000 },
    (_, i) => `(pass) suite > case ${i} ${"regression-case ".repeat(5)}[0.12ms]`,
  );
  if (failed) lines.splice(3000, 0, ...failureLines);
  return `${lines.join("\n")}\n`;
}

function writeVerify(artifacts: string, output: string, exitCode: number): void {
  writeFileSync(join(artifacts, "transcript.txt"), output);
  writeFileSync(
    join(artifacts, "verify.sh"),
    `set -euo pipefail\ncat "$KEELSON_ARTIFACTS_DIR/transcript.txt"\nexit ${exitCode}\n`,
  );
}

const validationNodes = [
  {
    workflow: "fix-issue",
    nodeId: "validate",
    failureTrailer: "VALIDATION_STATUS: FAIL",
  },
  {
    workflow: "fix-issue",
    nodeId: "revalidate",
    failureTrailer: "VALIDATION_STATUS: FAIL — refusing to create PR with broken checks",
  },
  {
    workflow: "fix-issue",
    nodeId: "post-fix-validate",
    failureTrailer:
      "VALIDATION_STATUS: FAIL — the review loop left checks broken; the pushed PR needs attention",
  },
  {
    workflow: "resolve-pr",
    nodeId: "validate",
    failureTrailer: "VALIDATION_STATUS: FAIL",
  },
  {
    workflow: "resolve-pr",
    nodeId: "revalidate",
    failureTrailer: "VALIDATION_STATUS: FAIL - refusing to push with broken checks",
  },
] as const;

const shellDescribe = Bun.which("bash") ? describe : describe.skip;

for (const { workflow, nodeId, failureTrailer } of validationNodes) {
  shellDescribe(`${workflow} ${nodeId} validation summary`, () => {
    test.each([false, true])("bounds a large log (failed=%s) without losing it", (failed) => {
      const artifacts = makeArtifacts();
      const output = transcript(failed);
      expect(output.length).toBeGreaterThan(500_000);
      writeVerify(artifacts, output, failed ? 1 : 0);

      const result = runBash(workflow, nodeId, artifacts);
      expect(result.exitCode).toBe(failed && nodeId === "revalidate" ? 1 : 0);
      expect(result.stderr).toBe("");
      expect(result.stdout.length).toBeLessThan(30_000);
      expect(result.stdout).toContain("=== PROJECT CHECKS");
      expect(result.stdout).toContain(`Full log: ${join(artifacts, `${nodeId}.log`)}`);
      expect(result.stdout).toContain(`Exit code: ${failed ? 1 : 0}`);
      expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
        failed ? failureTrailer : "VALIDATION_STATUS: PASS",
      );
      expect(readFileSync(join(artifacts, `${nodeId}.log`), "utf8")).toBe(output);
      if (failed) {
        expect(result.stdout).toContain("--- Failure lines (first 100) ---");
        const [failures, tail] = result.stdout.split("--- Last 200 lines ---");
        for (const line of failureLines) {
          expect(failures).toContain(line);
          expect(tail).not.toContain(line);
        }
      } else {
        expect(result.stdout).not.toContain("--- Failure lines");
      }
    });
  });
}

describe("fix-issue validation log references", () => {
  test("fix-validation and create-pr name the full logs", () => {
    expect(workflowNode("fix-issue", "fix-validation").prompt).toContain(
      "$ARTIFACTS_DIR/validate.log",
    );
    expect(workflowNode("fix-issue", "create-pr").prompt).toContain(
      "$ARTIFACTS_DIR/revalidate.log",
    );
  });

  test("report uses the computed verdict instead of inlining the transcript", () => {
    const prompt = workflowNode("fix-issue", "report").prompt;
    expect(prompt).not.toContain("$post-fix-validate.output");
    expect(prompt).toContain("$report-status.output");
    expect(prompt).toContain("$ARTIFACTS_DIR/post-fix-validate.log");
    expect(workflowNode("fix-issue", "report-status").bash).toContain(
      'echo "VALIDATION_LOG: $A/post-fix-validate.log"',
    );
  });
});

describe("resolve-pr validation log references", () => {
  test("fix-validation names the full log", () => {
    expect(workflowNode("resolve-pr", "fix-validation").prompt).toContain(
      "$ARTIFACTS_DIR/validate.log",
    );
  });
});
