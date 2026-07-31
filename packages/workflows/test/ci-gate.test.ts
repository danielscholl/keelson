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
import { bundledWorkflowsDir } from "../src/seed.ts";
import { fakeBinDir, pathWith } from "./forge-support.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function workflowBash(workflow: string, nodeId: string): string {
  const document = parse(readFileSync(join(bundledWorkflowsDir(), `${workflow}.yaml`), "utf8")) as {
    nodes: Array<{ id: string; bash?: string }>;
  };
  const script = document.nodes.find((node) => node.id === nodeId)?.bash;
  if (!script) throw new Error(`Missing bash node ${nodeId} in ${workflow}`);
  return script;
}

function runAdvisoryGate(
  workflow: string,
  nodeId: string,
  snapshot: string,
  opts: {
    requiredChecksFail?: boolean;
    checkCountResults?: Array<number | "fail">;
  } = {},
) {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-ci-gate-"));
  tmps.push(artifacts);
  writeFileSync(join(artifacts, ".pr-number"), "42\n");
  const checkCountResults = opts.checkCountResults ?? [1];
  const renderCheckCountResult = (result: number | "fail") =>
    result === "fail" ? "exit 1" : `echo ${result}`;
  const checkCountArms = checkCountResults
    .map((result, index) => `    ${index + 1}) ${renderCheckCountResult(result)} ;;`)
    .join("\n");
  const checkCountFallback = renderCheckCountResult(
    checkCountResults[checkCountResults.length - 1] ?? 1,
  );
  const requiredArm = opts.requiredChecksFail
    ? `"pr required-checks 42") echo "forge: could not resolve base branch for PR 42" >&2; exit 1 ;;`
    : `"pr required-checks 42") exit 0 ;;`;
  const forge = `#!/usr/bin/env bash
case "$*" in
  "pr checks 42 --json state -q length")
    CHECK_COUNT_CALL=0
    [ ! -f "$CHECK_COUNT_MARKER" ] || CHECK_COUNT_CALL=$(cat "$CHECK_COUNT_MARKER")
    CHECK_COUNT_CALL=$((CHECK_COUNT_CALL + 1))
    printf '%s\\n' "$CHECK_COUNT_CALL" > "$CHECK_COUNT_MARKER"
    case "$CHECK_COUNT_CALL" in
${checkCountArms}
      *) ${checkCountFallback} ;;
    esac
    ;;
  ${requiredArm}
  "pr checks 42 --json name,bucket,state") echo '${snapshot}' ;;
  "pr ready 42") touch "$READY_MARKER" ;;
  *) echo "unexpected forge args: $*" >&2; exit 1 ;;
esac
`;
  const sleep = `touch "$SLEEP_MARKER"`;
  const bin = fakeBinDir({ forge, sleep });
  tmps.push(bin);
  const readyMarker = join(artifacts, ".ready-called");
  const checkCountMarker = join(artifacts, ".check-count-calls");
  const sleepMarker = join(artifacts, ".sleep-called");
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", workflowBash(workflow, nodeId)],
    env: {
      ...(process.env as Record<string, string>),
      CHECK_COUNT_MARKER: checkCountMarker,
      KEELSON_CI_RECHECK_INTERVAL: "0",
      KEELSON_ARTIFACTS_DIR: artifacts,
      PATH: pathWith(bin),
      READY_MARKER: readyMarker,
      SLEEP_MARKER: sleepMarker,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    readyCalled: existsSync(readyMarker),
    checkCountCalls: Number(readFileSync(checkCountMarker, "utf8").trim()),
    sleepCalled: existsSync(sleepMarker),
  };
}

shimDescribe("CI advisory gate", () => {
  for (const workflow of ["resolve-pr", "fix-issue"]) {
    test(`${workflow}: zero required checks with a failing check emits FAIL`, () => {
      const result = runAdvisoryGate(
        workflow,
        "await-ci",
        '[{"name":"Linux tests","bucket":"fail","state":"FAILURE"}]',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("failing check: Linux tests — failure");
      expect(result.stdout).toContain("CI_STATUS: FAIL");
      expect(result.stdout).not.toContain("CI_STATUS: PASS");
    });
  }

  // fix-issue's gate is a one-shot draft/ready decision, so a failed discovery
  // stays fail-closed as UNKNOWN (the PR just stays a draft). resolve-pr's gate
  // drives a converge loop where UNKNOWN can never converge, so it falls back to
  // gating on EVERY check — strictly: with the required set unknown, nothing may
  // ride the advisory carve-outs.
  test("fix-issue: required-check discovery failure emits UNKNOWN, never PASS", () => {
    const result = runAdvisoryGate(
      "fix-issue",
      "await-ci",
      '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
      { requiredChecksFail: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CI_STATUS: UNKNOWN");
    expect(result.stdout).not.toContain("CI_STATUS: PASS");
    expect(result.stdout).not.toContain("CI_STATUS: FAIL");
  });

  test("resolve-pr: discovery failure with every check green emits PASS", () => {
    const result = runAdvisoryGate(
      "resolve-pr",
      "await-ci",
      '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
      { requiredChecksFail: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gating on every check");
    expect(result.stdout).toContain("CI_STATUS: PASS");
    expect(result.stdout).not.toContain("CI_STATUS: UNKNOWN");
  });

  test("resolve-pr: discovery failure denies the advisory carve-out to a cancelled check", () => {
    const result = runAdvisoryGate(
      "resolve-pr",
      "await-ci",
      '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"},{"name":"Windows tests","bucket":"cancel","state":"CANCELLED"}]',
      { requiredChecksFail: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not green and possibly required: Windows tests — cancelled");
    expect(result.stdout).toContain("CI_STATUS: FAIL");
    expect(result.stdout).not.toContain("treated as advisory");
  });

  test("finalize-pr leaves the PR a draft when discovery fails", () => {
    const result = runAdvisoryGate(
      "fix-issue",
      "finalize-pr",
      '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
      { requiredChecksFail: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PR_STATE: UNKNOWN");
    expect(result.readyCalled).toBe(false);
  });

  test("finalize-pr keeps a genuinely failing advisory-only PR in draft", () => {
    const result = runAdvisoryGate(
      "fix-issue",
      "finalize-pr",
      '[{"name":"Linux tests","bucket":"fail","state":"FAILURE"}]',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PR_STATE: DRAFT");
    expect(result.readyCalled).toBe(false);
  });

  test("finalize-pr promotes when a cancelled check is advisory", () => {
    const result = runAdvisoryGate(
      "fix-issue",
      "finalize-pr",
      '[{"name":"Typecheck and test (Windows)","bucket":"cancel","state":"CANCELLED"}]',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "treated as advisory: Typecheck and test (Windows) — cancelled",
    );
    expect(result.stdout).toContain("PR_STATE: READY");
    expect(result.readyCalled).toBe(true);
  });

  test("checks already present proceed without sleeping", () => {
    for (const [workflow, nodeId, expected] of [
      ["fix-issue", "finalize-pr", "PR_STATE: READY"],
      ["fix-issue", "await-ci", "CI_STATUS: PASS"],
      ["resolve-pr", "await-ci", "CI_STATUS: PASS"],
    ]) {
      const result = runAdvisoryGate(
        workflow,
        nodeId,
        '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.checkCountCalls).toBe(1);
      expect(result.sleepCalled).toBe(false);
    }
  });

  for (const [bucket, state, expected, readyCalled] of [
    ["pass", "SUCCESS", "PR_STATE: READY", true],
    ["fail", "FAILURE", "PR_STATE: DRAFT", false],
  ] as const) {
    test(`finalize-pr re-polls transiently empty checks before a ${bucket} gate`, () => {
      const result = runAdvisoryGate(
        "fix-issue",
        "finalize-pr",
        `[{"name":"Linux tests","bucket":"${bucket}","state":"${state}"}]`,
        { checkCountResults: [0, 1] },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.stdout).not.toContain("no CI checks present");
      expect(result.readyCalled).toBe(readyCalled);
      expect(result.checkCountCalls).toBe(2);
    });
  }

  test("finalize-pr distinguishes repeated check query failures", () => {
    const result = runAdvisoryGate(
      "fix-issue",
      "finalize-pr",
      '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
      { checkCountResults: ["fail", "fail", "fail", "fail", "fail", "fail"] },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PR_STATE: DRAFT — could not query CI checks");
    expect(result.stdout).not.toContain("no CI checks present");
    expect(result.readyCalled).toBe(false);
    expect(result.checkCountCalls).toBe(6);
  });

  test("finalize-pr leaves genuinely checkless PRs in draft after re-polling", () => {
    const result = runAdvisoryGate(
      "fix-issue",
      "finalize-pr",
      '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
      { checkCountResults: [0, 0, 0, 0, 0, 0] },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PR_STATE: DRAFT — no CI checks present after re-poll");
    expect(result.readyCalled).toBe(false);
    expect(result.checkCountCalls).toBe(6);
  });

  for (const workflow of ["fix-issue", "resolve-pr"]) {
    test(`${workflow}: await-ci re-polls transiently empty checks`, () => {
      const result = runAdvisoryGate(
        workflow,
        "await-ci",
        '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
        { checkCountResults: [0, 1] },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CI_STATUS: PASS");
      expect(result.stdout).not.toContain("CI_STATUS: UNKNOWN");
      expect(result.stdout).not.toContain("no CI checks present");
      expect(result.checkCountCalls).toBe(2);
    });

    test(`${workflow}: await-ci reports repeated check query failures as UNKNOWN`, () => {
      const result = runAdvisoryGate(
        workflow,
        "await-ci",
        '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
        { checkCountResults: ["fail", "fail", "fail", "fail", "fail", "fail"] },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CI_STATUS: UNKNOWN");
      expect(result.stdout).toContain("could not query CI checks");
      expect(result.stdout).not.toContain("CI_STATUS: PASS");
      expect(result.stdout).not.toContain("no CI checks present");
      expect(result.checkCountCalls).toBe(6);
    });

    test(`${workflow}: await-ci reports genuinely empty checks as UNKNOWN`, () => {
      const result = runAdvisoryGate(
        workflow,
        "await-ci",
        '[{"name":"Linux tests","bucket":"pass","state":"SUCCESS"}]',
        { checkCountResults: [0, 0, 0, 0, 0, 0] },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CI_STATUS: UNKNOWN");
      expect(result.stdout).toContain("no CI checks present");
      expect(result.stdout).toContain("after re-poll");
      expect(result.stdout).not.toContain("CI_STATUS: PASS");
      expect(result.checkCountCalls).toBe(6);
    });
  }
});
