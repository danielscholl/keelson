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

function runAdvisoryGate(workflow: string, nodeId: string, snapshot: string) {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-ci-gate-"));
  tmps.push(artifacts);
  writeFileSync(join(artifacts, ".pr-number"), "42\n");
  const forge = `#!/usr/bin/env bash
case "$*" in
  "pr checks 42 --json state -q length") echo 1 ;;
  "pr required-checks 42") exit 0 ;;
  "pr checks 42 --json name,bucket,state") echo '${snapshot}' ;;
  "pr ready 42") touch "$READY_MARKER" ;;
  *) echo "unexpected forge args: $*" >&2; exit 1 ;;
esac
`;
  const bin = fakeBinDir({ forge });
  tmps.push(bin);
  const readyMarker = join(artifacts, ".ready-called");
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", workflowBash(workflow, nodeId)],
    env: {
      ...(process.env as Record<string, string>),
      KEELSON_ARTIFACTS_DIR: artifacts,
      PATH: pathWith(bin),
      READY_MARKER: readyMarker,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    readyCalled: existsSync(readyMarker),
  };
}

shimDescribe("CI advisory gate", () => {
  for (const workflow of ["finish-pr", "fix-issue"]) {
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
});
