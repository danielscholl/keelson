// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import { checkToolCallGate } from "../src/tool-gate.ts";
import type { ToolCallGate } from "../src/types.ts";

describe("checkToolCallGate", () => {
  test("no gate wired → not denied (back-compat passthrough)", async () => {
    expect(await checkToolCallGate(undefined, "a", { x: 1 })).toEqual({ denied: false });
  });

  test("an allow decision is not denied and forwards the args to the gate", async () => {
    let seen: { tool: string; args?: unknown } | undefined;
    const gate: ToolCallGate = async (call) => {
      seen = call;
      return { outcome: "allow" };
    };
    expect(await checkToolCallGate(gate, "write", { path: "/tmp" })).toEqual({ denied: false });
    expect(seen).toEqual({ tool: "write", args: { path: "/tmp" } });
  });

  test("a deny decision is denied with a tool-prefixed message", async () => {
    const gate: ToolCallGate = async () => ({ outcome: "deny", reason: "blocked" });
    expect(await checkToolCallGate(gate, "rm", { path: "/" })).toEqual({
      denied: true,
      message: "Tool 'rm' denied by policy: blocked",
    });
  });

  test("a gate that rejects is treated as allow (fail-open), never wedging the turn", async () => {
    const gate: ToolCallGate = async () => {
      throw new Error("engine bug");
    };
    expect(await checkToolCallGate(gate, "a", {})).toEqual({ denied: false });
  });

  test("omits args from the call when they are undefined", async () => {
    let seen: { tool: string; args?: unknown } | undefined;
    const gate: ToolCallGate = async (call) => {
      seen = call;
      return { outcome: "allow" };
    };
    await checkToolCallGate(gate, "noargs", undefined);
    expect(seen).toEqual({ tool: "noargs" });
    expect(seen !== undefined && "args" in seen).toBe(false);
  });

  test("a gate that RESOLVES to a malformed/null decision is treated as allow (fail-open, no crash)", async () => {
    // The engine never does this, but ToolCallGate is public — a malformed
    // resolve must not throw out of the helper and wedge the turn.
    const nullGate = (async () => null) as unknown as ToolCallGate;
    expect(await checkToolCallGate(nullGate, "a", {})).toEqual({ denied: false });
    const noOutcome = (async () => ({})) as unknown as ToolCallGate;
    expect(await checkToolCallGate(noOutcome, "a", {})).toEqual({ denied: false });
  });

  test("a reasonless deny still denies, with a coerced reason", async () => {
    const gate = (async () => ({ outcome: "deny" })) as unknown as ToolCallGate;
    expect(await checkToolCallGate(gate, "rm", {})).toEqual({
      denied: true,
      message: "Tool 'rm' denied by policy: denied",
    });
  });
});
