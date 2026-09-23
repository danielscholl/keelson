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

function metricsBash(): string {
  const document = parse(readFileSync(join(bundledWorkflowsDir(), "resolve-pr.yaml"), "utf8")) as {
    nodes: Array<{ id: string; bash?: string }>;
  };
  const script = document.nodes.find((node) => node.id === "report-metrics")?.bash;
  if (!script) throw new Error("Missing report-metrics bash node in resolve-pr");
  return script;
}

function run(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "report-metrics-"));
  tmps.push(dir);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", metricsBash()],
    cwd: dir,
    env: { ...(process.env as Record<string, string>), KEELSON_ARTIFACTS_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  return JSON.parse(proc.stdout.toString());
}

shimDescribe("resolve-pr report-metrics", () => {
  test("counts each thread from its latest ledger entry", () => {
    const metrics = run({
      "handled.json": [
        {
          threadId: "a",
          replied: true,
          resolved: false,
          resolve_authorized: true,
          decision: "actionable-code-change",
        },
        {
          threadId: "a",
          replied: true,
          resolved: true,
          resolve_authorized: true,
          decision: "actionable-code-change",
        },
        {
          threadId: "b",
          replied: true,
          resolved: false,
          resolve_authorized: false,
          decision: "question",
        },
        {
          threadId: "c",
          replied: true,
          resolved: false,
          resolve_authorized: true,
          decision: "invalid",
        },
      ],
      "mergeability.json": {
        round: 3,
        ci_status: "PASS",
        review_threads_clear: false,
        open_threads: [{ threadId: "b", path: "src/x.ts", line: 4 }],
      },
      "reply-failures.json": [{ round: 2, stage: "reply-resolve", threads: ["c"], reason: "x" }],
    });

    expect(metrics).toEqual({
      rounds: 3,
      replied: 3,
      resolved: 1,
      awaiting_reviewer: 1,
      resolvable_unresolved: ["c"],
      ci_status: "PASS",
      review_threads_clear: false,
      open_paths: ["src/x.ts"],
      reply_failures: [{ round: 2, stage: "reply-resolve", threads: ["c"], reason: "x" }],
    });
  });

  test("missing or corrupt inputs report unknowns, not a clean result", () => {
    const metrics = run({ "handled.json": "{not json" });

    expect(metrics).toMatchObject({
      rounds: null,
      replied: 0,
      ci_status: "UNKNOWN",
      review_threads_clear: null,
      reply_failures: [],
    });
  });

  test("a mergeability value that is valid JSON but not an object reports unknowns", () => {
    for (const bad of ["[]", "true", '{"open_threads": {"path": "x"}}']) {
      const metrics = run({ "mergeability.json": bad });
      expect(metrics.rounds).toBeNull();
      expect(metrics.ci_status).toBe("UNKNOWN");
      expect(metrics.review_threads_clear).toBeNull();
      expect(metrics.open_paths).toEqual([]);
    }
  });
});
