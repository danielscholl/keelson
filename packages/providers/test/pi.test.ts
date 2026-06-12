// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageChunk, ModelInfo } from "@keelson/shared";
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
    expect(PI_CAPABILITIES.tools).toBe(false);
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
});

describe("costTierFromOutput", () => {
  test("buckets by USD per 1M output tokens", () => {
    expect(costTierFromOutput(0)).toBe("free");
    expect(costTierFromOutput(4)).toBe("low");
    expect(costTierFromOutput(15)).toBe("mid");
    expect(costTierFromOutput(25)).toBe("high");
    expect(costTierFromOutput(60)).toBe("high");
  });
});
