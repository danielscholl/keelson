// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { RunStreamEvent } from "@keelson/workflows";

import { MemoryRequiresServerError, runHeadless } from "../src/in-process/run-workflow.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures");

describe("runHeadless (in-process executor)", () => {
  test("bash-only fixture runs to succeeded and emits node events", async () => {
    const events: RunStreamEvent[] = [];
    const result = await runHeadless({
      name: "smoke-bash",
      inputs: { TEST_NAME: "cli" },
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
      onEvent: (ev) => events.push(ev),
    });

    expect(result.summary.status).toBe("succeeded");
    expect(events.some((e) => e.type === "run_started")).toBe(true);
    expect(events.some((e) => e.type === "node_done")).toBe(true);
    expect(events.some((e) => e.type === "run_done")).toBe(true);
  });

  test("unknown workflow name throws WorkflowNotFoundError", async () => {
    const promise = runHeadless({
      name: "does-not-exist",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
    });
    expect(promise).rejects.toThrow(/no workflow named/);
  });

  test("memory-bearing workflow refused with MemoryRequiresServerError (M5)", async () => {
    const promise = runHeadless({
      name: "memory-required",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
    });
    await expect(promise).rejects.toBeInstanceOf(MemoryRequiresServerError);
    await expect(promise).rejects.toThrow(/Memory requires the server/);
    await expect(promise).rejects.toThrow(/think/); // names the memory-bearing node
  });
});
