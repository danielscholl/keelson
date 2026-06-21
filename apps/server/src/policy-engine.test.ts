// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import type { ApprovalRequest, Policy } from "@keelson/shared";
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

  it("treats a null/undefined evaluate() return as allow, never crashing the projection", async () => {
    // A JS rib (or a missing `else` return) yields undefined for non-matching
    // tools — reading decision.outcome must not throw and reject projectTools.
    const undefReturn = {
      id: "implicit-undefined",
      evaluate: (e: { phase: string; tool?: string }) =>
        e.phase === "tool_call" && e.tool === "x" ? { outcome: "deny", reason: "no x" } : undefined,
    } as unknown as Policy;
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: undefReturn }] });
    const { allowed, denied } = await engine.projectTools(tools("x", "y"), chat);
    // `x` is denied; `y` (undefined return) is allowed — no throw, no fail-open of the whole gate.
    expect(allowed.map((t) => t.name)).toEqual(["y"]);
    expect(denied).toEqual([{ tool: "x", reason: "no x" }]);
  });

  it("still drops a tool for a deny decision that omits its reason", async () => {
    const denyNoReason = {
      id: "deny-no-reason",
      evaluate: () => ({ outcome: "deny" }),
    } as unknown as Policy;
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: denyNoReason }] });
    const { allowed, denied } = await engine.projectTools(tools("a"), chat);
    expect(allowed).toEqual([]);
    expect(denied).toEqual([{ tool: "a", reason: "denied" }]);
  });

  it("treats an unrecognized outcome as allow (not a silent deny, not a crash)", async () => {
    const bogus = {
      id: "bogus-outcome",
      evaluate: () => ({ outcome: "maybe" }),
    } as unknown as Policy;
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: bogus }] });
    const { allowed, denied } = await engine.projectTools(tools("a", "b"), chat);
    expect(allowed.map((t) => t.name)).toEqual(["a", "b"]);
    expect(denied).toEqual([]);
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

  it("threads provider onto the tool_call context, not just the event", async () => {
    let seen: { surface: string; provider?: string } | undefined;
    const recorder: Policy = {
      id: "recorder",
      evaluate: (_e, ctx) => {
        seen = {
          surface: ctx.surface,
          ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
        };
        return { outcome: "allow" };
      },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: recorder }] });
    await engine.evaluateToolCall({ tool: "a" }, { surface: "chat", provider: "claude" });
    expect(seen).toEqual({ surface: "chat", provider: "claude" });
  });
});

describe("createPolicyEngine — evaluateToolCall", () => {
  it("allows a call when no policy denies", async () => {
    const engine = createPolicyEngine();
    const decision = await engine.evaluateToolCall({ tool: "a", args: { x: 1 } }, chat);
    expect(decision).toEqual({ outcome: "allow" });
  });

  it("denies a call whose tool the operator floor denylists, regardless of args", async () => {
    const engine = createPolicyEngine({ denylist: ["rm"] });
    const decision = await engine.evaluateToolCall({ tool: "rm", args: { path: "/x" } }, chat);
    expect(decision).toEqual({ outcome: "deny", reason: "denylisted by operator floor" });
  });

  it("denies a call on the strength of its ARGS — the per-call capability", async () => {
    // Exercises the projection/per-call interplay: a tool can clear name-based
    // projection yet still be denied for a specific call on its args.
    const guardEtc: Policy = {
      id: "no-etc-writes",
      on: [{ phase: "tool_call", tool: "write_file" }],
      evaluate: (e) => {
        const path = e.phase === "tool_call" ? (e.args as { path?: string } | undefined)?.path : "";
        return typeof path === "string" && path.startsWith("/etc/")
          ? { outcome: "deny", reason: "writes under /etc are blocked" }
          : { outcome: "allow" };
      },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "fs", policy: guardEtc }] });

    // Same tool clears projection (no args) ...
    const projected = await engine.projectTools(tools("write_file"), chat);
    expect(projected.allowed.map((t) => t.name)).toEqual(["write_file"]);

    // ... a safe call is allowed ...
    const ok = await engine.evaluateToolCall(
      { tool: "write_file", args: { path: "/tmp/ok.txt" } },
      chat,
    );
    expect(ok).toEqual({ outcome: "allow" });

    // ... but a call writing under /etc is denied per-call.
    const blocked = await engine.evaluateToolCall(
      { tool: "write_file", args: { path: "/etc/passwd" } },
      chat,
    );
    expect(blocked).toEqual({ outcome: "deny", reason: "writes under /etc are blocked" });
  });

  it("hands the policy the call's args, ribId, and provider on the event", async () => {
    let seen: { phase: string; tool?: string; args?: unknown; ribId?: string; provider?: string } =
      { phase: "" };
    const recorder: Policy = {
      id: "recorder",
      evaluate: (e) => {
        seen = { ...e };
        return { outcome: "allow" };
      },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "chamber", policy: recorder }] });
    await engine.evaluateToolCall(
      { tool: "lens", args: { topic: "x" } },
      { surface: "rib", ribId: "chamber", provider: "claude" },
    );
    expect(seen).toEqual({
      phase: "tool_call",
      tool: "lens",
      args: { topic: "x" },
      ribId: "chamber",
      provider: "claude",
    });
  });

  it("degrades an ASK to deny-with-reason (no per-call round-trip yet)", async () => {
    const ask: Policy = { id: "ask", evaluate: () => ({ outcome: "ask", reason: "confirm" }) };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: ask }] });
    const decision = await engine.evaluateToolCall({ tool: "bash", args: {} }, chat);
    expect(decision.outcome).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("requires approval (deferred)");
    expect((decision as { reason: string }).reason).toContain("confirm");
  });

  it("fails open per-policy: a throwing policy allows the call rather than killing the turn", async () => {
    const thrower: Policy = {
      id: "boom",
      evaluate: () => {
        throw new Error("kaboom");
      },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: thrower }] });
    const decision = await engine.evaluateToolCall({ tool: "a", args: {} }, chat);
    expect(decision).toEqual({ outcome: "allow" });
  });

  it("coerces a reasonless deny so the call is still denied", async () => {
    const denyNoReason = {
      id: "deny-no-reason",
      evaluate: () => ({ outcome: "deny" }),
    } as unknown as Policy;
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: denyNoReason }] });
    const decision = await engine.evaluateToolCall({ tool: "a" }, chat);
    expect(decision).toEqual({ outcome: "deny", reason: "denied" });
  });

  it("is first-deny-wins with the builtin floor ahead of rib policies", async () => {
    // A rib policy that would allow everything cannot rescue a denylisted call.
    const allowAll: Policy = { id: "allow-all", evaluate: () => ({ outcome: "allow" }) };
    const engine = createPolicyEngine({
      denylist: ["rm"],
      ribPolicies: [{ ribId: "r", policy: allowAll }],
    });
    const decision = await engine.evaluateToolCall({ tool: "rm", args: {} }, chat);
    expect(decision.outcome).toBe("deny");
  });
});

describe("createPolicyEngine — ASK approval round-trip", () => {
  const askPolicy: Policy = {
    id: "ask",
    on: [{ phase: "tool_call" }],
    evaluate: () => ({ outcome: "ask", reason: "confirm" }),
  };
  const accept = async (): Promise<"accept"> => "accept";

  it("lets an ASK tool through projection when an approval channel is wired", async () => {
    const engine = createPolicyEngine({
      ribPolicies: [{ ribId: "r", policy: askPolicy }],
      requestApproval: accept,
    });
    const { allowed, denied } = await engine.projectTools(tools("bash"), chat);
    // Survives projection so the per-call seam can ask; nothing denied here.
    expect(allowed.map((t) => t.name)).toEqual(["bash"]);
    expect(denied).toEqual([]);
  });

  it("per-call accept resolves to allow", async () => {
    const engine = createPolicyEngine({
      ribPolicies: [{ ribId: "r", policy: askPolicy }],
      requestApproval: accept,
    });
    expect(await engine.evaluateToolCall({ tool: "bash" }, chat)).toEqual({ outcome: "allow" });
  });

  it("per-call reject resolves to deny", async () => {
    const engine = createPolicyEngine({
      ribPolicies: [{ ribId: "r", policy: askPolicy }],
      requestApproval: async () => "reject",
    });
    const d = await engine.evaluateToolCall({ tool: "bash" }, chat);
    expect(d.outcome).toBe("deny");
    expect((d as { reason: string }).reason).toContain("approval rejected");
  });

  it("per-call: a throwing approval channel fails closed (deny), never open", async () => {
    const engine = createPolicyEngine({
      ribPolicies: [{ ribId: "r", policy: askPolicy }],
      requestApproval: async () => {
        throw new Error("channel down");
      },
    });
    const d = await engine.evaluateToolCall({ tool: "bash" }, chat);
    expect(d.outcome).toBe("deny");
    expect((d as { reason: string }).reason).toContain("approval unavailable");
  });

  it("hands the channel a redacted request (no args) plus the abort signal", async () => {
    let seenReq: ApprovalRequest | undefined;
    let seenSignal: AbortSignal | undefined;
    const onLens: Policy = {
      id: "ask",
      on: [{ phase: "tool_call", tool: "lens" }],
      evaluate: () => ({ outcome: "ask", reason: "confirm lens" }),
    };
    const ac = new AbortController();
    const engine = createPolicyEngine({
      ribPolicies: [{ ribId: "chamber", policy: onLens }],
      requestApproval: async (req, signal) => {
        seenReq = req;
        seenSignal = signal;
        return "accept";
      },
    });
    await engine.evaluateToolCall(
      { tool: "lens", args: { topic: "secret" } },
      { surface: "rib", ribId: "chamber", provider: "claude", signal: ac.signal },
    );
    expect(seenReq).toEqual({
      surface: "rib",
      policyId: "rib:chamber:ask",
      reason: "confirm lens",
      tool: "lens",
      ribId: "chamber",
      provider: "claude",
    });
    expect(seenReq).not.toHaveProperty("args");
    expect(seenSignal).toBe(ac.signal);
  });
});

describe("createPolicyEngine — ASK dedup (multiple asks on one event)", () => {
  const ribAsk = (id: string, reason: string): Policy => ({
    id,
    on: [{ phase: "tool_call" }],
    evaluate: () => ({ outcome: "ask", reason }),
  });

  it("coalesces ask_on_shell + a rib ASK on one call into a single prompt", async () => {
    let prompts = 0;
    const engine = createPolicyEngine({
      askOnShell: true,
      ribPolicies: [{ ribId: "chamber", policy: ribAsk("ask", "rib also wants to confirm") }],
      requestApproval: async () => {
        prompts++;
        return "accept";
      },
    });
    // Both ask_on_shell and the rib policy return `ask` for Bash, but first-ask-
    // wins coalesces them so the human is prompted once, not twice.
    expect(await engine.evaluateToolCall({ tool: "Bash" }, chat)).toEqual({ outcome: "allow" });
    expect(prompts).toBe(1);
  });

  it("denies on the first reject without prompting the second asking policy", async () => {
    let prompts = 0;
    const engine = createPolicyEngine({
      ribPolicies: [
        { ribId: "r", policy: ribAsk("ask-a", "A") },
        { ribId: "r", policy: ribAsk("ask-b", "B") },
      ],
      requestApproval: async () => {
        prompts++;
        return "reject";
      },
    });
    const d = await engine.evaluateToolCall({ tool: "bash" }, chat);
    expect(d.outcome).toBe("deny");
    expect(prompts).toBe(1);
  });

  it("a later DENY still wins after an earlier ASK was approved", async () => {
    let prompts = 0;
    const denyAfter: Policy = {
      id: "deny",
      on: [{ phase: "tool_call" }],
      evaluate: (e) =>
        e.phase === "tool_call" && e.tool === "bash"
          ? { outcome: "deny", reason: "blocked downstream" }
          : { outcome: "allow" },
    };
    const engine = createPolicyEngine({
      ribPolicies: [
        { ribId: "r", policy: ribAsk("ask-a", "A") },
        { ribId: "r", policy: denyAfter },
      ],
      requestApproval: async () => {
        prompts++;
        return "accept";
      },
    });
    // Dedup suppresses a redundant ASK prompt, never a later DENY.
    const d = await engine.evaluateToolCall({ tool: "bash" }, chat);
    expect(d).toEqual({ outcome: "deny", reason: "blocked downstream" });
    expect(prompts).toBe(1);
  });
});

describe("createPolicyEngine — ask_on_shell builtin", () => {
  const accept = async (): Promise<"accept"> => "accept";

  it("is off by default: a shell tool is allowed without asking", async () => {
    let asked = false;
    const engine = createPolicyEngine({
      requestApproval: async () => {
        asked = true;
        return "accept";
      },
    });
    expect(await engine.evaluateToolCall({ tool: "Bash" }, chat)).toEqual({ outcome: "allow" });
    expect(asked).toBe(false);
  });

  it("asks before a shell/file tool call when enabled, allowing on accept", async () => {
    const engine = createPolicyEngine({ askOnShell: true, requestApproval: accept });
    expect(await engine.evaluateToolCall({ tool: "Bash" }, chat)).toEqual({ outcome: "allow" });
    expect(await engine.evaluateToolCall({ tool: "shell_exec" }, chat)).toEqual({
      outcome: "allow",
    });
  });

  it("denies a shell tool call when the human rejects", async () => {
    const engine = createPolicyEngine({ askOnShell: true, requestApproval: async () => "reject" });
    expect((await engine.evaluateToolCall({ tool: "Write" }, chat)).outcome).toBe("deny");
  });

  it("does not ask for a non-shell tool", async () => {
    let asked = false;
    const engine = createPolicyEngine({
      askOnShell: true,
      requestApproval: async () => {
        asked = true;
        return "accept";
      },
    });
    expect(await engine.evaluateToolCall({ tool: "read_docs" }, chat)).toEqual({
      outcome: "allow",
    });
    expect(asked).toBe(false);
  });

  it("the operator denylist beats ask_on_shell — denied, not asked", async () => {
    let asked = false;
    const engine = createPolicyEngine({
      askOnShell: true,
      denylist: ["Bash"],
      requestApproval: async () => {
        asked = true;
        return "accept";
      },
    });
    const d = await engine.evaluateToolCall({ tool: "Bash" }, chat);
    expect(d).toEqual({ outcome: "deny", reason: "denylisted by operator floor" });
    expect(asked).toBe(false);
  });

  it("a later rib deny still wins after an ask_on_shell accept (first-deny-wins)", async () => {
    const denyBash: Policy = {
      id: "no-bash",
      on: [{ phase: "tool_call", tool: "Bash" }],
      evaluate: () => ({ outcome: "deny", reason: "bash is gated" }),
    };
    const engine = createPolicyEngine({
      askOnShell: true,
      ribPolicies: [{ ribId: "r", policy: denyBash }],
      requestApproval: accept,
    });
    expect(await engine.evaluateToolCall({ tool: "Bash" }, chat)).toEqual({
      outcome: "deny",
      reason: "bash is gated",
    });
  });

  it("without an approval channel, an enabled ask_on_shell degrades to deny", async () => {
    const engine = createPolicyEngine({ askOnShell: true });
    const d = await engine.evaluateToolCall({ tool: "Bash" }, chat);
    expect(d.outcome).toBe("deny");
    expect((d as { reason: string }).reason).toContain("requires approval (deferred)");
  });
});

describe("createPolicyEngine — requestPhaseActive", () => {
  it("is false with no budget builtins and no request-phase policy", () => {
    expect(createPolicyEngine().requestPhaseActive).toBe(false);
    expect(createPolicyEngine({ askOnShell: true, denylist: ["x"] }).requestPhaseActive).toBe(
      false,
    );
  });

  it("is true when a budget builtin is enabled", () => {
    expect(createPolicyEngine({ turnBudget: 5 }).requestPhaseActive).toBe(true);
    expect(createPolicyEngine({ costBudget: 1000 }).requestPhaseActive).toBe(true);
  });

  it("is true when a rib policy self-selects (no `on` matcher)", () => {
    const selfSelect: Policy = { id: "s", evaluate: () => ({ outcome: "allow" }) };
    expect(
      createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: selfSelect }] }).requestPhaseActive,
    ).toBe(true);
  });

  it("a tool_call-only rib policy does not activate the request phase", () => {
    const toolOnly: Policy = {
      id: "t",
      on: [{ phase: "tool_call" }],
      evaluate: () => ({ outcome: "allow" }),
    };
    expect(
      createPolicyEngine({ ribPolicies: [{ ribId: "r", policy: toolOnly }] }).requestPhaseActive,
    ).toBe(false);
  });
});

describe("createPolicyEngine — turn_budget builtin", () => {
  const expensive = { costTier: "high" as const };

  it("allows a turn under the ceiling regardless of model", async () => {
    const engine = createPolicyEngine({ turnBudget: 5 });
    const d = await engine.evaluateRequest({
      surface: "chat",
      model: expensive,
      usage: { totalTokens: 9_999, turns: 4 },
    });
    expect(d).toEqual({ outcome: "allow" });
  });

  it("denies at the ceiling on an expensive model, naming the downgrade", async () => {
    const engine = createPolicyEngine({ turnBudget: 5 });
    const d = await engine.evaluateRequest({
      surface: "chat",
      model: expensive,
      usage: { totalTokens: 0, turns: 5 },
    });
    expect(d.outcome).toBe("deny");
    expect((d as { reason: string }).reason).toContain("turn budget of 5");
    expect((d as { reason: string }).reason).toContain("cheaper model");
  });

  it("allows at the ceiling on a cheap model (the downgrade target)", async () => {
    const engine = createPolicyEngine({ turnBudget: 5 });
    for (const model of [{ costTier: "low" as const }, { billing: "subscription" as const }]) {
      const d = await engine.evaluateRequest({
        surface: "chat",
        model,
        usage: { totalTokens: 0, turns: 12 },
      });
      expect(d).toEqual({ outcome: "allow" });
    }
  });

  it("denies at the ceiling on a metered (real-money) model even at a low tier", async () => {
    const engine = createPolicyEngine({ turnBudget: 5 });
    const d = await engine.evaluateRequest({
      surface: "chat",
      model: { costTier: "low", billing: "metered" },
      usage: { totalTokens: 0, turns: 5 },
    });
    expect(d.outcome).toBe("deny");
  });

  it("fails closed at the ceiling when the model is unknown (deny)", async () => {
    const engine = createPolicyEngine({ turnBudget: 5 });
    const d = await engine.evaluateRequest({
      surface: "chat",
      usage: { totalTokens: 0, turns: 5 },
    });
    expect(d.outcome).toBe("deny");
  });

  it("treats absent usage as zero turns (allow)", async () => {
    const engine = createPolicyEngine({ turnBudget: 1 });
    expect(await engine.evaluateRequest({ surface: "chat", model: expensive })).toEqual({
      outcome: "allow",
    });
  });

  it("a zero or negative budget leaves the builtin off (no request gate)", () => {
    expect(createPolicyEngine({ turnBudget: 0 }).requestPhaseActive).toBe(false);
    expect(createPolicyEngine({ turnBudget: -3 }).requestPhaseActive).toBe(false);
  });
});

describe("createPolicyEngine — cost_budget builtin", () => {
  const expensive = { costTier: "high" as const };

  it("allows under the token ceiling and denies at it on an expensive model", async () => {
    const engine = createPolicyEngine({ costBudget: 100_000 });
    expect(
      await engine.evaluateRequest({
        surface: "chat",
        model: expensive,
        usage: { totalTokens: 99_999, turns: 0 },
      }),
    ).toEqual({ outcome: "allow" });
    const d = await engine.evaluateRequest({
      surface: "chat",
      model: expensive,
      usage: { totalTokens: 100_000, turns: 0 },
    });
    expect(d.outcome).toBe("deny");
    expect((d as { reason: string }).reason).toContain("token budget of 100000");
  });

  it("allows at the token ceiling on a cheap model", async () => {
    const engine = createPolicyEngine({ costBudget: 100_000 });
    expect(
      await engine.evaluateRequest({
        surface: "chat",
        model: { costTier: "free" },
        usage: { totalTokens: 500_000, turns: 0 },
      }),
    ).toEqual({ outcome: "allow" });
  });

  it("both budgets together: turn ceiling denies even when tokens are under budget", async () => {
    const engine = createPolicyEngine({ turnBudget: 3, costBudget: 1_000_000 });
    const d = await engine.evaluateRequest({
      surface: "chat",
      model: expensive,
      usage: { totalTokens: 10, turns: 3 },
    });
    expect(d.outcome).toBe("deny");
    expect((d as { reason: string }).reason).toContain("turn budget");
  });
});

describe("createPolicyEngine — evaluateRequest seam", () => {
  it("allows by default when no request-phase policy is configured", async () => {
    const engine = createPolicyEngine();
    expect(await engine.evaluateRequest({ surface: "chat" })).toEqual({ outcome: "allow" });
  });

  it("surfaces surface/provider/model/usage on the policy context", async () => {
    let seen: Record<string, unknown> | undefined;
    const recorder: Policy = {
      id: "recorder",
      on: [{ phase: "request" }],
      evaluate: (_e, ctx) => {
        seen = {
          surface: ctx.surface,
          provider: ctx.provider,
          model: ctx.model,
          usage: ctx.usage,
        };
        return { outcome: "allow" };
      },
    };
    const engine = createPolicyEngine({ ribPolicies: [{ ribId: "chamber", policy: recorder }] });
    await engine.evaluateRequest({
      surface: "rib",
      ribId: "chamber",
      provider: "claude",
      model: { costTier: "high" },
      usage: { totalTokens: 42, turns: 2 },
    });
    expect(seen).toEqual({
      surface: "rib",
      provider: "claude",
      model: { costTier: "high" },
      usage: { totalTokens: 42, turns: 2 },
    });
  });

  it("a request-phase rib ASK rides the approval round-trip (accept → allow)", async () => {
    const ask: Policy = {
      id: "confirm",
      on: [{ phase: "request" }],
      evaluate: () => ({ outcome: "ask", reason: "confirm this turn" }),
    };
    const engine = createPolicyEngine({
      ribPolicies: [{ ribId: "r", policy: ask }],
      requestApproval: async () => "accept",
    });
    expect(await engine.evaluateRequest({ surface: "rib", ribId: "r" })).toEqual({
      outcome: "allow",
    });
  });
});
