// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, describe, expect, it } from "bun:test";
import type { IAgentProvider, SendQueryOptions } from "@keelson/providers";
import type { MessageChunk, Rib, RibContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import type { PolicyEngine } from "./policy-engine.ts";
import { createPolicyEngine } from "./policy-engine.ts";
import { type MakeRibAgentTurnDeps, makeRibAgentTurn } from "./rib-agent-turn.ts";
import { applyRibs } from "./ribs.ts";
import type { UsageStore } from "./usage-store.ts";

// A minimal registered tool def for tool-projection tests — only the fields the
// seam reads (name) matter; the schema/execute satisfy the contract shape.
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}),
    async execute() {},
  };
}

interface QueryCall {
  prompt: string;
  cwd: string;
  resume: string | undefined;
  options: SendQueryOptions | undefined;
}

// A fake IAgentProvider that records its sendQuery call and yields scripted
// chunks (or throws). Honors the abort signal between chunks so the mid-flight
// abort test can short-circuit a partial stream.
function fakeProvider(
  opts: {
    chunks?: MessageChunk[];
    throws?: unknown;
    duringStream?: () => void;
    onQuery?: (call: QueryCall) => void;
  } = {},
): IAgentProvider {
  return {
    getType: () => "fake",
    getCapabilities: () => ({}) as never,
    listModels: async () => [],
    async *sendQuery(prompt, cwd, resume, options) {
      opts.onQuery?.({ prompt, cwd, resume, options });
      if (opts.throws) throw opts.throws;
      const chunks = opts.chunks ?? [
        { type: "text", content: "hello" } as MessageChunk,
        { type: "done" } as MessageChunk,
      ];
      let i = 0;
      for (const c of chunks) {
        if (i === 1) opts.duringStream?.();
        i += 1;
        yield c;
      }
    },
  };
}

// Build a run() with injected registry deps so no real provider CLI is shelled.
function makeRun(
  provider: IAgentProvider,
  deps: Partial<MakeRibAgentTurnDeps> & {
    ids?: string[];
    byId?: Record<string, IAgentProvider>;
  } = {},
) {
  const ids = deps.ids ?? ["claude"];
  return makeRibAgentTurn({
    getProvider:
      deps.getProvider ?? (deps.byId ? (id) => deps.byId![id] ?? provider : () => provider),
    isRegisteredProvider: deps.isRegisteredProvider ?? ((id) => ids.includes(id)),
    listProviderIds: deps.listProviderIds ?? (() => ids),
    defaultCwd: deps.defaultCwd ?? "/neutral",
    // Default to an empty catalog so tool-rail tests are isolated from whatever
    // the global @keelson/skills registry happens to hold; tool-projection tests
    // inject their own.
    getRegisteredTools: deps.getRegisteredTools ?? (() => []),
    ...(deps.denylist !== undefined ? { denylist: deps.denylist } : {}),
    ...(deps.getToolOwner !== undefined ? { getToolOwner: deps.getToolOwner } : {}),
    ...(deps.isTurnToolGranted !== undefined ? { isTurnToolGranted: deps.isTurnToolGranted } : {}),
    ...(deps.getPolicyEngine !== undefined ? { getPolicyEngine: deps.getPolicyEngine } : {}),
    ...(deps.getUsageStore !== undefined ? { getUsageStore: deps.getUsageStore } : {}),
  });
}

async function drain(stream: AsyncIterable<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("makeRibAgentTurn — provider routing", () => {
  const savedEnv = process.env.KEELSON_WORKFLOW_PROVIDER;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.KEELSON_WORKFLOW_PROVIDER;
    else process.env.KEELSON_WORKFLOW_PROVIDER = savedEnv;
  });

  it("maps a successful provider stream to an ok result + derived stream", async () => {
    const run = makeRun(fakeProvider());
    const turn = run("chamber", { prompt: "say hi" });
    expect(await turn.result).toEqual({ status: "ok", text: "hello", providerId: "claude" });
    expect(await drain(turn.stream)).toEqual([
      { type: "text", content: "hello" },
      { type: "done" },
    ]);
  });

  it("routes through the req.provider hint and stamps providerId from it", async () => {
    let queriedId = "";
    const claude = fakeProvider({ onQuery: () => (queriedId = "claude") });
    const copilot = fakeProvider({ onQuery: () => (queriedId = "copilot") });
    const run = makeRun(claude, {
      ids: ["claude", "copilot"],
      byId: { claude, copilot },
    });
    const result = await run("chamber", { prompt: "hi", provider: "copilot" }).result;
    expect(result.providerId).toBe("copilot");
    expect(queriedId).toBe("copilot");
  });

  it("honors KEELSON_WORKFLOW_PROVIDER when no req.provider hint is given", async () => {
    process.env.KEELSON_WORKFLOW_PROVIDER = "copilot";
    const run = makeRun(fakeProvider(), { ids: ["claude", "copilot"] });
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.providerId).toBe("copilot");
  });

  it("defaults to the first non-stub provider when nothing is pinned", async () => {
    delete process.env.KEELSON_WORKFLOW_PROVIDER;
    const run = makeRun(fakeProvider(), { ids: ["stub", "claude"] });
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.providerId).toBe("claude");
  });

  it("fails loudly when a named provider is not registered", async () => {
    const run = makeRun(fakeProvider(), { ids: ["claude"] });
    const result = await run("chamber", { prompt: "hi", provider: "nope" }).result;
    expect(result.status).toBe("error");
    expect(result.error).toContain("not registered");
  });
});

describe("makeRibAgentTurn — seam invariants", () => {
  it("rejects an empty prompt with a clear seam error, never touching a provider (#115)", async () => {
    let called = false;
    const run = makeRun(fakeProvider({ onQuery: () => (called = true) }));
    const result = await run("chamber", { prompt: "   " }).result;
    expect(result.status).toBe("error");
    expect(result.error).toBe("prompt must be non-empty");
    expect(called).toBe(false);
  });

  it("defaults cwd to the neutral dir, not the host repo, when none is given (#114)", async () => {
    let seenCwd = "";
    const run = makeRun(fakeProvider({ onQuery: (c) => (seenCwd = c.cwd) }), {
      defaultCwd: "/neutral",
    });
    await run("chamber", { prompt: "hi" }).result;
    expect(seenCwd).toBe("/neutral");
    expect(seenCwd).not.toBe(process.cwd());
  });

  it("uses an explicit cwd when the rib pins one", async () => {
    let seenCwd = "";
    const run = makeRun(fakeProvider({ onQuery: (c) => (seenCwd = c.cwd) }));
    await run("chamber", { prompt: "hi", cwd: "/work/room" }).result;
    expect(seenCwd).toBe("/work/room");
  });

  it("forwards system/model/resume to the provider", async () => {
    let seen: QueryCall | undefined;
    const run = makeRun(fakeProvider({ onQuery: (c) => (seen = c) }));
    await run("chamber", {
      prompt: "do x",
      system: "be terse",
      model: "opus",
      resumeSessionId: "s0",
    }).result;
    expect(seen?.prompt).toBe("do x");
    expect(seen?.resume).toBe("s0");
    expect(seen?.options?.systemPrompt).toBe("be terse");
    expect(seen?.options?.model).toBe("opus");
  });

  it("short-circuits an already-aborted turn without querying the provider", async () => {
    let called = false;
    const run = makeRun(fakeProvider({ onQuery: () => (called = true) }));
    const ac = new AbortController();
    ac.abort();
    const result = await run("chamber", { prompt: "hi", abortSignal: ac.signal }).result;
    expect(result.status).toBe("aborted");
    expect(called).toBe(false);
  });

  it("reports aborted with partial text when the signal fires mid-stream", async () => {
    const ac = new AbortController();
    const provider = fakeProvider({
      chunks: [
        { type: "text", content: "partial" },
        { type: "text", content: "ignored" },
        { type: "done" },
      ],
      duringStream: () => ac.abort(),
    });
    const run = makeRun(provider);
    const result = await run("chamber", { prompt: "hi", abortSignal: ac.signal }).result;
    expect(result.status).toBe("aborted");
    expect(result.text).toBe("partial");
  });

  it("maps a provider error chunk to an error result + error chunk", async () => {
    const run = makeRun(
      fakeProvider({ chunks: [{ type: "error", message: "boom" }, { type: "done" }] }),
    );
    const turn = run("chamber", { prompt: "hi" });
    const result = await turn.result;
    expect(result.status).toBe("error");
    expect(result.error).toBe("boom");
    expect(await drain(turn.stream)).toEqual([
      { type: "error", message: "boom" },
      { type: "done" },
    ]);
  });

  it("maps a provider throw to an error result", async () => {
    const run = makeRun(fakeProvider({ throws: new Error("provider exploded") }));
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.status).toBe("error");
    expect(result.error).toBe("provider exploded");
  });

  it("classifies a timeout from req.timeoutMs distinctly", async () => {
    const provider: IAgentProvider = {
      getType: () => "fake",
      getCapabilities: () => ({}) as never,
      listModels: async () => [],
      async *sendQuery(_p, _c, _r, options) {
        await new Promise<void>((resolve) => {
          if (options?.abortSignal?.aborted) return resolve();
          options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done" } as MessageChunk;
      },
    };
    const run = makeRun(provider);
    const result = await run("chamber", { prompt: "hi", timeoutMs: 10 }).result;
    expect(result.status).toBe("timeout");
  });
});

describe("makeRibAgentTurn — tool rails", () => {
  async function optionsFor(
    req: Parameters<ReturnType<typeof makeRibAgentTurn>>[1],
    deps: Partial<MakeRibAgentTurnDeps> = {},
  ) {
    let seen: SendQueryOptions | undefined;
    const run = makeRun(fakeProvider({ onQuery: (c) => (seen = c.options) }), deps);
    await run("chamber", req).result;
    return seen;
  }

  it("locks a no-tool turn down with an empty allow-list (the room default)", async () => {
    const opts = await optionsFor({ prompt: "hi" });
    expect(opts?.allowedTools).toEqual([]);
    expect(opts?.disallowedTools).toBeUndefined();
  });

  it("treats an explicit empty allowedTools as text-only too", async () => {
    const opts = await optionsFor({ prompt: "hi", allowedTools: [] });
    expect(opts?.allowedTools).toEqual([]);
  });

  it("derives the allow-list from a requested tool set without projecting built-ins", async () => {
    const opts = await optionsFor({ prompt: "hi", tools: [{ name: "Read" }, { name: "Edit" }] });
    expect(opts?.allowedTools).toEqual(["Read", "Edit"]);
    // Read/Edit are SDK built-ins, not registered rib tools, so they resolve to
    // no def and stay allow-list-only — never projected as options.tools.
    expect(opts?.tools).toBeUndefined();
  });

  it("projects a requested REGISTERED rib tool so the model can call it", async () => {
    const lens = fakeTool("chamber_emit_lens");
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      { getRegisteredTools: () => [lens, fakeTool("chamber_emit_genesis")] },
    );
    // The full validated def is forwarded so the provider projects it as an MCP
    // tool; the allow-list (derived from the request) permits exactly it.
    expect(opts?.tools).toEqual([lens]);
    expect(opts?.allowedTools).toEqual(["chamber_emit_lens"]);
    // The provider needs the full catalog to tell registered MCP names from built-ins.
    expect(opts?.registeredMcpToolNames).toEqual(["chamber_emit_lens", "chamber_emit_genesis"]);
  });

  it("projects a self-owned requested registered tool", async () => {
    const lens = fakeTool("chamber_emit_lens");
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      {
        getRegisteredTools: () => [lens],
        getToolOwner: () => "chamber",
        isTurnToolGranted: () => false,
      },
    );
    expect(opts?.tools).toEqual([lens]);
    expect(opts?.registeredMcpToolNames).toEqual(["chamber_emit_lens"]);
  });

  it("drops an ungranted sibling-owned requested registered tool", async () => {
    const sibling = fakeTool("sibling_probe");
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "sibling_probe" }] },
      {
        getRegisteredTools: () => [sibling],
        getToolOwner: () => "sibling",
        isTurnToolGranted: () => false,
      },
    );
    expect(opts?.allowedTools).toEqual(["sibling_probe"]);
    expect(opts?.tools).toBeUndefined();
    expect(opts?.registeredMcpToolNames).toEqual(["sibling_probe"]);
  });

  it("projects a sibling-owned requested registered tool when granted", async () => {
    const sibling = fakeTool("sibling_probe");
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "sibling_probe" }] },
      {
        getRegisteredTools: () => [sibling],
        getToolOwner: () => "sibling",
        isTurnToolGranted: (caller, target, name) =>
          caller === "chamber" && target === "sibling" && name === "sibling_probe",
      },
    );
    expect(opts?.tools).toEqual([sibling]);
    expect(opts?.registeredMcpToolNames).toEqual(["sibling_probe"]);
  });

  it("keeps registered tool projection unchanged when no owner resolver is injected", async () => {
    const lens = fakeTool("chamber_emit_lens");
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      { getRegisteredTools: () => [lens] },
    );
    expect(opts?.tools).toEqual([lens]);
    expect(opts?.registeredMcpToolNames).toEqual(["chamber_emit_lens"]);
  });

  it("leaves a requested name that resolves to no registered def unprojected", async () => {
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      { getRegisteredTools: () => [] },
    );
    expect(opts?.allowedTools).toEqual(["chamber_emit_lens"]);
    expect(opts?.tools).toBeUndefined();
    expect(opts?.registeredMcpToolNames).toBeUndefined();
  });

  it("drops a denylisted tool from the projection but still forwards the catalog", async () => {
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      {
        getRegisteredTools: () => [fakeTool("chamber_emit_lens")],
        denylist: ["chamber_emit_lens"],
      },
    );
    // Still named in the allow-list, but never projected — so the model can't reach it.
    expect(opts?.allowedTools).toEqual(["chamber_emit_lens"]);
    expect(opts?.tools).toBeUndefined();
    // The catalog MUST still be forwarded even when nothing projected, so the
    // provider recognizes the still-allow-listed name as a (denied) registered
    // tool and doesn't mis-send it to the SDK built-in gate.
    expect(opts?.registeredMcpToolNames).toEqual(["chamber_emit_lens"]);
  });

  it("gates projected tools through the policy engine — a rib policy DENY drops the tool", async () => {
    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "chamber",
          policy: {
            id: "no-genesis",
            on: [{ phase: "tool_call" }],
            evaluate: (e) =>
              e.phase === "tool_call" && e.tool === "chamber_emit_genesis"
                ? { outcome: "deny", reason: "genesis is gated" }
                : { outcome: "allow" },
          },
        },
      ],
    });
    const lens = fakeTool("chamber_emit_lens");
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }, { name: "chamber_emit_genesis" }] },
      {
        getRegisteredTools: () => [lens, fakeTool("chamber_emit_genesis")],
        getPolicyEngine: () => engine,
      },
    );
    // Only the policy-allowed tool is projected; the denied one is dropped.
    expect(opts?.tools).toEqual([lens]);
    // The full catalog is still forwarded so the provider recognizes both names.
    expect(opts?.registeredMcpToolNames).toEqual(["chamber_emit_lens", "chamber_emit_genesis"]);
  });

  it("rides the rib id into the policy event", async () => {
    let seenRibId: string | undefined;
    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "chamber",
          policy: {
            id: "record-rib",
            on: [{ phase: "tool_call" }],
            evaluate: (e) => {
              if (e.phase === "tool_call") seenRibId = e.ribId;
              return { outcome: "allow" };
            },
          },
        },
      ],
    });
    await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      {
        getRegisteredTools: () => [fakeTool("chamber_emit_lens")],
        getPolicyEngine: () => engine,
      },
    );
    expect(seenRibId).toBe("chamber");
  });

  it("the engine's denylist builtin matches the no-engine denylist behavior (parity)", async () => {
    const engine = createPolicyEngine({ denylist: ["chamber_emit_lens"] });
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      {
        getRegisteredTools: () => [fakeTool("chamber_emit_lens")],
        getPolicyEngine: () => engine,
      },
    );
    // Same outcome as the local-denylist path: allow-listed but never projected.
    expect(opts?.allowedTools).toEqual(["chamber_emit_lens"]);
    expect(opts?.tools).toBeUndefined();
    expect(opts?.registeredMcpToolNames).toEqual(["chamber_emit_lens"]);
  });

  it("fails open to the denylist floor (not the whole turn) when the policy gate throws", async () => {
    // `gateCalled` proves the engine was actually consulted and its throw was
    // swallowed — without it, the survivor assertion would pass even if the gate
    // were never invoked. A denylist that WOULD drop the tool on the fallback
    // path proves the fallback (not the engine result) is what survived.
    let gateCalled = false;
    const throwingEngine = {
      projectTools: async () => {
        gateCalled = true;
        throw new Error("engine boom");
      },
    } as unknown as ReturnType<typeof createPolicyEngine>;
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }, { name: "chamber_emit_genesis" }] },
      {
        getRegisteredTools: () => [fakeTool("chamber_emit_lens"), fakeTool("chamber_emit_genesis")],
        getPolicyEngine: () => throwingEngine,
        // On the throw, toolOptions falls back to this local denylist floor.
        denylist: ["chamber_emit_genesis"],
      },
    );
    expect(gateCalled).toBe(true);
    // No throw escaped, and the fallback denylist floor applied (genesis dropped).
    expect(opts?.tools?.map((t) => t.name)).toEqual(["chamber_emit_lens"]);
  });

  it("wires a per-call gate scoped to the rib when the engine projects tools", async () => {
    let seenEvent: { ribId?: string; args?: unknown } | undefined;
    let seenSurface: string | undefined;
    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "chamber",
          policy: {
            id: "deny-secret-topic",
            on: [{ phase: "tool_call" }],
            evaluate: (e, ctx) => {
              if (e.phase !== "tool_call") return { outcome: "allow" };
              seenEvent = { ribId: e.ribId, args: e.args };
              seenSurface = ctx.surface;
              const topic = (e.args as { topic?: string } | undefined)?.topic;
              return topic === "secret"
                ? { outcome: "deny", reason: "secret topic blocked" }
                : { outcome: "allow" };
            },
          },
        },
      ],
    });
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      { getRegisteredTools: () => [fakeTool("chamber_emit_lens")], getPolicyEngine: () => engine },
    );
    const gate = opts?.evaluateToolCall;
    if (!gate) throw new Error("expected a per-call gate to be wired");
    // A safe call clears the gate ...
    expect(await gate({ tool: "chamber_emit_lens", args: { topic: "ok" } })).toEqual({
      outcome: "allow",
    });
    // ... a call whose args trip the rib policy is denied per-call, and the event
    // carried this rib's scope so the policy could make that args-aware decision.
    expect(await gate({ tool: "chamber_emit_lens", args: { topic: "secret" } })).toEqual({
      outcome: "deny",
      reason: "secret topic blocked",
    });
    expect(seenEvent).toEqual({ ribId: "chamber", args: { topic: "secret" } });
    expect(seenSurface).toBe("rib");
  });

  it("threads the turn's teardown signal into the per-call gate so a pending ASK cancels on abort", async () => {
    let capturedSignal: AbortSignal | undefined;
    // A recording engine that captures the `base` the seam hands evaluateToolCall.
    // The real round-trip (signal → cancel pending ASK → deny) is covered by
    // approval-roundtrip.test.ts; here we only prove the rib seam forwards it.
    const recordingEngine = {
      projectTools: async (candidates: readonly { name: string }[]) => ({
        allowed: [...candidates],
        denied: [],
      }),
      evaluateToolCall: async (_call: unknown, base: { signal?: AbortSignal }) => {
        capturedSignal = base.signal;
        return { outcome: "allow" as const };
      },
      evaluateRequest: async () => ({ outcome: "allow" as const }),
      requestPhaseActive: false,
    } as unknown as ReturnType<typeof createPolicyEngine>;
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      {
        getRegisteredTools: () => [fakeTool("chamber_emit_lens")],
        getPolicyEngine: () => recordingEngine,
      },
    );
    const gate = opts?.evaluateToolCall;
    if (!gate) throw new Error("expected a per-call gate to be wired");
    await gate({ tool: "chamber_emit_lens" });
    // The gate carries the SAME signal the provider stream rides (caller abort +
    // timeout), so the engine can cancel a pending approval when the turn tears down.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal).toBe(opts?.abortSignal);
  });

  it("forwards cwd and allowedDirectories to the provider and per-call gate", async () => {
    let capturedBase: { cwd?: string; allowedDirectories?: readonly string[] } | undefined;
    const recordingEngine: PolicyEngine = {
      async projectTools<T extends { name: string }>(candidates: readonly T[]) {
        return { allowed: [...candidates], denied: [] };
      },
      async evaluateToolCall(_call, base) {
        capturedBase = {
          ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
          ...(base.allowedDirectories !== undefined
            ? { allowedDirectories: [...base.allowedDirectories] }
            : {}),
        };
        return { outcome: "allow" };
      },
      async evaluateRequest() {
        return { outcome: "allow" };
      },
      async evaluateToolResult() {
        return { outcome: "allow" };
      },
      async evaluateResponse() {
        return { outcome: "allow" };
      },
      requestPhaseActive: false,
      resultPhaseActive: false,
      responsePhaseActive: false,
    };
    const opts = await optionsFor(
      {
        prompt: "hi",
        allowedTools: ["Bash"],
        cwd: "/workspace/room",
        allowedDirectories: ["/workspace/room"],
      },
      { getPolicyEngine: () => recordingEngine },
    );
    expect(opts?.allowedDirectories).toEqual(["/workspace/room"]);
    const gate = opts?.evaluateToolCall;
    if (!gate) throw new Error("expected a per-call gate to be wired");
    await gate({ tool: "Bash", args: { command: "cat /etc/passwd" } });
    expect(capturedBase).toEqual({
      cwd: "/workspace/room",
      allowedDirectories: ["/workspace/room"],
    });
  });

  it("wires no per-call gate for a text-only turn (no keelson tools to govern)", async () => {
    const engine = createPolicyEngine();
    const opts = await optionsFor({ prompt: "hi" }, { getPolicyEngine: () => engine });
    expect(opts?.tools).toBeUndefined();
    expect(opts?.evaluateToolCall).toBeUndefined();
  });

  it("wires no per-call gate when no policy engine is present", async () => {
    const opts = await optionsFor(
      { prompt: "hi", tools: [{ name: "chamber_emit_lens" }] },
      { getRegisteredTools: () => [fakeTool("chamber_emit_lens")] },
    );
    // The tool still projects via the local denylist floor — but with no engine
    // there is no per-call policy to run, so the gate stays off.
    expect(opts?.tools?.map((t) => t.name)).toEqual(["chamber_emit_lens"]);
    expect(opts?.evaluateToolCall).toBeUndefined();
  });

  it("wires the per-call gate for a built-in-allowed turn so the claude hook can gate Bash/Edit", async () => {
    const engine = createPolicyEngine();
    const opts = await optionsFor(
      { prompt: "hi", allowedTools: ["Bash", "Edit"] },
      { getPolicyEngine: () => engine },
    );
    // No keelson tools requested, but built-ins can run — the claude provider's
    // PreToolUse hook routes Bash/Edit/Write through this gate, so it must be wired.
    expect(opts?.tools).toBeUndefined();
    expect(opts?.evaluateToolCall).toBeDefined();
  });

  it("passes an explicit allow-list through verbatim", async () => {
    const opts = await optionsFor({ prompt: "hi", allowedTools: ["Bash(git:*)", "Read"] });
    expect(opts?.allowedTools).toEqual(["Bash(git:*)", "Read"]);
  });

  it("treats a deny-only request as a deny rail, leaving the rest available", async () => {
    const opts = await optionsFor({ prompt: "hi", disallowedTools: ["Bash", "Edit"] });
    expect(opts?.allowedTools).toBeUndefined();
    expect(opts?.disallowedTools).toEqual(["Bash", "Edit"]);
  });

  it("treats an empty deny list like no deny rail (rest available, not text-only)", async () => {
    const opts = await optionsFor({ prompt: "hi", disallowedTools: [] });
    expect(opts?.allowedTools).toBeUndefined();
    expect(opts?.disallowedTools).toEqual([]);
  });
});

describe("makeRibAgentTurn — response-phase redaction", () => {
  // The room default is a text-only turn (no tool rails); its prose still flows
  // through the response gate, so a secret the model echoes is scrubbed before
  // the result text a rib persists/broadcasts is returned — the same
  // KEELSON_REDACT_PATTERN scrub the workflow prompt surface runs.
  function provText(text: string): IAgentProvider {
    return fakeProvider({
      chunks: [{ type: "text", content: text }, { type: "done" }],
    });
  }

  it("redacts a secret in the turn's prose when the redact builtin is active", async () => {
    const engine = createPolicyEngine({ redactPattern: "SECRET-[A-Z0-9]+" });
    const run = makeRun(provText("here is the key SECRET-ABC123 keep it safe"), {
      getPolicyEngine: () => engine,
    });
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.status).toBe("ok");
    expect(result.text).toBe("here is the key [REDACTED] keep it safe");
  });

  it("leaves prose untouched when no redact pattern is configured", async () => {
    const engine = createPolicyEngine();
    const run = makeRun(provText("SECRET-ABC123"), { getPolicyEngine: () => engine });
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.text).toBe("SECRET-ABC123");
  });

  it("a response-phase deny fails the turn and drops the forbidden text", async () => {
    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "chamber",
          policy: {
            id: "block-leaks",
            on: [{ phase: "response" }],
            evaluate: (e) =>
              e.phase === "response" && e.text.includes("SECRET")
                ? { outcome: "deny", reason: "leak blocked" }
                : { outcome: "allow" },
          },
        },
      ],
    });
    const run = makeRun(provText("SECRET payload"), { getPolicyEngine: () => engine });
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.status).toBe("error");
    expect(result.text).toBe("");
    expect(result.error).toBe("leak blocked");
  });

  it("carries the rib id and rib surface into the response event", async () => {
    let seen: { ribId?: string; surface?: string } | undefined;
    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "chamber",
          policy: {
            id: "record",
            on: [{ phase: "response" }],
            evaluate: (e, ctx) => {
              if (e.phase === "response") seen = { ribId: ctx.ribId, surface: ctx.surface };
              return { outcome: "allow" };
            },
          },
        },
      ],
    });
    const run = makeRun(provText("hello"), { getPolicyEngine: () => engine });
    await run("chamber", { prompt: "hi" }).result;
    expect(seen).toEqual({ ribId: "chamber", surface: "rib" });
  });

  it("does not run the response gate on a provider error (no clean text)", async () => {
    let gateCalled = false;
    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "chamber",
          policy: {
            id: "record",
            on: [{ phase: "response" }],
            evaluate: () => {
              gateCalled = true;
              return { outcome: "allow" };
            },
          },
        },
      ],
    });
    const run = makeRun(
      fakeProvider({
        chunks: [{ type: "error", message: "boom" }, { type: "done" }],
      }),
      { getPolicyEngine: () => engine },
    );
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.status).toBe("error");
    expect(gateCalled).toBe(false);
  });
});

// A minimal in-memory UsageStore.record() spy — mirrors the shape of
// createUsageStore's UsageStore without touching bun:sqlite.
function fakeUsageStore() {
  const events: Parameters<UsageStore["record"]>[0][] = [];
  const store: UsageStore = {
    record: (input) => {
      events.push(input);
    },
    listEvents: () => [],
    totals: () => ({ events: 0, inputTokens: 0, outputTokens: 0 }),
    summary: () => ({
      totals: {
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      groups: [],
    }),
    series: () => [],
    breakdown: () => [],
    jobs: () => [],
    events: () => [],
    pulse: () => ({
      composedTotals: {
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      minuteSeries: [],
    }),
  };
  return { store, events };
}

describe("makeRibAgentTurn — usage capture", () => {
  it("captures the provider's usage chunk onto the settled result", async () => {
    const run = makeRun(
      fakeProvider({
        chunks: [
          { type: "text", content: "hi" },
          { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
          { type: "done" },
        ],
      }),
    );
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.status).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it("records a rib-sourced usage event with ribId/provider/model/status", async () => {
    const { store, events } = fakeUsageStore();
    const run = makeRun(
      fakeProvider({
        chunks: [
          { type: "text", content: "hi" },
          { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
          { type: "done" },
        ],
      }),
      { getUsageStore: () => store },
    );
    await run("chamber", { prompt: "hi", model: "claude-opus" }).result;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "rib",
      ribId: "chamber",
      provider: "claude",
      model: "claude-opus",
      status: "ok",
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it("falls back to 'unknown' model when the request names none", async () => {
    const { store, events } = fakeUsageStore();
    const run = makeRun(
      fakeProvider({
        chunks: [{ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }, { type: "done" }],
      }),
      { getUsageStore: () => store },
    );
    await run("chamber", { prompt: "hi" }).result;
    expect(events[0]?.model).toBe("unknown");
  });

  it("prefers the provider-reported model chunk over the requested model", async () => {
    const { store, events } = fakeUsageStore();
    const run = makeRun(
      fakeProvider({
        chunks: [
          { type: "model", model: "gpt-5.5" },
          { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
          { type: "done" },
        ],
      }),
      { getUsageStore: () => store },
    );
    await run("chamber", { prompt: "hi", model: "auto" }).result;
    expect(events[0]?.model).toBe("gpt-5.5");
  });

  it("ignores a blank model chunk and keeps the requested model", async () => {
    const { store, events } = fakeUsageStore();
    const run = makeRun(
      fakeProvider({
        chunks: [
          { type: "model", model: "   " },
          { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
          { type: "done" },
        ],
      }),
      { getUsageStore: () => store },
    );
    await run("chamber", { prompt: "hi", model: "claude-opus" }).result;
    expect(events[0]?.model).toBe("claude-opus");
  });

  it("does not record when the turn carries no usage chunk", async () => {
    const { store, events } = fakeUsageStore();
    const run = makeRun(fakeProvider(), { getUsageStore: () => store });
    await run("chamber", { prompt: "hi" }).result;
    expect(events).toHaveLength(0);
  });

  it("does not record a zero-total usage report", async () => {
    const { store, events } = fakeUsageStore();
    const run = makeRun(
      fakeProvider({
        chunks: [{ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } }, { type: "done" }],
      }),
      { getUsageStore: () => store },
    );
    await run("chamber", { prompt: "hi" }).result;
    expect(events).toHaveLength(0);
  });

  it("records with status 'error' when usage arrives before a mid-stream provider error", async () => {
    const { store, events } = fakeUsageStore();
    const run = makeRun(
      fakeProvider({
        chunks: [
          { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } },
          { type: "error", message: "boom" },
          { type: "done" },
        ],
      }),
      { getUsageStore: () => store },
    );
    const result = await run("chamber", { prompt: "hi" }).result;
    expect(result.status).toBe("error");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error", inputTokens: 2, outputTokens: 3 });
  });
});

describe("applyRibs wiring", () => {
  it("exposes runAgentTurn on the rib context, bound to the rib id", async () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return [];
      },
    };
    let seenRibId = "";
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
      runAgentTurn: (ribId) => {
        seenRibId = ribId;
        return {
          result: Promise.resolve({ status: "ok" as const, text: "" }),
          stream: (async function* () {
            yield { type: "done" as const };
          })(),
        };
      },
    });
    expect(captured?.runAgentTurn).toBeDefined();
    captured?.runAgentTurn?.({ prompt: "x" });
    expect(seenRibId).toBe("chamber");
  });

  it("omits runAgentTurn when none is supplied (fails closed for the rib)", () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return [];
      },
    };
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
    });
    expect(captured?.runAgentTurn).toBeUndefined();
  });

  it("exposes getDataDir on the rib context, resolving the rib's namespaced data dir", () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return [];
      },
    };
    let seenRibId = "";
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
      getRibDataDir: (ribId) => {
        seenRibId = ribId;
        return `/home/${ribId}`;
      },
    });
    expect(captured?.getDataDir?.()).toBe("/home/chamber");
    expect(seenRibId).toBe("chamber");
  });

  it("omits getDataDir when no resolver is supplied (fails closed for the rib)", () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return [];
      },
    };
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
    });
    // getExec is always present, so capture provably happened — getDataDir being
    // undefined is the real omission, not a never-ran registerTools.
    expect(captured?.getExec).toBeDefined();
    expect(captured?.getDataDir).toBeUndefined();
  });

  it("exposes refreshWorkflow on the rib context, bound to the rib id", async () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return [];
      },
    };
    let seenRibId = "";
    let seenName = "";
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
      refreshWorkflow: (ribId, workflowName) => {
        seenRibId = ribId;
        seenName = workflowName;
        return Promise.resolve();
      },
    });
    expect(captured?.refreshWorkflow).toBeDefined();
    await captured?.refreshWorkflow?.("chamber-roster");
    expect(seenRibId).toBe("chamber");
    expect(seenName).toBe("chamber-roster");
  });

  it("omits refreshWorkflow when no resolver is supplied (fails closed for an older harness)", () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return [];
      },
    };
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
    });
    // getExec is always present, so capture provably happened — refreshWorkflow
    // being undefined is the cadence-only degradation, not a never-ran register.
    expect(captured?.getExec).toBeDefined();
    expect(captured?.refreshWorkflow).toBeUndefined();
  });

  it("refreshWorkflow on the ctx propagates a rejecting resolver (fail-soft lives at the bootstrap layer)", async () => {
    let captured: RibContext | undefined;
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      registerTools: (ctx) => {
        captured = ctx;
        return [];
      },
    };
    applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: {
        getExec: () => ({
          runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
          runText: async () => ({ ok: true as const, data: "" }),
        }),
      },
      // The applyRibs layer is a thin id-binding wrapper and does NOT add a
      // try/catch — fail-soft is the bootstrap resolver's job (scheduler.test).
      refreshWorkflow: () => Promise.reject(new Error("boom")),
    });
    expect(captured?.refreshWorkflow).toBeDefined();
    await expect(captured?.refreshWorkflow?.("x")).rejects.toThrow("boom");
  });

  const fakeExecCtx = {
    getExec: () => ({
      runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
      runText: async () => ({ ok: true as const, data: "" }),
    }),
  };

  it("collects a rib's contributed policies, tagged with the rib id, and drops malformed ones", () => {
    const goodPolicy = {
      id: "no-genesis",
      evaluate: () => ({ outcome: "allow" as const }),
    };
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      // One valid policy + malformed ones that must all be skipped: no evaluate;
      // a non-array `on`; an empty `on` (silently-dead matcher); a non-string
      // `on[].tool` (silently mis-scopes). Rejecting them here keeps them off the
      // engine, where a bad `on` would throw and a dead matcher would never fire.
      contributePolicies: () =>
        [
          goodPolicy,
          { id: "broken" } as unknown as typeof goodPolicy,
          { id: "bad-on", on: "tool_call", evaluate: () => ({ outcome: "allow" as const }) },
          { id: "empty-on", on: [], evaluate: () => ({ outcome: "allow" as const }) },
          {
            id: "bad-tool",
            on: [{ phase: "tool_call", tool: 123 }],
            evaluate: () => ({ outcome: "allow" as const }),
          },
        ] as unknown as ReturnType<NonNullable<Rib["contributePolicies"]>>,
    };
    const result = applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: fakeExecCtx,
    });
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]?.ribId).toBe("chamber");
    expect(result.policies[0]?.policy.id).toBe("no-genesis");
  });

  it("ignores a contributePolicies that returns a non-array instead of throwing", () => {
    const rib: Rib = {
      id: "chamber",
      displayName: "Chamber",
      contributePolicies: () =>
        ({ id: "oops", evaluate: () => ({ outcome: "allow" }) }) as unknown as ReturnType<
          NonNullable<Rib["contributePolicies"]>
        >,
    };
    const result = applyRibs({
      active: ["chamber"],
      available: { chamber: rib },
      ctx: fakeExecCtx,
    });
    expect(result.policies).toEqual([]);
  });
});
