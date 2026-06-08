// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, describe, expect, it } from "bun:test";
import type { IAgentProvider, SendQueryOptions } from "@keelson/providers";
import type { MessageChunk, Rib, RibContext } from "@keelson/shared";
import { type MakeRibAgentTurnDeps, makeRibAgentTurn } from "./rib-agent-turn.ts";
import { applyRibs } from "./ribs.ts";

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
  async function optionsFor(req: Parameters<ReturnType<typeof makeRibAgentTurn>>[1]) {
    let seen: SendQueryOptions | undefined;
    const run = makeRun(fakeProvider({ onQuery: (c) => (seen = c.options) }));
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

  it("derives the allow-list from a requested tool set without forwarding it as projectable tools", async () => {
    const opts = await optionsFor({ prompt: "hi", tools: [{ name: "Read" }, { name: "Edit" }] });
    expect(opts?.allowedTools).toEqual(["Read", "Edit"]);
    // The loose `{ name }[]` is NOT forwarded as options.tools — a provider would
    // try to project it as MCP defs and crash on the missing inputSchema.
    expect(opts?.tools).toBeUndefined();
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
});
