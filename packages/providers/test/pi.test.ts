// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, ModelInfo, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import {
  buildPiCatalog,
  costTierFromOutput,
  type PiAiLike,
  type PiAuthStorageLike,
} from "../src/pi/catalog.ts";
import type { PiRawEvent } from "../src/pi/event-bridge.ts";
import { mapPiEvent } from "../src/pi/event-bridge.ts";
import type { PiCreateSessionParams, PiSession, PiSessionFactory } from "../src/pi/factory.ts";
import { checkPiAuth } from "../src/pi/factory.ts";
import { PI_CAPABILITIES, PiProvider } from "../src/pi/provider.ts";
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
      { type: "usage", usage: { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 3 } },
    ]);
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
      { type: "usage", usage: { inputTokens: 1, outputTokens: 0 } },
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
    ).toEqual([{ type: "usage", usage: { inputTokens: 0, outputTokens: 5 } }]);
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
            message: { usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 } },
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
        model: "google/gemini-2.5-pro",
        systemPrompt: "you are helpful",
      }),
    );
    expect(promptedModel).toBe("google/gemini-2.5-pro");
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

type FakeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { output: number };
};

const FAKE_MODELS: Record<string, FakeModel[]> = {
  anthropic: [
    {
      id: "claude-opus-4.5",
      name: "Claude Opus 4.5",
      reasoning: true,
      input: ["text", "image"],
      cost: { output: 25 },
    },
  ],
  "github-copilot": [
    { id: "gpt-5.5", name: "GPT-5.5", reasoning: true, input: ["text"], cost: { output: 0 } },
  ],
  openai: [{ id: "gpt-4", name: "GPT-4", reasoning: false, input: ["text"], cost: { output: 60 } }],
  unauthed: [
    { id: "ghost", name: "Ghost", reasoning: false, input: ["text"], cost: { output: 1 } },
  ],
};

// anthropic + openai resolve an env key; github-copilot is OAuth-only (no env
// key); unauthed has neither, so it should be filtered out.
const fakePiAi: PiAiLike = {
  getProviders: () => ["anthropic", "github-copilot", "openai", "unauthed"],
  getEnvApiKey: (p) => (p === "anthropic" || p === "openai" ? "sk-test" : undefined),
  getModels: (p) => FAKE_MODELS[p] ?? [],
};
// Only github-copilot has a stored credential, and it's an OAuth subscription.
const fakeAuth: PiAuthStorageLike = {
  get: (p) => (p === "github-copilot" ? { type: "oauth" } : undefined),
};

describe("buildPiCatalog", () => {
  test("includes only authenticated vendors (stored credential or env key)", () => {
    const ids = buildPiCatalog(fakePiAi, fakeAuth).map((m) => m.id);
    expect(ids).toEqual(["anthropic/claude-opus-4.5", "github-copilot/gpt-5.5", "openai/gpt-4"]);
  });

  test("tags stored OAuth as subscription and env/api-key as metered", () => {
    const byId = new Map(buildPiCatalog(fakePiAi, fakeAuth).map((m) => [m.id, m]));
    expect(byId.get("github-copilot/gpt-5.5")?.billing).toBe("subscription");
    expect(byId.get("anthropic/claude-opus-4.5")?.billing).toBe("metered");
    expect(byId.get("openai/gpt-4")?.billing).toBe("metered");
  });

  test("derives cost tier from output price and maps reasoning + vision", () => {
    const byId = new Map(buildPiCatalog(fakePiAi, fakeAuth).map((m) => [m.id, m]));
    const opus = byId.get("anthropic/claude-opus-4.5");
    expect(opus?.costTier).toBe("high");
    expect(opus?.displayName).toBe("Claude Opus 4.5");
    expect(opus?.supports).toEqual({ thinking: true, vision: true });
    // text-only, no reasoning → vision omitted, thinking false
    expect(byId.get("openai/gpt-4")?.supports).toEqual({ thinking: false });
    expect(byId.get("github-copilot/gpt-5.5")?.costTier).toBe("free");
  });

  test("skips a vendor whose getModels throws, keeping the rest of the catalog", () => {
    const piai: PiAiLike = {
      getProviders: () => ["anthropic", "boom", "openai"],
      getEnvApiKey: () => "sk-test",
      getModels: (vendor) => {
        if (vendor === "boom") throw new Error("vendor exploded");
        return [{ id: "m", name: "M", reasoning: false, input: ["text"], cost: { output: 4 } }];
      },
    };
    const auth: PiAuthStorageLike = { get: () => undefined };
    expect(buildPiCatalog(piai, auth).map((m) => m.id)).toEqual(["anthropic/m", "openai/m"]);
  });

  test("treats a model with no cost block as free", () => {
    const piai = {
      getProviders: () => ["x"],
      getEnvApiKey: () => "sk-test",
      getModels: () => [{ id: "m", name: "M", reasoning: false, input: ["text"] }],
    } as unknown as PiAiLike;
    const auth: PiAuthStorageLike = { get: () => undefined };
    expect(buildPiCatalog(piai, auth)[0]?.costTier).toBe("free");
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
