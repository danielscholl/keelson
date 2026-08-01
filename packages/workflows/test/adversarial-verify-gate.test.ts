// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function verifyGateBash(): string {
  const document = parse(
    readFileSync(join(bundledWorkflowsDir(), "adversarial-review.yaml"), "utf8"),
  ) as { nodes: Array<{ id: string; bash?: string }> };
  const script = document.nodes.find((node) => node.id === "verify-gate")?.bash;
  if (!script) throw new Error("Missing verify-gate bash node in adversarial-review");
  return script;
}

function runVerifyGate(output: string, outputFile?: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KEELSON_NODE_verify_OUTPUT: output,
  };
  if (outputFile !== undefined) env.KEELSON_NODE_verify_OUTPUT_FILE = outputFile;

  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", verifyGateBash()],
    cwd: tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
  };
}

shimDescribe("adversarial-review verify gate", () => {
  test("rejects the observed 141-character preamble", () => {
    const output =
      "I'll inspect the pinned snapshot directly, then trace the implementation, all process-launch sites, and the checked-in test/CI configuration.";
    expect(output.length).toBe(141);

    const result = runVerifyGate(output);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("keelson workflow resume <runId>");
  });

  test("rejects empty output", () => {
    expect(runVerifyGate("").exitCode).not.toBe(0);
  });

  test("accepts a bold per-claim record", () => {
    const output = [
      "- **Claim**: deploy.py routes every process launch",
      "- **Result**: CONFIRMED",
      "- **Evidence**: deploy.py:282 passes stdin=subprocess.DEVNULL",
    ].join("\n");
    expect(runVerifyGate(output).exitCode).toBe(0);
  });

  test("accepts a plain per-claim record", () => {
    expect(runVerifyGate("Claim: the import is dead\nResult: UNVERIFIABLE-HERE").exitCode).toBe(0);
  });

  test("rejects prose that merely mentions a result", () => {
    const output = "I traced the implementation and the result: everything looks consistent.";
    expect(runVerifyGate(output).exitCode).not.toBe(0);
  });

  test("rejects a verdict line with no claim list", () => {
    expect(runVerifyGate("- **Result**: CONFIRMED").exitCode).not.toBe(0);
  });

  test("rejects a claim list with no recognized verdict", () => {
    expect(runVerifyGate("- **Claim**: x holds\n- **Result**: probably fine").exitCode).not.toBe(0);
  });

  test("ignores an inherited spill file and judges only the current output", () => {
    const dir = mkdtempSync(join(tmpdir(), "keelson-ar-verify-gate-"));
    tmps.push(dir);
    const outputFile = join(dir, "verify-output.txt");
    writeFileSync(outputFile, "- **Claim**: x is dead code\n- **Result**: REFUTED\n");

    const result = runVerifyGate("truncated verification preamble", outputFile);

    expect(result.exitCode).not.toBe(0);
  });

  test("passes on a head+tail truncated output that still carries a record", () => {
    const output = [
      "- **Claim**: the launch path is routed",
      "- **Result**: CONFIRMED",
      "[keelson: output truncated — 48000 chars total]",
      "**Corrections**: none",
    ].join("\n");
    expect(runVerifyGate(output).exitCode).toBe(0);
  });
});
