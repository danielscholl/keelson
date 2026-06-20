// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Integration: the real ApprovalRegistry wired into the real PolicyEngine as its
// approval channel — the exact composition the server's index.ts builds. Proves
// an `ask` pauses the per-call gate, surfaces in list() (what the snapshot
// publishes), and resolves to allow/deny — end to end, no HTTP or provider.

import { describe, expect, it } from "bun:test";
import { type ApprovalRegistry, createApprovalRegistry } from "./approval-registry.ts";
import { createPolicyEngine } from "./policy-engine.ts";

const chat = { surface: "chat" as const };

// evaluateToolCall is async: the engine reaches requestApproval (which opens the
// pause) only after its microtask chain drains. Poll until the pause surfaces.
async function waitForPending(registry: ApprovalRegistry, n = 1): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (registry.list().length >= n) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${n} pending approval(s)`);
}

describe("ASK round-trip: engine + registry", () => {
  it("pauses a shell tool call, surfaces it, and allows on accept", async () => {
    let recomposes = 0;
    const registry = createApprovalRegistry({ timeoutMs: 0, onChange: () => recomposes++ });
    const engine = createPolicyEngine({ askOnShell: true, requestApproval: registry.request });

    // The per-call gate pauses — don't await yet.
    const gate = engine.evaluateToolCall({ tool: "Bash", args: { cmd: "ls" } }, chat);
    await waitForPending(registry);

    // The pause is now visible to the snapshot composer (registry.list()).
    const open = registry.list();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      surface: "chat",
      policyId: "builtin:ask_on_shell",
      tool: "Bash",
    });
    // No tool args leak into the published view.
    expect(open[0]).not.toHaveProperty("args");
    expect(recomposes).toBe(1); // opened

    // A human accepts → the gate resolves allow and the pause clears.
    expect(registry.resolve(open[0]!.id, "accept")).toBe(true);
    expect(await gate).toEqual({ outcome: "allow" });
    expect(registry.list()).toEqual([]);
    expect(recomposes).toBe(2); // settled
  });

  it("denies the call when the human rejects", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const engine = createPolicyEngine({ askOnShell: true, requestApproval: registry.request });

    const gate = engine.evaluateToolCall({ tool: "Write" }, chat);
    await waitForPending(registry);
    const id = registry.list()[0]!.id;
    registry.resolve(id, "reject");

    const decision = await gate;
    expect(decision.outcome).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("approval rejected");
  });

  it("denies when the turn aborts mid-pause (no leaked pending approval)", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const engine = createPolicyEngine({ askOnShell: true, requestApproval: registry.request });
    const ac = new AbortController();

    const gate = engine.evaluateToolCall({ tool: "Bash" }, { ...chat, signal: ac.signal });
    await waitForPending(registry);
    expect(registry.list()).toHaveLength(1);
    ac.abort();

    expect((await gate).outcome).toBe("deny");
    expect(registry.list()).toEqual([]);
  });

  it("clear() (server shutdown) denies an in-flight pause", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const engine = createPolicyEngine({ askOnShell: true, requestApproval: registry.request });

    const gate = engine.evaluateToolCall({ tool: "Bash" }, chat);
    await waitForPending(registry);
    expect(registry.list()).toHaveLength(1);
    registry.clear();
    expect((await gate).outcome).toBe("deny");
  });
});
