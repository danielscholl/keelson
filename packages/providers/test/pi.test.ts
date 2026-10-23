// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, ModelInfo, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import { buildPiCatalog, costTierFromOutput, type PiModelLike } from "../src/pi/catalog.ts";
import { PiVendorSlots } from "../src/pi/concurrency.ts";
import type { PiRawEvent } from "../src/pi/event-bridge.ts";
import { mapPiEvent, mapPiFinishReason } from "../src/pi/event-bridge.ts";
import type { PiCreateSessionParams, PiSession, PiSessionFactory } from "../src/pi/factory.ts";
import { checkPiAuth } from "../src/pi/factory.ts";
import { createPiGateExtension, type PiGateExtensionApi } from "../src/pi/gate-extension.ts";
import { PI_CAPABILITIES, PiProvider, piCapabilities } from "../src/pi/provider.ts";
import { resolvePiExtensionPaths } from "../src/pi/registration.ts";
import { filterPiTools } from "../src/pi/tool-filter.ts";
import { projectToolsForPi } from "../src/pi/tool-projection.ts";

const textDelta = (delta: string): PiRawEvent => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});

describe("mapPiEvent", () => {
  test("text_delta → text chunk", () => {
    expect(mapPiEvent(textDelta("hi"))).toEqual([{ type: "text", content: "hi" }]);
  });

  test("empty text_delta is dropped", () => {
    expect(mapPiEvent(textDelta(""))).toEqual([]);
  });

  test("thinking_delta → thinking chunk", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
      }),
    ).toEqual([{ type: "thinking", content: "hmm" }]);
  });

  test("done → usage chunk from message.usage", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "done",
          message: { usage: { input: 12, output: 7, cacheRead: 3, cacheWrite: 0 } },
        },
      }),
    ).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
  });

  test("a cache key reported as 0 is forwarded as 0; an absent key is omitted", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "done",
          message: { usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
        },
      }),
    ).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "done", message: { usage: { input: 5, output: 2 } } },
      }),
    ).toEqual([{ type: "usage", usage: { inputTokens: 5, outputTokens: 2 } }]);
  });

  test("error → usage then error chunk", () => {
    const out = mapPiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        error: {
          errorMessage: "boom",
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    });
    expect(out).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 1,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      { type: "error", message: "boom" },
    ]);
  });

  test("done with an empty usage object emits no usage chunk (no fabricated zeros)", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "done", message: { usage: {} } },
      }),
    ).toEqual([]);
  });

  test("done sanitizes non-numeric usage fields", () => {
    expect(
      mapPiEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "done",
          message: { usage: { input: "12", output: 5, cacheRead: -3, cacheWrite: 0 } },
        },
      }),
    ).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 5, cacheCreationInputTokens: 0 } },
    ]);
  });

  test("error without message uses a fallback string", () => {
    const out = mapPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "error", error: {} },
    });
    expect(out).toEqual([{ type: "error", message: "pi turn ended with an error" }]);
  });

  test("agent_end whose final assistant message errored → error chunk (no silent dead turn)", () => {
    expect(
      mapPiEvent({
        type: "agent_end",
        willRetry: false,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "OpenAI API error (421): 421 Misdirected Request",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
    ).toEqual([{ type: "error", message: "OpenAI API error (421): 421 Misdirected Request" }]);
  });

  test("agent_end surfaces usage alongside the error when the failed turn spent tokens", () => {
    expect(
      mapPiEvent({
        type: "agent_end",
        willRetry: false,
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "rate limited",
            usage: { input: 30, output: 0 },
          },
        ],
      }),
    ).toEqual([
      { type: "usage", usage: { inputTokens: 30, outputTokens: 0 } },
      { type: "error", message: "rate limited" },
    ]);
  });

  test("agent_end mid-retry (willRetry) is not surfaced — pi will run the turn again", () => {
    expect(
      mapPiEvent({
        type: "agent_end",
        willRetry: true,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "transient" }],
      }),
    ).toEqual([]);
  });

  test("a successful agent_end (stopReason stop) maps to nothing", () => {
    expect(
      mapPiEvent({
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "stop", content: [] }],
      }),
    ).toEqual([]);
  });

  test("agent_end whose final message errored without a message uses the fallback string", () => {
    expect(
      mapPiEvent({
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "error" }],
      }),
    ).toEqual([{ type: "error", message: "pi turn ended with an error" }]);
  });

  test("tool_execution_start → tool_use chunk", () => {
    expect(
      mapPiEvent({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "read",
        args: { path: "a.ts" },
      }),
    ).toEqual([{ type: "tool_use", id: "t1", toolName: "read", toolInput: { path: "a.ts" } }]);
  });

  test("tool_execution_end → tool_result chunk, result stringified", () => {
    expect(
      mapPiEvent({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "read",
        result: { ok: true },
        isError: false,
      }),
    ).toEqual([{ type: "tool_result", toolUseId: "t1", content: '{"ok":true}' }]);
  });

  test("tool_execution_end marks errors", () => {
    const out = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: "nope",
      isError: true,
    });
    expect(out).toEqual([{ type: "tool_result", toolUseId: "t1", content: "nope", isError: true }]);
  });

  test("tool_execution_end extracts text from an AgentToolResult-shaped result", () => {
    const out = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "workflow_run",
      result: {
        content: [
          { type: "text", text: "run started" },
          { type: "image", data: "…" },
          { type: "text", text: "runId: r-1" },
        ],
        details: undefined,
      },
      isError: false,
    });
    expect(out).toEqual([
      { type: "tool_result", toolUseId: "t1", content: "run started\nrunId: r-1" },
    ]);
  });

  test("tool_execution_end with a text-free content array falls back to stringify", () => {
    const out = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "render",
      result: { content: [{ type: "image", data: "abc" }] },
      isError: false,
    });
    expect(out).toEqual([
      {
        type: "tool_result",
        toolUseId: "t1",
        content: '{"content":[{"type":"image","data":"abc"}]}',
      },
    ]);
  });

  test("tool events without a toolCallId are skipped (unpairable)", () => {
    expect(mapPiEvent({ type: "tool_execution_start", toolName: "read", args: {} })).toEqual([]);
    expect(
      mapPiEvent({ type: "tool_execution_end", toolName: "read", result: "x", isError: false }),
    ).toEqual([]);
    expect(
      mapPiEvent({ type: "tool_execution_start", toolCallId: "", toolName: "read", args: {} }),
    ).toEqual([]);
  });

  test("unknown / ignored events map to nothing", () => {
    expect(mapPiEvent({ type: "turn_start" })).toEqual([]);
    expect(mapPiEvent({ type: "agent_end" })).toEqual([]);
    expect(
      mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
    ).toEqual([]);
  });
});

// Fake factory: prompt() replays a scripted event sequence to the subscriber,
// then resolves — exercising the provider's queue/lifecycle with no SDK.
function fakeFactory(
  events: PiRawEvent[],
  opts: {
    throwOnCreate?: Error;
    throwOnPrompt?: Error;
    capture?: (p: PiCreateSessionParams) => void;
    capturePrompt?: (text: string) => void;
    modelRef?: string;
  } = {},
): PiSessionFactory {
  return {
    async createSession(params): Promise<PiSession> {
      opts.capture?.(params);
      if (opts.throwOnCreate) throw opts.throwOnCreate;
      let listener: ((e: PiRawEvent) => void) | null = null;
      return {
        subscribe(l) {
          listener = l;
          return () => {
            listener = null;
          };
        },
        async prompt(text) {
          opts.capturePrompt?.(text);
          if (opts.throwOnPrompt) throw opts.throwOnPrompt;
          for (const e of events) listener?.(e);
        },
        ...(opts.modelRef !== undefined ? { modelRef: opts.modelRef } : {}),
      };
    },
  };
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("PiProvider", () => {
  test("getType / capabilities", () => {
    const p = new PiProvider({ factory: fakeFactory([]) });
    expect(p.getType()).toBe("pi");
    expect(p.getCapabilities()).toEqual(PI_CAPABILITIES);
    expect(PI_CAPABILITIES.tools).toBe(true);
    expect(PI_CAPABILITIES.sessionResume).toBe(false);
    expect(PI_CAPABILITIES.modelClasses).toEqual({
      fast: "anthropic/claude-haiku-5-5",
      balanced: "anthropic/claude-sonnet-5-5",
      deep: "anthropic/claude-opus-5-5",
    });
  });

  test("listModels returns the dynamic catalog from the injected source", async () => {
    const dynamic: ModelInfo[] = [
      { id: "anthropic/claude-opus-4.5", displayName: "Claude Opus 4.5", billing: "metered" },
      { id: "github-copilot/gpt-5.5", displayName: "GPT-5.5", billing: "subscription" },
    ];
    const models = await new PiProvider({
      factory: fakeFactory([]),
      catalogSource: async () => dynamic,
    }).listModels();
    expect(models).toEqual(dynamic);
  });

  test("listModels falls back to the curated baseline when the source throws", async () => {
    const models = await new PiProvider({
      factory: fakeFactory([]),
      catalogSource: async () => {
        throw new Error("pi not installed");
      },
    }).listModels();
    expect(models.map((m) => m.id)).toEqual(PI_CAPABILITIES.models);
  });

  test("listModelsLive preserves an unavailable source as null", async () => {
    const models = await new PiProvider({
      factory: fakeFactory([]),
      catalogSource: async () => {
        throw new Error("pi not installed");
      },
    }).listModelsLive();
    expect(models).toBeNull();
  });

  test("listModels falls back to the curated baseline when the source is empty", async () => {
    const models = await new PiProvider({
      factory: fakeFactory([]),
      catalogSource: async () => [],
    }).listModels();
    expect(models.map((m) => m.id)).toEqual(PI_CAPABILITIES.models);
  });

  test("streams text deltas then a usage chunk; stream ends when prompt() resolves", async () => {
    const provider = new PiProvider({
      factory: fakeFactory([
        textDelta("Hello"),
        textDelta(" world"),
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "done",
            message: { usage: { input: 4, output: 2 } },
          },
        },
        // agent_end no longer closes the queue (pi's session agent_end carries
        // willRetry); it must be a harmless no-op here.
        { type: "agent_end", willRetry: false },
      ]),
    });
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toEqual([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
      { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    ]);
  });

  test("an agent_end with willRetry does not truncate the retried output", async () => {
    const provider = new PiProvider({
      factory: fakeFactory([
        textDelta("partial"),
        { type: "agent_end", willRetry: true },
        textDelta(" retried answer"),
        { type: "agent_end", willRetry: false },
      ]),
    });
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    // Both deltas survive — an early close on the first agent_end would drop the
    // second.
    expect(chunks).toEqual([
      { type: "text", content: "partial" },
      { type: "text", content: " retried answer" },
    ]);
  });

  test("passes the model and prepends systemPrompt to the user text", async () => {
    let promptedModel: string | undefined;
    let promptedText = "";
    const factory = fakeFactory([{ type: "agent_end" }], {
      capture: (p) => {
        promptedModel = p.model;
      },
      capturePrompt: (t) => {
        promptedText = t;
      },
    });
    const provider = new PiProvider({ factory });
    await collect(
      provider.sendQuery("question", "/tmp", undefined, {
        model: "google/gemini-3.1-pro-preview",
        systemPrompt: "you are helpful",
      }),
    );
    expect(promptedModel).toBe("google/gemini-3.1-pro-preview");
    expect(promptedText).toBe("you are helpful\n\nquestion");
  });

  test("emits the session-resolved model before the stream", async () => {
    const provider = new PiProvider({
      factory: fakeFactory([textDelta("hi")], { modelRef: "openai/gpt-5.2" }),
    });
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toEqual([
      { type: "model", model: "openai/gpt-5.2" },
      { type: "text", content: "hi" },
    ]);
  });

  test("warns when the requested model fell back to a different one", async () => {
    const provider = new PiProvider({
      factory: fakeFactory([textDelta("hi")], { modelRef: "github-copilot/gpt-5.5" }),
    });
    const chunks = await collect(
      provider.sendQuery("hi", "/tmp", undefined, { model: "rec/flint" }),
    );
    expect(chunks[0]).toEqual({ type: "model", model: "github-copilot/gpt-5.5" });
    expect(chunks[1]?.type).toBe("system");
    expect((chunks[1] as { content: string }).content).toContain('"rec/flint"');
  });

  test("no fallback warning when the requested model resolved", async () => {
    const provider = new PiProvider({
      factory: fakeFactory([textDelta("hi")], { modelRef: "rec/flint" }),
    });
    const chunks = await collect(
      provider.sendQuery("hi", "/tmp", undefined, { model: "rec/flint" }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["model", "text"]);
  });

  test("projects options.tools into the session's customTools", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
    });
    const tool: ToolDefinition = {
      name: "workflow_run",
      description: "Run a workflow",
      inputSchema: z.object({ name: z.string() }),
      execute: async () => {},
    };
    await collect(provider.sendQuery("hi", "/tmp", undefined, { tools: [tool] }));
    expect(captured?.customTools?.map((t) => t.name)).toEqual(["workflow_run"]);
    expect(captured?.customTools?.[0]?.parameters).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("forwards and isolates tool turn context across concurrent turns", async () => {
    const seen = new Map<string, Readonly<Record<string, unknown>> | undefined>();
    let arrived = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const inputSchema = z.object({ turn: z.string() });
    const tool: ToolDefinition = {
      name: "context_probe",
      description: "Observe turn context",
      inputSchema,
      async execute(input, ctx) {
        const { turn } = inputSchema.parse(input);
        seen.set(turn, ctx.turnContext);
        arrived += 1;
        if (arrived === 2) releaseBoth();
        await bothArrived;
        ctx.emit({ type: "tool_result", toolUseId: "", content: turn });
      },
    };
    const factory: PiSessionFactory = {
      async createSession(params) {
        const projected = params.customTools?.[0];
        if (!projected) throw new Error("missing projected tool");
        return {
          subscribe: () => () => {},
          async prompt(turn) {
            await projected.execute(`call-${turn}`, { turn }, undefined);
          },
        };
      },
    };
    const provider = new PiProvider({ factory });
    const alpha = { room: "alpha" } as const;
    const beta = { room: "beta" } as const;

    await Promise.all([
      collect(
        provider.sendQuery("alpha", "/same-cwd", undefined, {
          tools: [tool],
          turnContext: alpha,
        }),
      ),
      collect(
        provider.sendQuery("beta", "/same-cwd", undefined, {
          tools: [tool],
          turnContext: beta,
        }),
      ),
    ]);

    expect(seen.get("alpha")).toBe(alpha);
    expect(seen.get("beta")).toBe(beta);
  });

  test("omits tool turn context when the turn omits it", async () => {
    let seen: Readonly<Record<string, unknown>> | undefined = { unexpected: true };
    let hasTurnContext = true;
    const tool: ToolDefinition = {
      name: "context_probe",
      description: "Observe turn context",
      inputSchema: z.object({}),
      async execute(_input, ctx) {
        seen = ctx.turnContext;
        hasTurnContext = Object.hasOwn(ctx, "turnContext");
        ctx.emit({ type: "tool_result", toolUseId: "", content: "ok" });
      },
    };
    const factory: PiSessionFactory = {
      async createSession(params) {
        const projected = params.customTools?.[0];
        if (!projected) throw new Error("missing projected tool");
        return {
          subscribe: () => () => {},
          async prompt() {
            await projected.execute("call-1", {}, undefined);
          },
        };
      },
    };

    await collect(
      new PiProvider({ factory }).sendQuery("hi", "/tmp", undefined, { tools: [tool] }),
    );

    expect(seen).toBeUndefined();
    expect(hasTurnContext).toBe(false);
  });

  test("an abort during session creation skips the turn entirely", async () => {
    const abort = new AbortController();
    let prompted = false;
    const factory = fakeFactory([textDelta("never")], {
      capture: () => abort.abort(),
      capturePrompt: () => {
        prompted = true;
      },
      modelRef: "openai/gpt-5.2",
    });
    const provider = new PiProvider({ factory });
    const chunks = await collect(
      provider.sendQuery("hi", "/tmp", undefined, { abortSignal: abort.signal }),
    );
    expect(chunks).toEqual([]);
    expect(prompted).toBe(false);
  });

  test("no tools option → no customTools handed to the factory", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
    });
    await collect(provider.sendQuery("hi", "/tmp"));
    expect(captured?.customTools).toBeUndefined();
  });

  test("session-creation failure yields a single error chunk", async () => {
    const provider = new PiProvider({
      factory: fakeFactory([], { throwOnCreate: new Error("no auth") }),
    });
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toEqual([{ type: "error", message: "pi session failed to start: no auth" }]);
  });

  test("a prompt() failure surfaces as an error chunk", async () => {
    const provider = new PiProvider({
      factory: fakeFactory([], { throwOnPrompt: new Error("stream died") }),
    });
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toEqual([{ type: "error", message: "stream died" }]);
  });

  test("a turn that errors before streaming surfaces the error, not silence", async () => {
    // pi swallows the upstream failure into the final assistant message and
    // resolves prompt() cleanly — no throw, no text. Without agent_end mapping
    // this is the "no reply, no error" dead turn.
    const provider = new PiProvider({
      factory: fakeFactory([
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "agent_end",
          willRetry: false,
          messages: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "OpenAI API error (421): 421 Misdirected Request",
            },
          ],
        },
      ]),
    });
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toEqual([
      { type: "error", message: "OpenAI API error (421): 421 Misdirected Request" },
    ]);
  });

  test("an already-aborted signal yields nothing and never creates a session", async () => {
    let created = false;
    const factory: PiSessionFactory = {
      async createSession() {
        created = true;
        throw new Error("should not be called");
      },
    };
    const controller = new AbortController();
    controller.abort();
    const chunks = await collect(
      new PiProvider({ factory }).sendQuery("hi", "/tmp", undefined, {
        abortSignal: controller.signal,
      }),
    );
    expect(chunks).toEqual([]);
    expect(created).toBe(false);
  });
});

describe("checkPiAuth", () => {
  test("reports a vendor env key", () => {
    expect(
      checkPiAuth({ env: { ANTHROPIC_API_KEY: "sk-x" }, authFile: "/nope/auth.json" }),
    ).toEqual({
      authenticated: true,
      source: "env",
    });
  });

  test("reports an auth.json file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-auth-"));
    try {
      const authFile = join(dir, "auth.json");
      writeFileSync(authFile, "{}");
      expect(checkPiAuth({ env: {}, authFile })).toEqual({
        authenticated: true,
        source: "auth.json",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports unauthenticated when nothing is present", () => {
    expect(checkPiAuth({ env: {}, authFile: "/nope/auth.json" })).toEqual({ authenticated: false });
  });
});

const GPT4: PiModelLike = {
  provider: "openai",
  id: "gpt-4",
  name: "GPT-4",
  reasoning: false,
  input: ["text"],
  cost: { output: 60 },
};
const OPUS: PiModelLike = {
  provider: "anthropic",
  id: "claude-opus-4.5",
  name: "Claude Opus 4.5",
  reasoning: true,
  input: ["text", "image"],
  cost: { output: 25 },
};
const COPILOT: PiModelLike = {
  provider: "github-copilot",
  id: "gpt-5.5",
  name: "GPT-5.5",
  reasoning: true,
  input: ["text"],
  cost: { output: 0 },
};
// A models.json custom provider pointing at a local OpenAI-compatible server.
const LOCAL: PiModelLike = {
  provider: "rec",
  id: "flint",
  name: "Flint (local)",
  reasoning: true,
  input: ["text"],
  cost: { output: 0 },
};

const catalogOf = (models: PiModelLike[], oauth: string[] = []) =>
  buildPiCatalog(models, (provider) => oauth.includes(provider));

describe("buildPiCatalog", () => {
  test("lists every registry-available model, including models.json custom providers", () => {
    const ids = catalogOf([OPUS, COPILOT, GPT4, LOCAL]).map((m) => m.id);
    expect(ids).toEqual([
      "anthropic/claude-opus-4.5",
      "github-copilot/gpt-5.5",
      "openai/gpt-4",
      "rec/flint",
    ]);
  });

  test("tags OAuth as subscription, priced keys as metered, unpriced keys as unknown", () => {
    const byId = new Map(
      catalogOf([OPUS, COPILOT, GPT4, LOCAL], ["github-copilot"]).map((m) => [m.id, m]),
    );
    expect(byId.get("github-copilot/gpt-5.5")?.billing).toBe("subscription");
    expect(byId.get("anthropic/claude-opus-4.5")?.billing).toBe("metered");
    expect(byId.get("openai/gpt-4")?.billing).toBe("metered");
    expect(byId.get("rec/flint")?.billing).toBeUndefined();
    expect(byId.get("rec/flint")?.costTier).toBe("free");
  });

  test("derives cost tier from output price and maps reasoning + vision", () => {
    const byId = new Map(catalogOf([OPUS, GPT4]).map((m) => [m.id, m]));
    const opus = byId.get("anthropic/claude-opus-4.5");
    expect(opus?.costTier).toBe("high");
    expect(opus?.displayName).toBe("Claude Opus 4.5");
    expect(opus?.supports).toEqual({ thinking: true, vision: true });
    // text-only, no reasoning → vision omitted, thinking false
    expect(byId.get("openai/gpt-4")?.supports).toEqual({ thinking: false });
  });

  test("skips a model whose auth check throws, keeping the rest of the catalog", () => {
    const catalog = buildPiCatalog([OPUS, GPT4], (provider) => {
      if (provider === "anthropic") throw new Error("auth exploded");
      return false;
    });
    expect(catalog.map((m) => m.id)).toEqual(["openai/gpt-4"]);
  });

  test("treats a model with no cost block as free", () => {
    const { cost: _cost, ...noCost } = GPT4;
    expect(catalogOf([noCost])[0]?.costTier).toBe("free");
  });
});

describe("costTierFromOutput", () => {
  test("buckets by USD per 1M output tokens", () => {
    expect(costTierFromOutput(0)).toBe("free");
    expect(costTierFromOutput(4)).toBe("low");
    expect(costTierFromOutput(15)).toBe("mid");
    expect(costTierFromOutput(25)).toBe("high");
    expect(costTierFromOutput(60)).toBe("high");
  });

  test("pins the inclusive bucket boundaries", () => {
    // Guards the `<= 5` / `<= 20` edges against an off-by-one tidy-up.
    expect(costTierFromOutput(5)).toBe("low");
    expect(costTierFromOutput(20)).toBe("mid");
  });

  test("degrades a non-positive or NaN price to free", () => {
    expect(costTierFromOutput(-3)).toBe("free");
    expect(costTierFromOutput(Number.NaN)).toBe("free");
  });
});

describe("projectToolsForPi", () => {
  const noSignal = new AbortController().signal;

  function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
    return {
      name: "echo_tool",
      description: "Echo the input",
      inputSchema: z.object({ value: z.string() }),
      execute: async (input, ctx) => {
        ctx.emit({
          type: "tool_result",
          toolUseId: "",
          content: `echo: ${(input as { value: string }).value}`,
        });
      },
      ...overrides,
    };
  }

  test("execute returns the emitted tool_result as text content", async () => {
    const [projected] = projectToolsForPi([makeTool()], {
      cwd: "/tmp",
      pushChunk: () => {},
    });
    if (!projected) throw new Error("narrow");
    const result = await projected.execute("t1", { value: "hi" }, noSignal);
    expect(result).toEqual({ content: [{ type: "text", text: "echo: hi" }], details: undefined });
  });

  test("non-result chunks stream through pushChunk; the tool_result does not", async () => {
    const streamed: MessageChunk[] = [];
    const tool = makeTool({
      execute: async (_input, ctx) => {
        ctx.emit({ type: "system", content: "working…" });
        ctx.emit({ type: "tool_result", toolUseId: "", content: "done" });
      },
    });
    const [projected] = projectToolsForPi([tool], {
      cwd: "/tmp",
      pushChunk: (c) => streamed.push(c),
    });
    if (!projected) throw new Error("narrow");
    await projected.execute("t1", { value: "x" }, noSignal);
    expect(streamed).toEqual([{ type: "system", content: "working…" }]);
  });

  test("invalid input throws (pi converts a throw into an error tool result)", async () => {
    const [projected] = projectToolsForPi([makeTool()], { cwd: "/tmp", pushChunk: () => {} });
    if (!projected) throw new Error("narrow");
    await expect(projected.execute("t1", { value: 42 }, noSignal)).rejects.toThrow(
      "Invalid input for tool 'echo_tool'",
    );
  });

  test("an isError tool_result throws with its content", async () => {
    const tool = makeTool({
      execute: async (_input, ctx) => {
        ctx.emit({
          type: "tool_result",
          toolUseId: "",
          content: "workflow not found",
          isError: true,
        });
      },
    });
    const [projected] = projectToolsForPi([tool], { cwd: "/tmp", pushChunk: () => {} });
    if (!projected) throw new Error("narrow");
    await expect(projected.execute("t1", { value: "x" }, noSignal)).rejects.toThrow(
      "workflow not found",
    );
  });

  test("a throwing execute propagates", async () => {
    const tool = makeTool({
      execute: async () => {
        throw new Error("boom");
      },
    });
    const [projected] = projectToolsForPi([tool], { cwd: "/tmp", pushChunk: () => {} });
    if (!projected) throw new Error("narrow");
    await expect(projected.execute("t1", { value: "x" }, noSignal)).rejects.toThrow("boom");
  });

  test("a tool that emits nothing returns empty text (success for the loop)", async () => {
    const tool = makeTool({ execute: async () => {} });
    const [projected] = projectToolsForPi([tool], { cwd: "/tmp", pushChunk: () => {} });
    if (!projected) throw new Error("narrow");
    const result = await projected.execute("t1", { value: "x" }, noSignal);
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  test("zero-arg tools get an empty object parameters schema", () => {
    const tool = makeTool({ inputSchema: z.object({}) });
    const [projected] = projectToolsForPi([tool], { cwd: "/tmp", pushChunk: () => {} });
    expect(projected?.parameters).toEqual({ type: "object", properties: {} });
  });

  test("a per-call gate deny throws before the tool executes (pi → error result)", async () => {
    let executed = false;
    const tool = makeTool({
      execute: async () => {
        executed = true;
      },
    });
    const [projected] = projectToolsForPi([tool], {
      cwd: "/tmp",
      pushChunk: () => {},
      evaluateToolCall: async () => ({ outcome: "deny", reason: "nope" }),
    });
    if (!projected) throw new Error("narrow");
    await expect(projected.execute("t1", { value: "x" }, noSignal)).rejects.toThrow(
      "Tool 'echo_tool' denied by policy: nope",
    );
    expect(executed).toBe(false);
  });

  test("a per-call gate allow runs the tool and receives the validated args", async () => {
    let seenArgs: unknown;
    const [projected] = projectToolsForPi([makeTool()], {
      cwd: "/tmp",
      pushChunk: () => {},
      evaluateToolCall: async (call) => {
        seenArgs = call.args;
        return { outcome: "allow" };
      },
    });
    if (!projected) throw new Error("narrow");
    const result = await projected.execute("t1", { value: "hi" }, noSignal);
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(seenArgs).toEqual({ value: "hi" });
  });

  test("a result gate substitution rewrites what the model receives (not just the UI echo)", async () => {
    let seenResult: unknown;
    const [projected] = projectToolsForPi([makeTool()], {
      cwd: "/tmp",
      pushChunk: () => {},
      evaluateToolResult: async (r) => {
        seenResult = r.result;
        return { outcome: "allow", data: "echo: [REDACTED]" };
      },
    });
    if (!projected) throw new Error("narrow");
    const result = await projected.execute("t1", { value: "hi" }, noSignal);
    expect(result.content).toEqual([{ type: "text", text: "echo: [REDACTED]" }]);
    // The gate saw the tool's real output before it was rewritten.
    expect(seenResult).toBe("echo: hi");
  });

  test("a result gate deny throws (pi → error result) with the withheld reason", async () => {
    const [projected] = projectToolsForPi([makeTool()], {
      cwd: "/tmp",
      pushChunk: () => {},
      evaluateToolResult: async () => ({ outcome: "deny", reason: "leaked a key" }),
    });
    if (!projected) throw new Error("narrow");
    await expect(projected.execute("t1", { value: "hi" }, noSignal)).rejects.toThrow(
      "Tool 'echo_tool' result withheld by policy: leaked a key",
    );
  });

  test("a plain result-gate allow leaves the output untouched", async () => {
    const [projected] = projectToolsForPi([makeTool()], {
      cwd: "/tmp",
      pushChunk: () => {},
      evaluateToolResult: async () => ({ outcome: "allow" }),
    });
    if (!projected) throw new Error("narrow");
    const result = await projected.execute("t1", { value: "hi" }, noSignal);
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
  });

  test("the pi-supplied signal reaches the tool's context", async () => {
    const abort = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = makeTool({
      execute: async (_input, ctx) => {
        seen = ctx.abortSignal;
      },
    });
    const [projected] = projectToolsForPi([tool], { cwd: "/tmp", pushChunk: () => {} });
    if (!projected) throw new Error("narrow");
    await projected.execute("t1", { value: "x" }, abort.signal);
    expect(seen).toBe(abort.signal);
  });

  test("keelson's turn signal aborts the tool even when pi supplies its own signal", async () => {
    const turnAbort = new AbortController();
    const piAbort = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = makeTool({
      execute: async (_input, ctx) => {
        seen = ctx.abortSignal;
      },
    });
    const [projected] = projectToolsForPi([tool], {
      cwd: "/tmp",
      pushChunk: () => {},
      abortSignal: turnAbort.signal,
    });
    if (!projected) throw new Error("narrow");
    await projected.execute("t1", { value: "x" }, piAbort.signal);
    expect(seen?.aborted).toBe(false);
    turnAbort.abort();
    expect(seen?.aborted).toBe(true);
  });
});

describe("mapPiFinishReason", () => {
  test("terminal stop maps to end", () => {
    expect(
      mapPiFinishReason({
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "stop", content: [] }],
      }),
    ).toBe("end");
  });

  test("max_tokens and length map to max_tokens", () => {
    for (const stopReason of ["max_tokens", "length"]) {
      expect(
        mapPiFinishReason({
          type: "agent_end",
          willRetry: false,
          messages: [{ role: "assistant", stopReason }],
        }),
      ).toBe("max_tokens");
    }
  });

  test("errored, retrying, and non-terminal events report nothing", () => {
    expect(
      mapPiFinishReason({
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "error" }],
      }),
    ).toBeUndefined();
    expect(
      mapPiFinishReason({
        type: "agent_end",
        willRetry: true,
        messages: [{ role: "assistant", stopReason: "stop" }],
      }),
    ).toBeUndefined();
    expect(mapPiFinishReason({ type: "message_update" })).toBeUndefined();
  });
});

// Captures the handlers the gate extension registers on a fake pi API.
function loadGate(
  gates: Parameters<typeof createPiGateExtension>[0],
  selfGated: string[] = [],
  options: Parameters<typeof createPiGateExtension>[2] = {},
) {
  const handlers: Record<string, (event: never) => Promise<unknown>> = {};
  const api = {
    on: (name: string, handler: (event: never) => Promise<unknown>) => {
      handlers[name] = handler;
    },
  } as unknown as PiGateExtensionApi;
  createPiGateExtension(gates, new Set(selfGated), options)(api);
  return {
    call: (toolName: string, input: unknown) => handlers.tool_call?.({ toolName, input } as never),
    result: (
      toolName: string,
      content: { type: string; text?: string }[],
      isError = false,
      input: unknown = {},
      toolCallId?: string,
    ) => handlers.tool_result?.({ toolName, content, isError, input, toolCallId } as never),
    callWithId: (toolName: string, input: unknown, toolCallId: string) =>
      handlers.tool_call?.({ toolName, input, toolCallId } as never),
    request: () => handlers.before_provider_request?.({} as never),
  };
}

describe("createPiGateExtension", () => {
  test("blocks a denied call with the policy message", async () => {
    const gate = loadGate({
      evaluateToolCall: async () => ({ outcome: "deny", reason: "no shell" }),
    });
    expect(await gate.call("bash", { command: "rm -rf /" })).toEqual({
      block: true,
      reason: "Tool 'Bash' denied by policy: no shell",
    });
  });

  test("brackets generations: provider requests start one, tool calls end it", async () => {
    const log: string[] = [];
    const gate = loadGate({}, [], {
      generation: {
        start: async () => {
          log.push("start");
        },
        end: () => {
          log.push("end");
        },
      },
    });
    expect(await gate.request()).toBeUndefined();
    await gate.call("workflow_run", {});
    await gate.request();
    expect(log).toEqual(["start", "end", "start"]);
  });

  test("gates built-ins under their canonical policy name, then pi's own", async () => {
    const seen: string[] = [];
    const denyOnly = (name: string) =>
      loadGate({
        evaluateToolCall: async (req) => {
          seen.push(req.tool);
          return req.tool === name ? { outcome: "deny", reason: "floor" } : { outcome: "allow" };
        },
      });
    expect(await denyOnly("Bash").call("bash", { command: "ls" })).toMatchObject({ block: true });
    expect(await denyOnly("Write").call("edit", {})).toMatchObject({ block: true });
    expect(await denyOnly("bash").call("bash", { command: "ls" })).toMatchObject({ block: true });
    seen.length = 0;
    expect(await denyOnly("Bash").call("custom_ext", {})).toBeUndefined();
    expect(seen).toEqual(["custom_ext"]);
  });

  test("the call gate sees the tool name and raw args; allow passes through", async () => {
    const seen: unknown[] = [];
    const gate = loadGate({
      evaluateToolCall: async (req) => {
        seen.push(req);
        return { outcome: "allow" };
      },
    });
    expect(await gate.call("fetch_content", { url: "https://example.com" })).toBeUndefined();
    expect(seen).toEqual([
      { tool: "WebFetch", args: { url: "https://example.com" } },
      { tool: "fetch_content", args: { url: "https://example.com" } },
    ]);
  });

  test("skips self-gated keelson tools so they are not gated twice", async () => {
    let calls = 0;
    const gate = loadGate(
      {
        evaluateToolCall: async () => {
          calls++;
          return { outcome: "deny", reason: "x" };
        },
        evaluateToolResult: async () => {
          calls++;
          return { outcome: "deny", reason: "x" };
        },
      },
      ["workflow_run"],
    );
    expect(await gate.call("workflow_run", {})).toBeUndefined();
    expect(await gate.result("workflow_run", [{ type: "text", text: "x" }])).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("the result gate can substitute or withhold output", async () => {
    const redacting = loadGate({
      evaluateToolResult: async () => ({ outcome: "allow", data: "token=[REDACTED]" }),
    });
    const image = { type: "image" };
    expect(await redacting.result("read", [{ type: "text", text: "token=abc" }, image])).toEqual({
      content: [{ type: "text", text: "token=[REDACTED]" }, image],
      isError: false,
    });
    const withholding = loadGate({
      evaluateToolResult: async () => ({ outcome: "deny", reason: "pii" }),
    });
    const withheld = (await withholding.result("bash", [{ type: "text", text: "secret" }])) as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(withheld.isError).toBe(true);
    expect(withheld.content).toHaveLength(1);
    expect(withheld.content[0]?.text).toContain("withheld by policy");
  });

  test("gives a bash call without a timeout the default, leaving explicit ones", async () => {
    const gate = loadGate({}, [], { bashTimeoutSec: 300 });
    const bare: { command: string; timeout?: number } = { command: "find / -name x" };
    await gate.call("bash", bare);
    expect(bare.timeout).toBe(300);
    const explicit = { command: "bun test", timeout: 900 };
    await gate.call("bash", explicit);
    expect(explicit.timeout).toBe(900);
  });

  test("an unchanged result is left alone", async () => {
    const gate = loadGate({ evaluateToolResult: async () => ({ outcome: "allow" }) });
    expect(await gate.result("ls", [{ type: "text", text: "a b" }])).toBeUndefined();
  });
});

describe("PiProvider built-in tools", () => {
  test("enables built-ins by default and carries both gates", async () => {
    let captured: PiCreateSessionParams | undefined;
    const evaluateToolCall = async () => ({ outcome: "allow" as const });
    const evaluateToolResult = async () => ({ outcome: "allow" as const });
    const provider = new PiProvider({
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
    });
    await collect(
      provider.sendQuery("hi", "/tmp", undefined, { evaluateToolCall, evaluateToolResult }),
    );
    expect(captured?.builtinTools).toBe(true);
    expect(captured?.gates?.evaluateToolCall).toBe(evaluateToolCall);
    expect(captured?.gates?.evaluateToolResult).toBe(evaluateToolResult);
  });

  test("builtinTools: false leaves the session without built-ins", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      builtinTools: false,
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
    });
    await collect(provider.sendQuery("hi", "/tmp"));
    expect(captured?.builtinTools).toBe(false);
  });
});

describe("PiProvider session lifecycle", () => {
  test("disposes the session once the turn settles", async () => {
    let disposed = 0;
    const factory: PiSessionFactory = {
      async createSession() {
        return {
          subscribe: () => () => {},
          prompt: async () => {},
          dispose: () => {
            disposed++;
          },
        };
      },
    };
    await collect(new PiProvider({ factory }).sendQuery("hi", "/tmp"));
    expect(disposed).toBe(1);
  });

  test("an abort mid-turn interrupts pi and frees the vendor slot when it stops", async () => {
    const abort = new AbortController();
    const slots = new PiVendorSlots({ rec: 1 });
    let finish: () => void = () => {};
    let aborted = false;
    const factory: PiSessionFactory = {
      async createSession() {
        return {
          modelRef: "rec/flint",
          subscribe: () => () => {},
          prompt: () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
          abort: async () => {
            aborted = true;
            finish();
          },
        };
      },
    };
    const gen = new PiProvider({ factory, slots }).sendQuery("hi", "/tmp", undefined, {
      abortSignal: abort.signal,
    });
    expect((await gen.next()).value).toEqual({ type: "model", model: "rec/flint" });
    const pending = gen.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(slots.isSaturated("rec")).toBe(true);
    abort.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
    expect(slots.isSaturated("rec")).toBe(false);
  });
});

describe("PiProvider abort and teardown", () => {
  function disposableFactory(counter: { disposed: number; prompted: number }, modelRef?: string) {
    return {
      async createSession(): Promise<PiSession> {
        return {
          ...(modelRef !== undefined ? { modelRef } : {}),
          subscribe: () => () => {},
          prompt: async () => {
            counter.prompted++;
          },
          dispose: () => {
            counter.disposed++;
          },
        };
      },
    } satisfies PiSessionFactory;
  }

  test("an abort while queued for a slot disposes the session without prompting", async () => {
    const counter = { disposed: 0, prompted: 0 };
    const slots = new PiVendorSlots({ rec: 1 });
    const held = await slots.acquire("rec");
    const abort = new AbortController();
    const done = collect(
      new PiProvider({ factory: disposableFactory(counter, "rec/flint"), slots }).sendQuery(
        "hi",
        "/tmp",
        undefined,
        { abortSignal: abort.signal },
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    await done;
    held?.();
    expect(counter).toEqual({ disposed: 1, prompted: 0 });
  });

  test("an abort before the slot continuation runs never prompts", async () => {
    const counter = { disposed: 0, prompted: 0 };
    const abort = new AbortController();
    const gen = new PiProvider({ factory: disposableFactory(counter, "openai/gpt") }).sendQuery(
      "hi",
      "/tmp",
      undefined,
      { abortSignal: abort.signal },
    );
    expect((await gen.next()).value).toEqual({ type: "model", model: "openai/gpt" });
    abort.abort();
    expect((await gen.next()).done).toBe(true);
    expect(counter).toEqual({ disposed: 1, prompted: 0 });
  });

  test("an abort during session creation disposes the session", async () => {
    const counter = { disposed: 0, prompted: 0 };
    const abort = new AbortController();
    const inner = disposableFactory(counter);
    const factory: PiSessionFactory = {
      async createSession() {
        abort.abort();
        return inner.createSession();
      },
    };
    await collect(
      new PiProvider({ factory }).sendQuery("hi", "/tmp", undefined, {
        abortSignal: abort.signal,
      }),
    );
    expect(counter).toEqual({ disposed: 1, prompted: 0 });
  });

  test("a throwing dispose still ends the turn", async () => {
    const factory: PiSessionFactory = {
      async createSession() {
        return {
          subscribe: () => () => {},
          prompt: async () => {},
          dispose: () => {
            throw new Error("dispose failed");
          },
        };
      },
    };
    expect(await collect(new PiProvider({ factory }).sendQuery("hi", "/tmp"))).toEqual([]);
  });
});

describe("PiProvider generation-scoped slots", () => {
  test("a tool run frees the slot for another turn and the next generation waits", async () => {
    const slots = new PiVendorSlots({ rec: 1 });
    const seen: string[] = [];
    const factory: PiSessionFactory = {
      async createSession(params) {
        const generation = params.generation;
        if (generation === undefined) throw new Error("no generation hooks");
        return {
          modelRef: "rec/flint",
          subscribe: () => () => {},
          prompt: async () => {
            // The model asked for a tool: pi's tool_call hook ends the generation.
            generation.end();
            const child = await slots.acquire("rec");
            seen.push("child ran");
            let resumed = false;
            const next = generation.start().then(() => {
              resumed = true;
            });
            await new Promise((r) => setTimeout(r, 0));
            seen.push(resumed ? "parent jumped the queue" : "parent waiting");
            child?.();
            await next;
            seen.push("parent resumed");
          },
        };
      },
    };
    await collect(new PiProvider({ factory, slots }).sendQuery("hi", "/tmp"));
    expect(seen).toEqual(["child ran", "parent waiting", "parent resumed"]);
    expect(slots.isSaturated("rec")).toBe(false);
  });
});

describe("PiProvider vendor allowlist", () => {
  const catalogSource = async (): Promise<ModelInfo[]> => [
    { id: "github-copilot/gpt-5.5" },
    { id: "rec/flint" },
  ];

  test("filters the catalog to allowed vendors", async () => {
    const provider = new PiProvider({ vendors: ["rec"], catalogSource, factory: fakeFactory([]) });
    expect((await provider.listModels()).map((m) => m.id)).toEqual(["rec/flint"]);
  });

  test("refuses a turn that resolved outside the allowlist before prompting", async () => {
    let prompted = false;
    const provider = new PiProvider({
      vendors: ["rec"],
      factory: fakeFactory([textDelta("cloud")], {
        modelRef: "github-copilot/gpt-5.5",
        capturePrompt: () => {
          prompted = true;
        },
      }),
    });
    const chunks = await collect(
      provider.sendQuery("hi", "/tmp", undefined, { model: "rec/flint" }),
    );
    expect(prompted).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe("error");
    expect((chunks[0] as { message: string }).message).toContain("outside pi.vendors");
  });

  test("an empty allowlist allows no vendor", async () => {
    let prompted = false;
    const provider = new PiProvider({
      vendors: [],
      catalogSource,
      factory: fakeFactory([textDelta("local")], {
        modelRef: "rec/flint",
        capturePrompt: () => {
          prompted = true;
        },
      }),
    });
    expect(await provider.listModels()).toEqual([]);
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    expect(prompted).toBe(false);
    expect(chunks[0]?.type).toBe("error");
  });

  test("runs an allowed vendor normally", async () => {
    const provider = new PiProvider({
      vendors: ["rec"],
      factory: fakeFactory([textDelta("local")], { modelRef: "rec/flint" }),
    });
    const chunks = await collect(
      provider.sendQuery("hi", "/tmp", undefined, { model: "rec/flint" }),
    );
    expect(chunks).toEqual([
      { type: "model", model: "rec/flint" },
      { type: "text", content: "local" },
    ]);
  });
});

describe("PiProvider default model (config pi.model)", () => {
  test("piCapabilities maps every tier to the default and leads the model list", () => {
    const caps = piCapabilities("rec/flint");
    expect(caps.defaultModel).toBe("rec/flint");
    expect(caps.models[0]).toBe("rec/flint");
    expect(caps.modelClasses).toEqual({
      fast: "rec/flint",
      balanced: "rec/flint",
      deep: "rec/flint",
    });
    expect(piCapabilities()).toBe(PI_CAPABILITIES);
  });

  test("a turn that names no model requests the default", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      defaultModel: "rec/flint",
      factory: fakeFactory([textDelta("ok")], {
        modelRef: "rec/flint",
        capture: (p) => (captured = p),
      }),
    });
    const chunks = await collect(provider.sendQuery("hi", "/tmp"));
    expect(captured?.model).toBe("rec/flint");
    expect(chunks.map((c) => c.type)).toEqual(["model", "text"]);
  });
});

describe("PiProvider fallback to config pi.model", () => {
  test("hands the default to the factory as the fallback for another requested model", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      defaultModel: "rec/flint",
      factory: fakeFactory([textDelta("ok")], {
        modelRef: "rec/flint",
        capture: (p) => (captured = p),
      }),
    });
    const chunks = await collect(
      provider.sendQuery("hi", "/tmp", undefined, { model: "gpt-5.6-terra" }),
    );
    expect(captured?.model).toBe("gpt-5.6-terra");
    expect(captured?.fallbackModel).toBe("rec/flint");
    expect(chunks[1]?.type).toBe("system");
    expect((chunks[1] as { content: string }).content).toContain('running "rec/flint"');
  });
});

describe("PiProvider extensions", () => {
  test("passes configured extension paths and allowed extension tools to the factory", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      extensionPaths: ["/home/k/node_modules/pi-web-access"],
      extensionTools: ["web_search", "fetch_content"],
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
    });
    await collect(provider.sendQuery("hi", "/tmp"));
    expect(captured?.extensionPaths).toEqual(["/home/k/node_modules/pi-web-access"]);
    expect(captured?.extensionTools).toEqual(["web_search", "fetch_content"]);
  });
});

describe("resolvePiExtensionPaths", () => {
  test("resolves package names under the home's node_modules and skips missing ones", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-ext-"));
    try {
      const pkg = join(home, "node_modules", "pi-web-access");
      mkdirSync(pkg, { recursive: true });
      const abs = mkdtempSync(join(tmpdir(), "pi-ext-abs-"));
      expect(resolvePiExtensionPaths(["pi-web-access", "missing-ext", abs], home)).toEqual([
        pkg,
        abs,
      ]);
      rmSync(abs, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("filterPiTools", () => {
  const surface = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "web_search",
    "fetch_content",
  ];

  test("keeps everything when the node sets no rails", () => {
    expect(filterPiTools(surface, undefined, undefined)).toEqual(surface);
  });

  test("maps Claude-style allowed_tools onto pi tools by capability", () => {
    expect(filterPiTools(surface, ["Read", "Write", "WebFetch"], undefined)).toEqual([
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "web_search",
      "fetch_content",
    ]);
  });

  test("denied_tools removes a capability and exact names", () => {
    expect(filterPiTools(surface, undefined, ["Bash", "web_search"])).toEqual([
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "fetch_content",
    ]);
  });

  test("an allowlist of only non-capability names leaves no built-ins", () => {
    expect(filterPiTools(surface, ["touchline_status"], undefined)).toEqual([]);
  });
});

describe("PiProvider tool rails", () => {
  test("forwards a node's allowed_tools / denied_tools to the factory", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
    });
    await collect(
      provider.sendQuery("hi", "/tmp", undefined, {
        allowedTools: ["Read", "WebFetch"],
        disallowedTools: ["Bash"],
      }),
    );
    expect(captured?.allowedTools).toEqual(["Read", "WebFetch"]);
    expect(captured?.disallowedTools).toEqual(["Bash"]);
  });

  test("applies the rails to projected keelson tools, deny winning", async () => {
    let captured: PiCreateSessionParams | undefined;
    const tool = (name: string): ToolDefinition => ({
      name,
      description: name,
      inputSchema: z.object({}),
      execute: async () => {},
    });
    const provider = new PiProvider({
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
    });
    await collect(
      provider.sendQuery("hi", "/tmp", undefined, {
        tools: [tool("workflow_run"), tool("workflow_list"), tool("memory_recall")],
        allowedTools: ["workflow_run", "mcp__keelson__workflow_list"],
        disallowedTools: ["mcp__keelson__workflow_run"],
      }),
    );
    expect(captured?.customTools?.map((t) => t.name)).toEqual(["workflow_list"]);
  });
});

describe("pi gate repeat-call guard", () => {
  const text = (t: string) => [{ type: "text", text: t }];

  test("blocks an identical call once it has returned the same result `limit` times", async () => {
    const gate = loadGate({}, [], { repeatCallLimit: 2 });
    const input = { pattern: "player-findings" };
    for (let i = 0; i < 2; i++) {
      expect(await gate.call("grep", input)).toBeUndefined();
      await gate.result("grep", text("no matches"), false, input);
    }
    const blocked = (await gate.call("grep", input)) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("same result 2 times");
    expect(await gate.call("grep", { pattern: "other" })).toBeUndefined();
  });

  test("a changed result resets the count", async () => {
    const gate = loadGate({}, [], { repeatCallLimit: 2 });
    const input = { command: "bun test" };
    await gate.call("bash", input);
    await gate.result("bash", text("1 fail"), false, input);
    await gate.call("bash", input);
    await gate.result("bash", text("0 fail"), false, input);
    expect(await gate.call("bash", input)).toBeUndefined();
  });

  test("the blocked call's own result does not reset the count", async () => {
    const gate = loadGate({}, [], { repeatCallLimit: 1 });
    const input = { path: "/a" };
    await gate.callWithId("read", input, "1");
    await gate.result("read", text("same"), false, input, "1");
    expect(await gate.callWithId("read", input, "2")).toMatchObject({ block: true });
    await gate.result("read", text("blocked"), true, input, "2");
    expect(await gate.callWithId("read", input, "3")).toMatchObject({ block: true });
  });

  test("is off without a limit", async () => {
    const gate = loadGate({});
    const input = { path: "/a" };
    for (let i = 0; i < 5; i++) {
      expect(await gate.call("read", input)).toBeUndefined();
      await gate.result("read", text("same"), false, input);
    }
  });
});

describe("PiProvider repeatCallLimit", () => {
  test("defaults to 3 and honors config", async () => {
    const seen: (number | undefined)[] = [];
    for (const repeatCallLimit of [undefined, 0]) {
      const provider = new PiProvider({
        ...(repeatCallLimit !== undefined ? { repeatCallLimit } : {}),
        factory: fakeFactory([{ type: "agent_end" }], {
          capture: (p) => seen.push(p.repeatCallLimit),
        }),
      });
      await collect(provider.sendQuery("hi", "/tmp"));
    }
    expect(seen).toEqual([3, 0]);
  });
});

describe("PiProvider — sandbox", () => {
  const profile = {
    enabled: true,
    filesystem: { readwrite: ["/repo"], readonly: [], denied: [] },
    network: { outbound: "deny" as const },
    env: [],
  };
  const tool = (name: string): ToolDefinition => ({
    name,
    description: name,
    inputSchema: z.object({ command: z.string() }),
    execute: async () => {},
  });

  test("capability is tool only when the host has a sandbox runtime", () => {
    expect(new PiProvider({ factory: fakeFactory([]) }).getCapabilities().sandbox).toBeUndefined();
    expect(
      new PiProvider({ factory: fakeFactory([]), sandboxSupport: "tool" }).getCapabilities()
        .sandbox,
    ).toBe("tool");
    expect(piCapabilities("rec/flint", "tool").sandbox).toBe("tool");
  });

  test("a sandboxed turn swaps pi's built-in bash for the supplied one", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
      sandboxSupport: "tool",
    });
    await collect(
      provider.sendQuery("hi", "/repo", undefined, { tools: [tool("bash")], sandbox: profile }),
    );
    expect(captured?.excludeBuiltinTools).toEqual(["bash"]);
    expect(captured?.customTools?.map((t) => t.name)).toEqual(["bash"]);
    expect(captured?.builtinTools).toBe(true);
  });

  test("an unsandboxed turn keeps pi's own bash", async () => {
    let captured: PiCreateSessionParams | undefined;
    const provider = new PiProvider({
      factory: fakeFactory([{ type: "agent_end" }], { capture: (p) => (captured = p) }),
      sandboxSupport: "tool",
    });
    await collect(provider.sendQuery("hi", "/repo"));
    expect(captured?.excludeBuiltinTools).toBeUndefined();
  });

  test("fails closed before a session when no sandboxed bash arrives or there is no runtime", async () => {
    let created = 0;
    const factory = fakeFactory([{ type: "agent_end" }], { capture: () => created++ });
    const noTool = await collect(
      new PiProvider({ factory, sandboxSupport: "tool" }).sendQuery("hi", "/repo", undefined, {
        tools: [tool("workflow_run")],
        sandbox: profile,
      }),
    );
    expect(noTool).toEqual([
      {
        type: "error",
        message: "sandbox unavailable: no sandboxed bash tool was supplied for this pi turn",
      },
    ]);
    const noRuntime = await collect(
      new PiProvider({ factory }).sendQuery("hi", "/repo", undefined, {
        tools: [tool("bash")],
        sandbox: profile,
      }),
    );
    expect(noRuntime[0]).toMatchObject({ type: "error" });
    expect(created).toBe(0);
  });
});
