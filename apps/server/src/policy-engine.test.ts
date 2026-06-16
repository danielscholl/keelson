// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import type { Policy } from "@keelson/shared";
import { createPolicyEngine } from "./policy-engine.ts";

// Candidate tools are matched by name only; the engine never touches other fields.
const tools = (...names: string[]) => names.map((name) => ({ name }));
const chat = { surface: "chat" as const };

describe("createPolicyEngine — projectTools", () => {
  it("passes everything through when there are no policies and no denylist", async () => {
    const engine = createPolicyEngine();
    const { allowed, denied } = await engine.projectTools(tools("a", "b", "c"), chat);
    expect(allowed.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(denied).toEqual([]);
  });

  it("drops denylisted tools via the builtin, preserving the order of survivors", async () => {
    const engine = createPolicyEngine({ denylist: ["b"] });
    const { allowed, denied } = await engine.projectTools(tools("a", "b", "c"), chat);
    expect(allowed.map((t) => t.name)).toEqual(["a", "c"]);
    expect(denied).toEqual([{ tool: "b", reason: "denylisted by operator floor" }]);
  });

  it("drops a tool a rib policy denies, recording the policy's reason", async () => {
    const policy: Policy = {
      id: "no-genesis",
      on: [{ phase: "tool_call" }],
      evaluate: (e) =>
        e.phase === "tool_call" && e.tool === "genesis"
          ? { outcome: "deny", reason: "genesis is gated" }
          : { outcome: "allow" },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "chamber", policy }] });
    const { allowed, denied } = await engine.projectTools(tools("lens", "genesis"), {
      surface: "rib",
      ribId: "chamber",
    });
    expect(allowed.map((t) => t.name)).toEqual(["lens"]);
    expect(denied).toEqual([{ tool: "genesis", reason: "genesis is gated" }]);
  });

  it("degrades an ASK to deny-with-reason at projection time", async () => {
    const policy: Policy = {
      id: "ask-shell",
      evaluate: () => ({ outcome: "ask", reason: "confirm shell access" }),
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy }] });
    const { allowed, denied } = await engine.projectTools(tools("bash"), chat);
    expect(allowed).toEqual([]);
    expect(denied[0]?.tool).toBe("bash");
    expect(denied[0]?.reason).toContain("requires approval (deferred)");
    expect(denied[0]?.reason).toContain("confirm shell access");
  });

  it("is first-deny-wins with the builtin floor evaluated before rib policies", async () => {
    // A rib policy that would allow everything cannot rescue a denylisted tool —
    // the builtin floor runs first and short-circuits.
    const allowAll: Policy = { id: "allow-all", evaluate: () => ({ outcome: "allow" }) };
    const engine = createPolicyEngine({
      denylist: ["b"],
      ribPolicies: [{ ribId: "r", policy: allowAll }],
    });
    const { allowed } = await engine.projectTools(tools("a", "b"), chat);
    expect(allowed.map((t) => t.name)).toEqual(["a"]);
  });

  it("fails closed per-policy: a throwing policy is a no-op (allow), never a turn-killer", async () => {
    const thrower: Policy = {
      id: "boom",
      evaluate: () => {
        throw new Error("kaboom");
      },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: thrower }] });
    const { allowed, denied } = await engine.projectTools(tools("a", "b"), chat);
    // The throw doesn't deny anything and doesn't propagate.
    expect(allowed.map((t) => t.name)).toEqual(["a", "b"]);
    expect(denied).toEqual([]);
  });

  it("awaits an async policy decision", async () => {
    const asyncDeny: Policy = {
      id: "async-deny",
      evaluate: async (e) =>
        e.phase === "tool_call" && e.tool === "slow"
          ? { outcome: "deny", reason: "nope" }
          : { outcome: "allow" },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: asyncDeny }] });
    const { allowed } = await engine.projectTools(tools("fast", "slow"), chat);
    expect(allowed.map((t) => t.name)).toEqual(["fast"]);
  });

  it("resolves a non-native thenable returned by evaluate (not just native Promises)", async () => {
    // A foreign thenable — `instanceof Promise` would be false; the engine awaits it.
    const thenableDeny: Policy = {
      id: "thenable",
      evaluate: () =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: deliberately a foreign thenable to exercise the engine's await path.
          then: (resolve: (d: { outcome: "deny"; reason: string }) => void) =>
            resolve({ outcome: "deny", reason: "from a thenable" }),
        }) as unknown as Promise<{ outcome: "deny"; reason: string }>,
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: thenableDeny }] });
    const { allowed, denied } = await engine.projectTools(tools("a"), chat);
    expect(allowed).toEqual([]);
    expect(denied).toEqual([{ tool: "a", reason: "from a thenable" }]);
  });

  it("does not crash the projection when a policy's `on` matcher is malformed (engine backstop)", async () => {
    // isPolicy rejects this at the contribution boundary, but the engine must
    // also fail closed per-policy if a bad `on` reaches it directly — matches()
    // throwing must not take the whole turn down.
    const badOn = {
      id: "bad-on",
      on: "tool_call",
      evaluate: () => ({ outcome: "deny", reason: "should never be consulted" }),
    } as unknown as Policy;
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: badOn }] });
    const { allowed, denied } = await engine.projectTools(tools("a", "b"), chat);
    // The throwing policy is skipped (no opinion); nothing is denied.
    expect(allowed.map((t) => t.name)).toEqual(["a", "b"]);
    expect(denied).toEqual([]);
  });

  it("only consults a policy for events its `on` matcher selects (by tool)", async () => {
    const onlyX: Policy = {
      id: "deny-x-only",
      on: [{ phase: "tool_call", tool: "x" }],
      // Denies unconditionally — but should only ever see tool `x`.
      evaluate: () => ({ outcome: "deny", reason: "x is gated" }),
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: onlyX }] });
    const { allowed } = await engine.projectTools(tools("x", "y"), chat);
    expect(allowed.map((t) => t.name)).toEqual(["y"]);
  });

  it("surfaces the surface + rib id on the policy context", async () => {
    let seen: { surface: string; ribId?: string } | undefined;
    const recorder: Policy = {
      id: "recorder",
      evaluate: (_e, ctx) => {
        seen = { surface: ctx.surface, ...(ctx.ribId !== undefined ? { ribId: ctx.ribId } : {}) };
        return { outcome: "allow" };
      },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "chamber", policy: recorder }] });
    await engine.projectTools(tools("a"), { surface: "rib", ribId: "chamber" });
    expect(seen).toEqual({ surface: "rib", ribId: "chamber" });
  });
});
