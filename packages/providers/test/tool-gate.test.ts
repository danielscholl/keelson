// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import { applyToolResultGate, checkToolCallGate } from "../src/tool-gate.ts";
import type { ToolCallGate, ToolResultGate } from "../src/types.ts";

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

describe("applyToolResultGate", () => {
  test("no gate wired → result passes through unchanged", async () => {
    expect(await applyToolResultGate(undefined, "fetch", "secret", false)).toEqual({
      content: "secret",
      isError: false,
    });
  });

  test("a plain allow leaves the content and isError untouched, forwarding the result", async () => {
    let seen: { tool: string; result: unknown } | undefined;
    const gate: ToolResultGate = async (r) => {
      seen = r;
      return { outcome: "allow" };
    };
    expect(await applyToolResultGate(gate, "fetch", "body", true)).toEqual({
      content: "body",
      isError: true,
    });
    expect(seen).toEqual({ tool: "fetch", result: "body" });
  });

  test("an allow with string data substitutes the content, preserving isError", async () => {
    const gate: ToolResultGate = async () => ({ outcome: "allow", data: "tok=[REDACTED]" });
    expect(await applyToolResultGate(gate, "fetch", "tok=abc123", false)).toEqual({
      content: "tok=[REDACTED]",
      isError: false,
    });
  });

  test("a deny replaces the content with the reason and marks it an error", async () => {
    const gate: ToolResultGate = async () => ({ outcome: "deny", reason: "leaked a secret" });
    expect(await applyToolResultGate(gate, "fetch", "sk-live-123", false)).toEqual({
      content: "Tool 'fetch' result withheld by policy: leaked a secret",
      isError: true,
    });
  });

  test("a reasonless deny still withholds, with a coerced reason", async () => {
    const gate = (async () => ({ outcome: "deny" })) as unknown as ToolResultGate;
    expect(await applyToolResultGate(gate, "fetch", "x", false)).toEqual({
      content: "Tool 'fetch' result withheld by policy: withheld",
      isError: true,
    });
  });

  test("an allow carrying a non-string data is ignored (can't substitute text)", async () => {
    const gate = (async () => ({
      outcome: "allow",
      data: { redacted: true },
    })) as unknown as ToolResultGate;
    expect(await applyToolResultGate(gate, "fetch", "body", false)).toEqual({
      content: "body",
      isError: false,
    });
  });

  test("a gate that throws passes the result through unchanged (fail-open)", async () => {
    const gate: ToolResultGate = async () => {
      throw new Error("engine bug");
    };
    expect(await applyToolResultGate(gate, "fetch", "body", false)).toEqual({
      content: "body",
      isError: false,
    });
  });

  test("a gate resolving to a malformed/null decision passes through unchanged (fail-open)", async () => {
    const nullGate = (async () => null) as unknown as ToolResultGate;
    expect(await applyToolResultGate(nullGate, "fetch", "body", true)).toEqual({
      content: "body",
      isError: true,
    });
    const noOutcome = (async () => ({})) as unknown as ToolResultGate;
    expect(await applyToolResultGate(noOutcome, "fetch", "body", false)).toEqual({
      content: "body",
      isError: false,
    });
  });
});
