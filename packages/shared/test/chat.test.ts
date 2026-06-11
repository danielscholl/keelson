import { describe, expect, it } from "bun:test";
import {
  chatEventSchema,
  chatFrameSchema,
  clientFrameSchema,
  clientMessageSchema,
  coerceTokenUsage,
  contentBlockSchema,
  conversationSchema,
  messageChunkSchema,
  messageSchema,
  modelInfoSchema,
  parsePersistedTokenUsage,
  tokenUsageSchema,
  WIRE_PROTOCOL_VERSION,
} from "../src/chat.ts";

describe("WIRE_PROTOCOL_VERSION", () => {
  it("is 1.0", () => {
    expect(WIRE_PROTOCOL_VERSION).toBe("1.0");
  });
});

describe("conversationSchema", () => {
  it("round-trips a fixture conversation", () => {
    const fixture = {
      id: "conv-1",
      providerId: "stub",
      messages: [
        { id: "msg-1", role: "user", content: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
        {
          id: "msg-2",
          role: "assistant",
          content: "hello ",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const result = conversationSchema.parse(fixture);
    expect(result.id).toBe("conv-1");
    expect(result.messages).toHaveLength(2);
  });

  it("accepts optional providerSessionId and updatedAt", () => {
    const result = conversationSchema.parse({
      id: "conv-1",
      providerId: "stub",
      providerSessionId: "session-abc",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(result.providerSessionId).toBe("session-abc");
    expect(result.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      conversationSchema.parse({
        id: "conv-1",
        providerId: "stub",
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        unknownField: "boom",
      }),
    ).toThrow();
  });
});

describe("chatEventSchema", () => {
  it("parses chunk with text payload", () => {
    const event = chatEventSchema.parse({
      type: "chunk",
      payload: { type: "text", content: "hi" },
    });
    expect(event.type).toBe("chunk");
  });

  it("parses chunk with system payload", () => {
    const event = chatEventSchema.parse({
      type: "chunk",
      payload: { type: "system", content: "started" },
    });
    expect(event.type).toBe("chunk");
  });

  it("parses chunk with done payload", () => {
    const event = chatEventSchema.parse({ type: "chunk", payload: { type: "done" } });
    expect(event.type).toBe("chunk");
  });

  it("rejects top-level system event (must travel as chunk payload)", () => {
    expect(() => chatEventSchema.parse({ type: "system", message: "connected" })).toThrow();
  });

  it("parses error event", () => {
    const event = chatEventSchema.parse({ type: "error", message: "oops" });
    expect(event.type).toBe("error");
  });

  it("parses done event", () => {
    const event = chatEventSchema.parse({ type: "done" });
    expect(event.type).toBe("done");
  });

  it("rejects unknown type", () => {
    expect(() => chatEventSchema.parse({ type: "unknown" })).toThrow();
  });
});

describe("chatFrameSchema", () => {
  it("wraps an event with version and conversationId", () => {
    const frame = chatFrameSchema.parse({
      version: WIRE_PROTOCOL_VERSION,
      conversationId: "conv-1",
      event: { type: "chunk", payload: { type: "text", content: "hi" } },
    });
    expect(frame.conversationId).toBe("conv-1");
    expect(frame.event.type).toBe("chunk");
  });

  it("rejects a frame with the wrong version", () => {
    expect(() =>
      chatFrameSchema.parse({
        version: "0.9",
        conversationId: "conv-1",
        event: { type: "done" },
      }),
    ).toThrow();
  });

  it("rejects unknown keys in the envelope", () => {
    expect(() =>
      chatFrameSchema.parse({
        version: WIRE_PROTOCOL_VERSION,
        conversationId: "conv-1",
        event: { type: "done" },
        rogue: true,
      }),
    ).toThrow();
  });
});

describe("clientMessageSchema", () => {
  it("parses a request message", () => {
    const msg = clientMessageSchema.parse({
      type: "request",
      providerId: "stub",
      prompt: "hello",
    });
    expect(msg.type).toBe("request");
  });

  it("accepts an optional model", () => {
    const msg = clientMessageSchema.parse({
      type: "request",
      providerId: "copilot",
      prompt: "hi",
      model: "gpt-4o",
    });
    if (msg.type !== "request") throw new Error("expected request");
    expect(msg.model).toBe("gpt-4o");
  });

  it("rejects unknown message types", () => {
    expect(() =>
      clientMessageSchema.parse({ type: "yolo", providerId: "stub", prompt: "hi" }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      clientMessageSchema.parse({
        type: "request",
        providerId: "stub",
        prompt: "hi",
        rogue: true,
      }),
    ).toThrow();
  });

  it("accepts an optional thinking flag (F10.4)", () => {
    const msg = clientMessageSchema.parse({
      type: "request",
      providerId: "claude",
      prompt: "hi",
      thinking: true,
    });
    if (msg.type !== "request") throw new Error("expected request");
    expect(msg.thinking).toBe(true);
  });

  it("accepts thinking: false (explicit opt-out, F10.4)", () => {
    const msg = clientMessageSchema.parse({
      type: "request",
      providerId: "claude",
      prompt: "hi",
      thinking: false,
    });
    if (msg.type !== "request") throw new Error("expected request");
    expect(msg.thinking).toBe(false);
  });

  it("rejects non-boolean thinking values (F10.4)", () => {
    expect(() =>
      clientMessageSchema.parse({
        type: "request",
        providerId: "claude",
        prompt: "hi",
        thinking: "yes",
      }),
    ).toThrow();
  });

  it.each([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const)("accepts reasoningEffort=%s (F10.6)", (level) => {
    const msg = clientMessageSchema.parse({
      type: "request",
      providerId: "copilot",
      prompt: "hi",
      reasoningEffort: level,
    });
    if (msg.type !== "request") throw new Error("expected request");
    expect(msg.reasoningEffort).toBe(level);
  });

  it("rejects unknown reasoningEffort tiers (F10.6)", () => {
    expect(() =>
      clientMessageSchema.parse({
        type: "request",
        providerId: "copilot",
        prompt: "hi",
        reasoningEffort: "ultra",
      }),
    ).toThrow();
  });

  it("rejects non-string reasoningEffort values (F10.6)", () => {
    expect(() =>
      clientMessageSchema.parse({
        type: "request",
        providerId: "copilot",
        prompt: "hi",
        reasoningEffort: 5,
      }),
    ).toThrow();
  });
});

describe("clientFrameSchema", () => {
  it("wraps a client message with version and conversationId", () => {
    const frame = clientFrameSchema.parse({
      version: WIRE_PROTOCOL_VERSION,
      conversationId: "conv-1",
      message: { type: "request", providerId: "stub", prompt: "hello" },
    });
    expect(frame.conversationId).toBe("conv-1");
    expect(frame.message.type).toBe("request");
  });

  it("rejects a frame with the wrong version", () => {
    expect(() =>
      clientFrameSchema.parse({
        version: "0.9",
        conversationId: "conv-1",
        message: { type: "request", providerId: "stub", prompt: "hi" },
      }),
    ).toThrow();
  });

  it("rejects unknown keys in the envelope", () => {
    expect(() =>
      clientFrameSchema.parse({
        version: WIRE_PROTOCOL_VERSION,
        conversationId: "conv-1",
        message: { type: "request", providerId: "stub", prompt: "hi" },
        rogue: true,
      }),
    ).toThrow();
  });
});

describe("messageChunkSchema", () => {
  it("parses tool_use chunk", () => {
    const chunk = messageChunkSchema.parse({
      type: "tool_use",
      toolName: "read_file",
      toolInput: { path: "/foo.ts" },
    });
    expect(chunk.type).toBe("tool_use");
  });

  it("parses error chunk", () => {
    const chunk = messageChunkSchema.parse({ type: "error", message: "something failed" });
    expect(chunk.type).toBe("error");
  });

  it("parses thinking chunk", () => {
    // Reserved for extended-thinking. No provider emits it yet; this guard
    // pins the wire shape so when one does we don't have to bump the
    // protocol version.
    const chunk = messageChunkSchema.parse({
      type: "thinking",
      content: "Let me work through this step by step…",
    });
    expect(chunk.type).toBe("thinking");
    if (chunk.type !== "thinking") throw new Error("narrow");
    expect(chunk.content).toContain("step by step");
  });

  it("rejects unknown keys on thinking chunk (strict)", () => {
    expect(() =>
      messageChunkSchema.parse({
        type: "thinking",
        content: "x",
        rogue: true,
      }),
    ).toThrow();
  });

  it("wraps a thinking chunk in a chatFrameSchema event", () => {
    // End-to-end wire check: the discriminated union resolves and the
    // outer envelope's strict() validation is satisfied.
    const frame = chatFrameSchema.parse({
      version: WIRE_PROTOCOL_VERSION,
      conversationId: "conv-1",
      event: {
        type: "chunk",
        payload: { type: "thinking", content: "reasoning…" },
      },
    });
    if (frame.event.type !== "chunk") throw new Error("narrow");
    expect(frame.event.payload.type).toBe("thinking");
  });

  it("parses tool_use chunk with optional id (Phase 3 prep)", () => {
    const chunk = messageChunkSchema.parse({
      type: "tool_use",
      id: "call_abc123",
      toolName: "read_file",
      toolInput: { path: "/foo.ts" },
    });
    expect(chunk.type).toBe("tool_use");
    if (chunk.type !== "tool_use") throw new Error("narrow");
    expect(chunk.id).toBe("call_abc123");
  });

  it("parses tool_use chunk without id (additive — pre-Phase 3 emitters)", () => {
    const chunk = messageChunkSchema.parse({
      type: "tool_use",
      toolName: "read_file",
    });
    if (chunk.type !== "tool_use") throw new Error("narrow");
    expect(chunk.id).toBeUndefined();
  });

  it("parses tool_result chunk (Phase 3 prep)", () => {
    const chunk = messageChunkSchema.parse({
      type: "tool_result",
      toolUseId: "call_abc123",
      content: "file contents here",
    });
    expect(chunk.type).toBe("tool_result");
    if (chunk.type !== "tool_result") throw new Error("narrow");
    expect(chunk.toolUseId).toBe("call_abc123");
    expect(chunk.isError).toBeUndefined();
  });

  it("parses tool_result chunk with isError flag", () => {
    const chunk = messageChunkSchema.parse({
      type: "tool_result",
      toolUseId: "call_abc123",
      content: "ENOENT: no such file",
      isError: true,
    });
    if (chunk.type !== "tool_result") throw new Error("narrow");
    expect(chunk.isError).toBe(true);
  });

  it("rejects tool_result chunk missing toolUseId", () => {
    expect(() =>
      messageChunkSchema.parse({
        type: "tool_result",
        content: "x",
      }),
    ).toThrow();
  });

  it("rejects unknown keys on tool_result chunk (strict)", () => {
    expect(() =>
      messageChunkSchema.parse({
        type: "tool_result",
        toolUseId: "x",
        content: "y",
        rogue: true,
      }),
    ).toThrow();
  });

  it("wraps a tool_result chunk in a chatFrameSchema event", () => {
    const frame = chatFrameSchema.parse({
      version: WIRE_PROTOCOL_VERSION,
      conversationId: "conv-1",
      event: {
        type: "chunk",
        payload: {
          type: "tool_result",
          toolUseId: "call_abc",
          content: "ok",
        },
      },
    });
    if (frame.event.type !== "chunk") throw new Error("narrow");
    expect(frame.event.payload.type).toBe("tool_result");
  });
});

describe("contentBlockSchema (Phase 3 prep)", () => {
  it("parses a text block", () => {
    const block = contentBlockSchema.parse({ type: "text", text: "hello" });
    expect(block.type).toBe("text");
    if (block.type !== "text") throw new Error("narrow");
    expect(block.text).toBe("hello");
  });

  it("parses a tool_use block with id and toolInput", () => {
    const block = contentBlockSchema.parse({
      type: "tool_use",
      id: "call_abc",
      toolName: "read_file",
      toolInput: { path: "/foo.ts" },
    });
    if (block.type !== "tool_use") throw new Error("narrow");
    expect(block.id).toBe("call_abc");
    expect(block.toolInput?.path).toBe("/foo.ts");
  });

  it("rejects tool_use block missing id (id is required on persisted shape)", () => {
    expect(() =>
      contentBlockSchema.parse({
        type: "tool_use",
        toolName: "read_file",
      }),
    ).toThrow();
  });

  it("parses a tool_result block", () => {
    const block = contentBlockSchema.parse({
      type: "tool_result",
      toolUseId: "call_abc",
      content: "ok",
    });
    if (block.type !== "tool_result") throw new Error("narrow");
    expect(block.toolUseId).toBe("call_abc");
  });

  it("rejects unknown variant (strict union)", () => {
    expect(() => contentBlockSchema.parse({ type: "thinking", text: "x" })).toThrow();
  });

  it("rejects unknown keys on a block (strict)", () => {
    expect(() =>
      contentBlockSchema.parse({
        type: "text",
        text: "hi",
        rogue: true,
      }),
    ).toThrow();
  });
});

describe("messageSchema.contentParts (Phase 3 prep)", () => {
  it("round-trips a message without contentParts (legacy shape)", () => {
    const msg = messageSchema.parse({
      id: "msg-1",
      role: "assistant",
      content: "hello",
      createdAt: "2026-05-11T00:00:00.000Z",
    });
    expect(msg.contentParts).toBeUndefined();
  });

  it("round-trips a message with mixed content parts", () => {
    const msg = messageSchema.parse({
      id: "msg-1",
      role: "assistant",
      content: "Reading /foo.ts then summarizing.",
      contentParts: [
        { type: "text", text: "Reading /foo.ts then summarizing." },
        {
          type: "tool_use",
          id: "call_1",
          toolName: "read_file",
          toolInput: { path: "/foo.ts" },
        },
        { type: "tool_result", toolUseId: "call_1", content: "export const x = 1;" },
      ],
      createdAt: "2026-05-11T00:00:00.000Z",
    });
    expect(msg.contentParts).toHaveLength(3);
    expect(msg.contentParts?.[0]?.type).toBe("text");
    expect(msg.contentParts?.[1]?.type).toBe("tool_use");
    expect(msg.contentParts?.[2]?.type).toBe("tool_result");
  });

  it("rejects malformed contentParts blocks (propagates from contentBlockSchema)", () => {
    expect(() =>
      messageSchema.parse({
        id: "msg-1",
        role: "assistant",
        content: "x",
        contentParts: [{ type: "thinking", text: "no" }],
        createdAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("messageSchema.truncated (F10.7b)", () => {
  it("round-trips a truncated assistant turn", () => {
    const msg = messageSchema.parse({
      id: "msg-1",
      role: "assistant",
      content: "Computing the answer…",
      truncated: true,
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    expect(msg.truncated).toBe(true);
  });

  it("treats absent truncated as undefined (back-compat with legacy rows)", () => {
    const msg = messageSchema.parse({
      id: "msg-1",
      role: "assistant",
      content: "ok",
      createdAt: "2026-05-13T00:00:00.000Z",
    });
    expect(msg.truncated).toBeUndefined();
  });

  it("rejects non-boolean truncated", () => {
    expect(() =>
      messageSchema.parse({
        id: "msg-1",
        role: "assistant",
        content: "x",
        truncated: "yes",
        createdAt: "2026-05-13T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("modelInfoSchema", () => {
  it("round-trips a full ModelInfo", () => {
    const info = modelInfoSchema.parse({
      id: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      description: "Most capable Claude — deep reasoning, long planning.",
      costTier: "high",
      supports: { vision: true, tools: true, thinking: true },
    });
    expect(info.id).toBe("claude-opus-4-7");
    expect(info.supports?.thinking).toBe(true);
  });

  it("parses a minimal id-only entry", () => {
    const info = modelInfoSchema.parse({ id: "stub-echo" });
    expect(info.id).toBe("stub-echo");
    expect(info.supports).toBeUndefined();
  });

  it("rejects unknown costTier values", () => {
    expect(() => modelInfoSchema.parse({ id: "x", costTier: "ultra" })).toThrow();
  });

  it("rejects unknown keys on the supports block (strict)", () => {
    expect(() =>
      modelInfoSchema.parse({
        id: "x",
        supports: { vision: true, rogue: true },
      }),
    ).toThrow();
  });

  it("round-trips reasoningEffort capability + tier metadata (F10.6)", () => {
    const info = modelInfoSchema.parse({
      id: "claude-sonnet-4.5",
      displayName: "Claude Sonnet 4.5",
      supports: { tools: true, reasoningEffort: true },
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    });
    expect(info.supports?.reasoningEffort).toBe(true);
    expect(info.supportedReasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(info.defaultReasoningEffort).toBe("medium");
  });

  it("rejects unknown tiers in supportedReasoningEfforts (F10.6)", () => {
    expect(() =>
      modelInfoSchema.parse({
        id: "x",
        supportedReasoningEfforts: ["low", "ultra"],
      }),
    ).toThrow();
  });

  it("rejects unknown defaultReasoningEffort values (F10.6)", () => {
    expect(() => modelInfoSchema.parse({ id: "x", defaultReasoningEffort: "ultra" })).toThrow();
  });
});

describe("coerceTokenUsage", () => {
  it("floors floats and strips unknown fields so the result always passes the strict schema", () => {
    const coerced = coerceTokenUsage({
      inputTokens: 421.7,
      outputTokens: 37,
      totalTokens: 458,
      contextWindow: 200000,
    });
    expect(coerced).toEqual({ inputTokens: 421, outputTokens: 37, contextWindow: 200000 });
    expect(tokenUsageSchema.safeParse(coerced).success).toBe(true);
  });

  it("returns undefined for payloads missing required counts or non-objects", () => {
    expect(coerceTokenUsage({ tokens: 5 })).toBeUndefined();
    expect(coerceTokenUsage([1, 2])).toBeUndefined();
    expect(coerceTokenUsage("lots")).toBeUndefined();
    expect(coerceTokenUsage(null)).toBeUndefined();
    expect(coerceTokenUsage({ inputTokens: -1, outputTokens: 2 })).toBeUndefined();
  });

  it("drops a non-positive contextWindow rather than failing the positive() schema bound", () => {
    expect(coerceTokenUsage({ inputTokens: 1, outputTokens: 2, contextWindow: 0 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
  });
});

describe("parsePersistedTokenUsage", () => {
  it("round-trips valid rows and degrades malformed ones to undefined", () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100 };
    expect(parsePersistedTokenUsage(JSON.stringify(usage))).toEqual(usage);
    expect(parsePersistedTokenUsage(null)).toBeUndefined();
    expect(parsePersistedTokenUsage("not json")).toBeUndefined();
    expect(parsePersistedTokenUsage('{"inputTokens":"ten"}')).toBeUndefined();
  });
});
