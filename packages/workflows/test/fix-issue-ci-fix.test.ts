// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { type OutputSchema, validateOutput } from "../src/schema/output-schema.ts";
import { bundledWorkflowsDir } from "../src/seed.ts";
import { fakeBinDir, pathWith } from "./forge-support.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

interface FixIssueNode {
  id: string;
  bash?: string;
  output_schema?: unknown;
}

function fixIssueNode(nodeId: string): FixIssueNode {
  const document = parse(readFileSync(join(bundledWorkflowsDir(), "fix-issue.yaml"), "utf8")) as {
    nodes: FixIssueNode[];
  };
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Missing node ${nodeId} in fix-issue`);
  return node;
}

function nodeBash(nodeId: string): string {
  const script = fixIssueNode(nodeId).bash;
  if (!script) throw new Error(`Node ${nodeId} is not a bash node`);
  return script;
}

// The #569 criteria: the win32 skip is deleted so the test actually runs.
const SKIP_REMOVAL_CRITERION =
  "The converge resolve-retry test runs on win32; the skipIf(win32) is removed";

// triage-ci's verdict when the only route to green is re-adding that skip.
const CONFLICT_TRIAGE = JSON.stringify({
  ci_status: "conflict",
  actionable: [],
  conflicts: [
    {
      criterion: SKIP_REMOVAL_CRITERION,
      check: "Typecheck and test (Windows)",
      why: "the only green path re-adds the skipIf this issue exists to delete",
    },
  ],
  criteria_count: 2,
  brief_status: "received",
  summary: "CRITERIA_RECEIVED: 2. Windows fails on the now-running test.",
});

function runTerminalGate(opts: { status?: string; conflict?: string; triage?: string }) {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-569-gate-"));
  tmps.push(artifacts);
  if (opts.status !== undefined) {
    writeFileSync(join(artifacts, ".ci-final-status"), `${opts.status}\n`);
  }
  if (opts.conflict !== undefined) {
    writeFileSync(join(artifacts, ".ci-conflict"), opts.conflict);
  }
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", nodeBash("ci-green-gate")],
    env: {
      ...(process.env as Record<string, string>),
      KEELSON_ARTIFACTS_DIR: artifacts,
      KEELSON_NODE_triage_ci_OUTPUT: opts.triage ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
}

// finalize-pr against an all-green PR — the #569 shape's hardest case, because
// nothing in the check state alone argues against promoting it.
function runFinalizePr(opts: { conflict?: string }) {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-569-finalize-"));
  tmps.push(artifacts);
  writeFileSync(join(artifacts, ".pr-number"), "42\n");
  if (opts.conflict !== undefined) {
    writeFileSync(join(artifacts, ".ci-conflict"), opts.conflict);
  }
  const readyMarker = join(artifacts, ".ready-called");
  const forge = `#!/usr/bin/env bash
case "$*" in
  "pr checks 42 --json state -q length") echo 1 ;;
  "pr required-checks 42") printf '%s\\n' "" ;;
  "pr checks 42 --json name,bucket,state") echo '[{"name":"Typecheck and test","bucket":"pass","state":"SUCCESS"}]' ;;
  "pr ready 42") touch "$READY_MARKER" ;;
  *) echo "unexpected forge args: $*" >&2; exit 1 ;;
esac
`;
  const bin = fakeBinDir({ forge, sleep: `:` });
  tmps.push(bin);
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", nodeBash("finalize-pr")],
    env: {
      ...(process.env as Record<string, string>),
      KEELSON_ARTIFACTS_DIR: artifacts,
      KEELSON_CI_RECHECK_INTERVAL: "0",
      PATH: pathWith(bin),
      READY_MARKER: readyMarker,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const finalStatus = join(artifacts, ".ci-final-status");
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    readyCalled: existsSync(readyMarker),
    finalStatus: existsSync(finalStatus) ? readFileSync(finalStatus, "utf8").trim() : null,
  };
}

// Guards the bypass output_format cannot close: it only requires *a* JSON object,
// so `{}` parses and the criteria fields vanish without failing the node.
describe("fix-issue triage-ci fails closed on a malformed verdict", () => {
  // Reported as a failed assertion rather than a thrown TypeError, so a dropped
  // output_schema names itself instead of surfacing inside the validator.
  const accepts = (value: unknown): boolean => {
    const schema = fixIssueNode("triage-ci").output_schema as OutputSchema | undefined;
    if (schema === undefined) throw new Error("triage-ci declares no output_schema");
    return validateOutput(value, schema).ok;
  };

  test("declares an output_schema, not only an output_format", () => {
    expect(fixIssueNode("triage-ci").output_schema).toBeDefined();
  });

  test.each([
    ["an empty object", {}],
    ["a verdict missing criteria_count", { ci_status: "conflict", conflicts: [] }],
    ["a verdict missing conflicts", { ci_status: "conflict", criteria_count: 2 }],
  ])("rejects %s", (_label, value) => {
    expect(accepts(value)).toBe(false);
  });

  test("accepts the conflict verdict the #569 shape produces", () => {
    expect(accepts(JSON.parse(CONFLICT_TRIAGE))).toBe(true);
  });
});

// #569 end to end: criteria say the skip is removed, CI fails on the now-running
// test, and the only green path re-adds it. The run must not land that fix, must
// not promote the PR, and must not report success.
shimDescribe("fix-issue #569 regression: a criteria-violating CI repair", () => {
  const conflict = `Criterion: ${SKIP_REMOVAL_CRITERION}\nCheck: Typecheck and test (Windows)`;

  test("fix-ci is instructed to record the conflict and push nothing", () => {
    const prompt = JSON.stringify(fixIssueNode("fix-ci"));
    expect(prompt).toContain("$ARTIFACTS_DIR/.ci-conflict");
    for (const antiPattern of ["skipIf", "test.todo", ".only"]) {
      expect(prompt).toContain(antiPattern);
    }
  });

  test("finalize-pr keeps a conflicted PR in draft even when every check is green", () => {
    const result = runFinalizePr({ conflict });

    expect(result.readyCalled).toBe(false);
    expect(result.finalStatus).toBe("FAIL");
  });

  test("a green PR with no conflict is still promoted", () => {
    const result = runFinalizePr({});

    expect(result.readyCalled).toBe(true);
    expect(result.finalStatus).toBe("PASS");
  });

  test("the terminal gate fails the run rather than reporting success", () => {
    const result = runTerminalGate({ status: "FAIL", conflict, triage: CONFLICT_TRIAGE });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("CI_GATE: FAIL");
    expect(result.stdout).toContain(SKIP_REMOVAL_CRITERION);
  });

  // The defect's actual signature: CI was made green, so every check-state
  // signal says ship. Only the conflict record dissents.
  test("a conflict fails the run even when the final status was recorded PASS", () => {
    const result = runTerminalGate({ status: "PASS", conflict, triage: CONFLICT_TRIAGE });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("CI repair conflicts with issue criteria");
  });
});
