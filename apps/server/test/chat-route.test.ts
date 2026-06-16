// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  isRegisteredProvider,
  type MessageChunk,
  type ProviderCapabilities,
  type ProviderRegistration,
  registerProvider,
  registerStubProvider,
  type SendQueryOptions,
} from "@keelson/providers";
import {
  type ChatFrame,
  type ClientFrame,
  chatFrameSchema,
  conversationSchema,
  WIRE_PROTOCOL_VERSION,
} from "@keelson/shared";
import {
  clearRegistry as clearToolRegistry,
  registerTool,
  type ToolDefinition,
} from "@keelson/skills";
import type { Server, ServerWebSocket } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import {
  chatRoutes,
  chatWebSocketHandlers,
  handleChatRequest,
  handleChatUpgrade,
} from "../src/chat-handler.ts";
import { type ConversationStore, createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createPolicyEngine } from "../src/policy-engine.ts";
import type { WsData } from "../src/server-context.ts";
import { createWorkflowStore } from "../src/workflow-store.ts";
import { createActiveRuns } from "../src/workflows-handler.ts";

// In-memory SQLite store: uses the production openDatabase code path so
// migrations run and the schema is identical to a real DB file.
function makeMemStore(): ConversationStore {
  return createConversationStore(openDatabase({ path: ":memory:" }));
}

// chatRoutes requires workflow deps; these tests don't exercise the cascade
// but the handler signature is shared with production wiring.
function makeWorkflowDeps(db = openDatabase({ path: ":memory:" })) {
  return { workflowStore: createWorkflowStore(db), activeRuns: createActiveRuns() };
}

interface TestRig {
  app: Hono;
  store: ConversationStore;
}

function makeRig(): TestRig {
  const store = makeMemStore();
  const app = new Hono();
  chatRoutes(app, store, makeWorkflowDeps());
  return { app, store };
}

// Spy provider for forwarding tests: captures the SendQueryOptions it
// receives via the supplied callback and terminates without yielding so the
// chat-handler proceeds to its done frame. Each call must use a fresh `id`
// (the registry is idempotent on id, no clearRegistry between tests).
function makeSpyProvider(
  id: string,
  capture: (options: SendQueryOptions | undefined) => void,
): ProviderRegistration {
  const capabilities: ProviderCapabilities = {
    sessionResume: false,
    streaming: true,
    tools: false,
    models: ["spy-model"],
    defaultModel: "spy-model",
  };
  return {
    id,
    displayName: `Spy (${id})`,
    builtIn: false,
    capabilities,
    factory: () => ({
      getType: () => "spy",
      getCapabilities: () => capabilities,
      listModels: async () => [{ id: "spy-model" }],
      // Spy generator — captures the options the harness passed in. No yield:
      // the test only asserts what was forwarded, not what came back.
      // biome-ignore lint/correctness/useYield: spy generator intentionally yields nothing
      async *sendQuery(_prompt, _cwd, _resume, options) {
        capture(options);
      },
    }),
  };
}

beforeAll(() => {
  // idempotent — provider may already be registered if index.ts was loaded by
  // another test in the same bun test invocation
  if (!isRegisteredProvider("stub")) registerStubProvider();
});

describe("REST chat endpoints", () => {
  test("GET /api/providers includes the stub", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/providers"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ id: string }> };
    expect(body.providers.some((p) => p.id === "stub")).toBe(true);
  });

  test("GET /api/providers/:id/models returns the provider's live list as ModelInfo[]", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/providers/stub/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }> };
    expect(body.models).toEqual([{ id: "stub-echo" }]);
  });

  test("GET /api/providers/:id/models 404 for unknown provider", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/providers/does-not-exist/models"));
    expect(res.status).toBe(404);
  });

  test("GET /api/tools returns registered tools with inferred family", async () => {
    clearToolRegistry();
    try {
      const mkTool = (name: string, description: string): ToolDefinition => ({
        name,
        description,
        inputSchema: z.object({}).strict(),
        execute: async () => {},
      });
      registerTool(mkTool("alpha_test", "Alpha fixture"));
      registerTool(mkTool("beta_test", "Beta fixture"));
      registerTool(mkTool("noprefix", "No-prefix fixture"));

      const { app } = makeRig();
      const res = await app.fetch(new Request("http://test/api/tools"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tools: Array<{ name: string; description: string; family: string }>;
      };
      const byName = new Map(body.tools.map((t) => [t.name, t]));
      expect(byName.get("alpha_test")?.family).toBe("alpha");
      expect(byName.get("alpha_test")?.description).toBe("Alpha fixture");
      expect(byName.get("beta_test")?.family).toBe("beta");
      expect(byName.get("noprefix")?.family).toBe("other");
    } finally {
      clearToolRegistry();
    }
  });

  test("GET /api/tools returns empty list when nothing registered", async () => {
    clearToolRegistry();
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/tools"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: unknown[] };
    expect(body.tools).toEqual([]);
  });

  test("POST /api/conversations mints id and returns a valid Conversation", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "stub" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    const conv = conversationSchema.parse(body);
    expect(conv.providerId).toBe("stub");
    expect(conv.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(conv.messages).toEqual([]);
  });

  test("POST /api/conversations persists seedSystemPrompt and echoes it on GET", async () => {
    const { app } = makeRig();
    const seed = "## Quality snapshot\n\nAll services rated A.";
    const postRes = await app.fetch(
      new Request("http://test/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "stub", seedSystemPrompt: seed }),
      }),
    );
    expect(postRes.status).toBe(201);
    const created = conversationSchema.parse(await postRes.json());
    expect(created.seedSystemPrompt).toBe(seed);

    const getRes = await app.fetch(new Request(`http://test/api/conversations/${created.id}`));
    expect(getRes.status).toBe(200);
    const fetched = conversationSchema.parse(await getRes.json());
    expect(fetched.seedSystemPrompt).toBe(seed);
  });

  test("POST /api/conversations accepts and persists a pre-set name", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "stub", name: "Features" }),
      }),
    );
    expect(res.status).toBe(201);
    const created = conversationSchema.parse(await res.json());
    expect(created.name).toBe("Features");
  });

  test("POST /api/conversations rejects seedSystemPrompt > 8KB", async () => {
    const { app } = makeRig();
    const huge = "x".repeat(8001);
    const res = await app.fetch(
      new Request("http://test/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "stub", seedSystemPrompt: huge }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/conversations rejects invalid body", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wrong: "shape" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/conversations rejects unknown providerId", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "does-not-exist" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/conversations lists created conversations", async () => {
    const { app, store } = makeRig();
    const a = store.create({ providerId: "stub" });
    const b = store.create({ providerId: "stub" });
    const res = await app.fetch(new Request("http://test/api/conversations"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ id: string }>;
    };
    const ids = body.conversations.map((c) => c.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("GET /api/conversations/:id returns 404 for missing", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/conversations/missing-id"));
    expect(res.status).toBe(404);
  });

  test("PATCH /api/conversations/:id renames and echoes the conversation", async () => {
    const { app, store } = makeRig();
    const conv = store.create({ providerId: "stub" });

    const res = await app.fetch(
      new Request(`http://test/api/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Important conversation" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const updated = conversationSchema.parse(body);
    expect(updated.name).toBe("Important conversation");
    expect(store.get(conv.id)!.name).toBe("Important conversation");
  });

  test("PATCH /api/conversations/:id rejects empty/whitespace name", async () => {
    const { app, store } = makeRig();
    const conv = store.create({ providerId: "stub" });

    const res = await app.fetch(
      new Request(`http://test/api/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("PATCH /api/conversations/:id 404 for missing", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/conversations/ghost-id", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("DELETE /api/conversations/:id removes and returns 204", async () => {
    const { app, store } = makeRig();
    const conv = store.create({ providerId: "stub" });

    const res = await app.fetch(
      new Request(`http://test/api/conversations/${conv.id}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    expect(store.get(conv.id)).toBeUndefined();
  });

  test("DELETE /api/conversations/:id 404 for missing", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/conversations/ghost-id", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("handleChatRequest dispatch", () => {
  function makeFrame(conversationId: string, providerId: string, prompt: string): ClientFrame {
    return {
      version: WIRE_PROTOCOL_VERSION,
      conversationId,
      message: { type: "request", providerId, prompt },
    };
  }

  test("streams system + text chunks then a top-level done", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    const sent: ChatFrame[] = [];
    const abort = new AbortController();

    await handleChatRequest(makeFrame(conv.id, "stub", "hello world"), {
      send: (f) => sent.push(f),
      store,
      abortSignal: abort.signal,
    });

    // All frames must validate against the wire schema
    for (const f of sent) chatFrameSchema.parse(f);

    const eventTypes = sent.map((f) => f.event.type);
    expect(eventTypes[eventTypes.length - 1]).toBe("done");

    const chunkEvents = sent.filter((f) => f.event.type === "chunk");
    expect(chunkEvents.length).toBeGreaterThan(0);

    // Provider-yielded 'done' MessageChunk must NOT appear nested in a chunk event
    for (const f of chunkEvents) {
      if (f.event.type === "chunk") {
        expect(f.event.payload.type).not.toBe("done");
      }
    }

    // First chunk is the stub's 'system' line
    const first = chunkEvents[0];
    if (first.event.type === "chunk") {
      expect(first.event.payload.type).toBe("system");
    }
  });

  test("records user prompt and assistant response in the store on success", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });

    await handleChatRequest(makeFrame(conv.id, "stub", "hello world"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id);
    expect(stored).toBeDefined();
    expect(stored!.messages).toHaveLength(2);
    expect(stored!.messages[0].role).toBe("user");
    expect(stored!.messages[0].content).toBe("hello world");
    expect(stored!.messages[1].role).toBe("assistant");
    // Stub yields each token with a trailing space — accumulated text contains both
    expect(stored!.messages[1].content).toContain("hello");
    expect(stored!.messages[1].content).toContain("world");
  });

  test("records user prompt even when provider lookup fails", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });

    await handleChatRequest(makeFrame(conv.id, "does-not-exist", "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id);
    expect(stored!.messages).toHaveLength(1);
    expect(stored!.messages[0].role).toBe("user");
    expect(stored!.messages[0].content).toBe("hi");
  });

  test("emits error frame for unknown providerId", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    const sent: ChatFrame[] = [];
    await handleChatRequest(makeFrame(conv.id, "does-not-exist", "hi"), {
      send: (f) => sent.push(f),
      store,
      abortSignal: new AbortController().signal,
    });

    expect(sent).toHaveLength(2);
    expect(sent[0].event.type).toBe("error");
    if (sent[0].event.type === "error") {
      expect(sent[0].event.code).toBe("UNKNOWN_PROVIDER");
    }
    expect(sent[1].event.type).toBe("done");
  });

  test("emits error frame for unknown conversationId", async () => {
    const store = makeMemStore();
    const sent: ChatFrame[] = [];
    await handleChatRequest(makeFrame("ghost-id", "stub", "hi"), {
      send: (f) => sent.push(f),
      store,
      abortSignal: new AbortController().signal,
    });

    expect(sent).toHaveLength(2);
    expect(sent[0].event.type).toBe("error");
    if (sent[0].event.type === "error") {
      expect(sent[0].event.code).toBe("UNKNOWN_CONVERSATION");
    }
    expect(sent[1].event.type).toBe("done");
  });

  test("auto-names a fresh conversation from the first user prompt", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    expect(conv.name).toBeUndefined();

    await handleChatRequest(makeFrame(conv.id, "stub", "  Hello\n  there  "), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    // Whitespace collapsed, trimmed.
    expect(store.get(conv.id)!.name).toBe("Hello there");
  });

  test("auto-name truncates long first prompts to 60 chars with ellipsis", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    const long = "abcdefghij".repeat(20); // 200 chars
    await handleChatRequest(makeFrame(conv.id, "stub", long), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });
    const name = store.get(conv.id)!.name!;
    expect(name.length).toBe(60);
    expect(name.endsWith("…")).toBe(true);
  });

  test("auto-name skipped when name is already set (manual rename wins)", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    store.update(conv.id, { name: "My pinned label" });

    await handleChatRequest(makeFrame(conv.id, "stub", "anything"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(store.get(conv.id)!.name).toBe("My pinned label");
  });

  test("auto-name skipped on whitespace-only prompts", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    await handleChatRequest(makeFrame(conv.id, "stub", "   \t\n  "), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });
    expect(store.get(conv.id)!.name).toBeUndefined();
  });

  test("bumps conversation.model when message.model differs", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub", model: "stub-echo" });

    const frame: ClientFrame = {
      version: WIRE_PROTOCOL_VERSION,
      conversationId: conv.id,
      message: {
        type: "request",
        providerId: "stub",
        prompt: "hi",
        model: "stub-other",
      },
    };
    await handleChatRequest(frame, {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(store.get(conv.id)!.model).toBe("stub-other");
  });

  test("leaves conversation.model alone when message.model matches or is omitted", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub", model: "stub-echo" });

    // Same model: no-op
    await handleChatRequest(
      {
        version: WIRE_PROTOCOL_VERSION,
        conversationId: conv.id,
        message: {
          type: "request",
          providerId: "stub",
          prompt: "same",
          model: "stub-echo",
        },
      },
      { send: () => {}, store, abortSignal: new AbortController().signal },
    );
    expect(store.get(conv.id)!.model).toBe("stub-echo");

    // Omitted model: still no-op (falls back to conv.model server-side)
    await handleChatRequest(makeFrame(conv.id, "stub", "missing"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });
    expect(store.get(conv.id)!.model).toBe("stub-echo");
  });

  test("F10.4: forwards request.thinking into provider.sendQuery options", async () => {
    let capturedOptions: SendQueryOptions | undefined;
    const spyId = "spy-thinking-forward";
    registerProvider(
      makeSpyProvider(spyId, (opts) => {
        capturedOptions = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const frame: ClientFrame = {
      version: WIRE_PROTOCOL_VERSION,
      conversationId: conv.id,
      message: {
        type: "request",
        providerId: spyId,
        prompt: "hi",
        thinking: true,
      },
    };
    await handleChatRequest(frame, {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.thinking).toBe(true);
  });

  test("F10.4: omits thinking from provider options when not in request", async () => {
    let capturedOptions: SendQueryOptions | undefined;
    const spyId = "spy-thinking-omitted";
    registerProvider(
      makeSpyProvider(spyId, (opts) => {
        capturedOptions = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.thinking).toBeUndefined();
  });

  test("F10.6: forwards request.reasoningEffort into provider.sendQuery options", async () => {
    let capturedOptions: SendQueryOptions | undefined;
    const spyId = "spy-effort-forward";
    registerProvider(
      makeSpyProvider(spyId, (opts) => {
        capturedOptions = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const frame: ClientFrame = {
      version: WIRE_PROTOCOL_VERSION,
      conversationId: conv.id,
      message: {
        type: "request",
        providerId: spyId,
        prompt: "hi",
        reasoningEffort: "high",
      },
    };
    await handleChatRequest(frame, {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.reasoningEffort).toBe("high");
  });

  test("F10.6: omits reasoningEffort from provider options when not in request", async () => {
    let capturedOptions: SendQueryOptions | undefined;
    const spyId = "spy-effort-omitted";
    registerProvider(
      makeSpyProvider(spyId, (opts) => {
        capturedOptions = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.reasoningEffort).toBeUndefined();
  });

  // --- Phase 3 S2: tool wiring + contentParts persistence ---

  // Spy provider that yields a caller-supplied chunk script and lets the
  // capture callback inspect SendQueryOptions. Used to drive synthetic
  // tool_use / tool_result rounds through the chat-handler without an SDK.
  function makeScriptedProvider(
    id: string,
    chunks: MessageChunk[],
    capture?: (options: SendQueryOptions | undefined) => void,
  ): ProviderRegistration {
    const capabilities: ProviderCapabilities = {
      sessionResume: false,
      streaming: true,
      tools: true,
      models: ["spy-model"],
      defaultModel: "spy-model",
    };
    return {
      id,
      displayName: `Scripted (${id})`,
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "spy-model" }],
        // eslint-disable-next-line require-yield
        async *sendQuery(_p, _c, _r, options): AsyncGenerator<MessageChunk> {
          if (capture) capture(options);
          for (const chunk of chunks) yield chunk;
        },
      }),
    };
  }

  test("Phase 3 S2: forwards getRegisteredTools() into provider.sendQuery options", async () => {
    clearToolRegistry();
    const dummyTool: ToolDefinition = {
      name: "echo",
      description: "Cluster status collector",
      inputSchema: z.object({}).strict(),
      async execute() {},
    };
    registerTool(dummyTool);

    let captured: SendQueryOptions | undefined;
    const spyId = "spy-tools-forward";
    registerProvider(
      makeScriptedProvider(spyId, [], (opts) => {
        captured = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(captured).toBeDefined();
    expect(captured!.tools).toBeDefined();
    expect(captured!.tools!).toHaveLength(1);
    expect(captured!.tools![0]!.name).toBe("echo");
    clearToolRegistry();
  });

  test("a policy engine gates a denied tool out of the chat turn's provider.sendQuery options", async () => {
    clearToolRegistry();
    const safe: ToolDefinition = {
      name: "safe_tool",
      description: "allowed",
      inputSchema: z.object({}).strict(),
      async execute() {},
    };
    const danger: ToolDefinition = {
      name: "danger_tool",
      description: "gated by policy",
      inputSchema: z.object({}).strict(),
      async execute() {},
    };
    registerTool(safe);
    registerTool(danger);

    let captured: SendQueryOptions | undefined;
    const spyId = "spy-policy-gate";
    registerProvider(
      makeScriptedProvider(spyId, [], (opts) => {
        captured = opts;
      }),
    );

    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "r",
          policy: {
            id: "deny-danger",
            on: [{ phase: "tool_call" }],
            evaluate: (e) =>
              e.phase === "tool_call" && e.tool === "danger_tool"
                ? { outcome: "deny", reason: "gated" }
                : { outcome: "allow" },
          },
        },
      ],
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
      policyEngine: engine,
    });

    // The denied tool is gated out before reaching the provider; the safe one stays.
    expect(captured?.tools?.map((t) => t.name)).toEqual(["safe_tool"]);
    clearToolRegistry();
  });

  test("a rib tool colliding with a harness workflow tool is dropped (no shadow, no duplicate)", async () => {
    clearToolRegistry();
    // A rib registers a tool named like a harness-injected one.
    registerTool({
      name: "workflow_run",
      description: "rib shadow",
      inputSchema: z.object({}).strict(),
      async execute() {},
    });
    const harnessWorkflowRun: ToolDefinition = {
      name: "workflow_run",
      description: "harness workflow runner",
      inputSchema: z.object({}).strict(),
      async execute() {},
    };

    let captured: SendQueryOptions | undefined;
    const spyId = "spy-tools-dedup";
    registerProvider(
      makeScriptedProvider(spyId, [], (opts) => {
        captured = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
      workflowTools: [harnessWorkflowRun],
    });

    const names = (captured?.tools ?? []).map((t) => t.name);
    expect(names.filter((n) => n === "workflow_run")).toHaveLength(1);
    // The harness copy wins; the rib's shadow is dropped.
    expect(captured?.tools?.find((t) => t.name === "workflow_run")?.description).toBe(
      "harness workflow runner",
    );
    clearToolRegistry();
  });

  test("Phase 3 S2: omits tools option when no tools are registered", async () => {
    clearToolRegistry();
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-tools-omitted";
    registerProvider(
      makeScriptedProvider(spyId, [], (opts) => {
        captured = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(captured).toBeDefined();
    expect(captured!.tools).toBeUndefined();
  });

  test("Phase 3 S2: tool_use + tool_result chunks accumulate into contentParts", async () => {
    clearToolRegistry();
    const spyId = "spy-tool-roundtrip";
    registerProvider(
      makeScriptedProvider(spyId, [
        { type: "text", content: "Computing answer… " },
        {
          type: "tool_use",
          id: "call_42",
          toolName: "echo",
          toolInput: { persona: "shipper" },
        },
        {
          type: "tool_result",
          toolUseId: "call_42",
          content: '{"healthy": true}',
        },
        { type: "text", content: "Computation complete." },
      ]),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "status?"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id)!;
    const assistant = stored.messages[1]!;
    expect(assistant.role).toBe("assistant");
    // Denormalized text projection still merges the two text deltas.
    expect(assistant.content).toBe("Computing answer… Computation complete.");
    // Structured turn: [text, tool_use, tool_result, text].
    expect(assistant.contentParts).toBeDefined();
    expect(assistant.contentParts).toEqual([
      { type: "text", text: "Computing answer… " },
      {
        type: "tool_use",
        id: "call_42",
        toolName: "echo",
        toolInput: { persona: "shipper" },
      },
      { type: "tool_result", toolUseId: "call_42", content: '{"healthy": true}' },
      { type: "text", text: "Computation complete." },
    ]);
  });

  test("Phase 3 S2: consecutive text chunks merge into one block (Anthropic-style)", async () => {
    clearToolRegistry();
    const spyId = "spy-text-merge";
    registerProvider(
      makeScriptedProvider(spyId, [
        { type: "text", content: "Hello, " },
        { type: "text", content: "world" },
        { type: "text", content: "." },
      ]),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "say hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id)!;
    const assistant = stored.messages[1]!;
    expect(assistant.content).toBe("Hello, world.");
    expect(assistant.contentParts).toEqual([{ type: "text", text: "Hello, world." }]);
  });

  test("Phase 3 S2: synthesizes tool_use id when chunk omits one", async () => {
    clearToolRegistry();
    const spyId = "spy-tool-noid";
    registerProvider(
      makeScriptedProvider(spyId, [
        { type: "tool_use", toolName: "echo" },
        { type: "tool_result", toolUseId: "fallback-id", content: "ok" },
      ]),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "go"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id)!;
    const assistant = stored.messages[1]!;
    expect(assistant.contentParts).toBeDefined();
    const parts = assistant.contentParts!;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe("tool_use");
    if (parts[0]!.type !== "tool_use") throw new Error("narrow");
    expect(typeof parts[0]!.id).toBe("string");
    expect(parts[0]!.id.length).toBeGreaterThan(0);
  });

  test("Phase 3 S2: persists assistant message with contentParts but no text content", async () => {
    clearToolRegistry();
    const spyId = "spy-tools-only";
    registerProvider(
      makeScriptedProvider(spyId, [
        {
          type: "tool_use",
          id: "call_1",
          toolName: "echo",
          toolInput: {},
        },
        { type: "tool_result", toolUseId: "call_1", content: "ok" },
      ]),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "tool only"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id)!;
    // Tool-only turn still produces an assistant message — content is "" but
    // contentParts carries the structured turn so reload (S5) can replay it.
    expect(stored.messages).toHaveLength(2);
    const assistant = stored.messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("");
    expect(assistant.contentParts).toHaveLength(2);
  });

  // --- F10.7b: partial turn persistence on abort + provider error ---

  test("F10.7b: abort mid-stream persists accumulated contentParts with truncated:true and no done frame", async () => {
    clearToolRegistry();
    const abort = new AbortController();
    const spyId = "spy-abort-midstream";
    const capabilities: ProviderCapabilities = {
      sessionResume: false,
      streaming: true,
      tools: true,
      models: ["spy-model"],
      defaultModel: "spy-model",
    };
    // Provider yields one text + one tool_use, then aborts the controller,
    // then yields more chunks the handler must NOT process.
    registerProvider({
      id: spyId,
      displayName: `Abort (${spyId})`,
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "spy-model" }],
        async *sendQuery(): AsyncGenerator<MessageChunk> {
          yield { type: "text", content: "Computing… " };
          yield { type: "tool_use", id: "call_1", toolName: "echo" };
          abort.abort();
          yield { type: "text", content: "should be dropped" };
        },
      }),
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const sent: ChatFrame[] = [];
    await handleChatRequest(makeFrame(conv.id, spyId, "status?"), {
      send: (f) => sent.push(f),
      store,
      abortSignal: abort.signal,
    });

    const stored = store.get(conv.id)!;
    expect(stored.messages).toHaveLength(2);
    const assistant = stored.messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.truncated).toBe(true);
    expect(assistant.content).toBe("Computing… ");
    expect(assistant.contentParts).toHaveLength(2);
    expect(assistant.contentParts?.[0]?.type).toBe("text");
    expect(assistant.contentParts?.[1]?.type).toBe("tool_use");

    // Done frame must NOT be sent on abort — the WS close already signals
    // termination to the client.
    expect(sent.some((f) => f.event.type === "done")).toBe(false);
  });

  test("F10.7b: abort with no accumulated content writes no assistant row", async () => {
    clearToolRegistry();
    const abort = new AbortController();
    abort.abort(); // pre-aborted; provider yields, handler returns on first iteration check
    const spyId = "spy-abort-empty";
    registerProvider(makeScriptedProvider(spyId, [{ type: "text", content: "never processed" }]));
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: abort.signal,
    });

    const stored = store.get(conv.id)!;
    // User message persisted; no assistant row because nothing was accumulated.
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0]!.role).toBe("user");
  });

  test("F10.7b: provider error mid-stream persists partial turn with truncated:true and sends done", async () => {
    clearToolRegistry();
    const spyId = "spy-error-midstream";
    const capabilities: ProviderCapabilities = {
      sessionResume: false,
      streaming: true,
      tools: true,
      models: ["spy-model"],
      defaultModel: "spy-model",
    };
    registerProvider({
      id: spyId,
      displayName: `Error (${spyId})`,
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "spy-model" }],
        async *sendQuery(): AsyncGenerator<MessageChunk> {
          yield { type: "text", content: "Partial " };
          yield { type: "tool_use", id: "call_1", toolName: "echo" };
          throw new Error("upstream blew up");
        },
      }),
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const sent: ChatFrame[] = [];
    await handleChatRequest(makeFrame(conv.id, spyId, "go"), {
      send: (f) => sent.push(f),
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id)!;
    expect(stored.messages).toHaveLength(2);
    const assistant = stored.messages[1]!;
    expect(assistant.truncated).toBe(true);
    expect(assistant.content).toBe("Partial ");
    expect(assistant.contentParts).toHaveLength(2);

    // Error frame went out and done frame still closes the turn (the WS stays
    // open; client uses `done` to flip the streaming UI).
    const eventTypes = sent.map((f) => f.event.type);
    expect(eventTypes).toContain("error");
    expect(eventTypes[eventTypes.length - 1]).toBe("done");
  });

  test("F10.7b: clean completion does NOT set truncated", async () => {
    clearToolRegistry();
    const spyId = "spy-clean-no-truncate";
    registerProvider(makeScriptedProvider(spyId, [{ type: "text", content: "All good." }]));
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });
    const stored = store.get(conv.id)!;
    expect(stored.messages[1]!.truncated).toBeUndefined();
  });

  test("Phase 3 S10: osdu_activity_mr tool_use + tool_result persist in contentParts", async () => {
    clearToolRegistry();
    const spyId = "spy-osdu-activity-mr";
    const toolResultPayload = JSON.stringify({
      available: true,
      error: null,
      rows: [
        {
          iid: 42,
          title: "Fix venus collector",
          state: "opened",
          author: "alice",
          created_at: "2026-05-10T12:00:00Z",
        },
      ],
      total: 1,
      parameters: { state_filter: "opened", since_filter: "2026-05-09T00:00:00Z" },
    });
    registerProvider(
      makeScriptedProvider(spyId, [
        { type: "text", content: "Looking up open MRs… " },
        {
          type: "tool_use",
          id: "call_osdu_1",
          toolName: "osdu_activity_mr",
          toolInput: { state: "opened", since: "2026-05-09T00:00:00Z" },
        },
        {
          type: "tool_result",
          toolUseId: "call_osdu_1",
          content: toolResultPayload,
        },
        { type: "text", content: "1 open MR matched." },
      ]),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    await handleChatRequest(makeFrame(conv.id, spyId, "show me the open MRs for the last 4 days"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id)!;
    const assistant = stored.messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Looking up open MRs… 1 open MR matched.");
    expect(assistant.contentParts).toEqual([
      { type: "text", text: "Looking up open MRs… " },
      {
        type: "tool_use",
        id: "call_osdu_1",
        toolName: "osdu_activity_mr",
        toolInput: { state: "opened", since: "2026-05-09T00:00:00Z" },
      },
      { type: "tool_result", toolUseId: "call_osdu_1", content: toolResultPayload },
      { type: "text", text: "1 open MR matched." },
    ]);
  });

  // --- Phase 3 S7: system-prompt identity injection ---

  // Swap env vars for the duration of `fn`, restoring (or deleting) the
  // originals afterwards. Tests run sequentially within a file so we don't
  // need a lock, but we still must restore so neighboring tests see the
  // ambient env they were written against.
  async function _withEnv(
    overrides: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const originals: Record<string, string | undefined> = {};
    for (const key of Object.keys(overrides)) originals[key] = process.env[key];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("omits systemPrompt when the conversation has no seed", async () => {
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-identity-empty";
    registerProvider(
      makeSpyProvider(spyId, (opts) => {
        captured = opts;
      }),
    );

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(captured).toBeDefined();
    expect(captured!.systemPrompt).toBeUndefined();
  });

  test("aborting mid-stream stops emitting and skips the final done", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    const sent: ChatFrame[] = [];
    const abort = new AbortController();

    // Abort right after the first chunk lands
    const send = (f: ChatFrame) => {
      sent.push(f);
      if (sent.length === 1) abort.abort();
    };

    await handleChatRequest(makeFrame(conv.id, "stub", "alpha beta gamma"), {
      send,
      store,
      abortSignal: abort.signal,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].event.type).toBe("chunk");
    // Critically: no final 'done' frame after abort
    expect(sent.some((f) => f.event.type === "done")).toBe(false);

    // Aborted turn must not produce an assistant message in the store
    const stored = store.get(conv.id);
    expect(stored!.messages).toHaveLength(1);
    expect(stored!.messages[0].role).toBe("user");
  });
});

describe("WebSocket handlers", () => {
  test("parse-fail: invalid JSON gets error frame then close 1008", async () => {
    const store = makeMemStore();
    const handlers = chatWebSocketHandlers(store);
    const sent: string[] = [];
    let closedWith: { code?: number; reason?: string } | undefined;

    const fakeWs: ServerWebSocket<WsData> = {
      data: { abort: new AbortController() },
      send: (msg: string | Buffer | Uint8Array) => {
        sent.push(typeof msg === "string" ? msg : msg.toString());
        return 1;
      },
      close: (code?: number, reason?: string) => {
        closedWith = { code, reason };
      },
    } as unknown as ServerWebSocket<WsData>;

    await handlers.message!(fakeWs, "not json at all {");

    expect(sent).toHaveLength(1);
    const parsed = chatFrameSchema.parse(JSON.parse(sent[0]));
    expect(parsed.event.type).toBe("error");
    if (parsed.event.type === "error") {
      expect(parsed.event.code).toBe("PARSE_ERROR");
    }
    expect(closedWith).toEqual({ code: 1008, reason: "invalid frame" });
  });

  test("F10.4 parse-fail: thinking with non-boolean value gets rejected", async () => {
    const store = makeMemStore();
    const handlers = chatWebSocketHandlers(store);
    const sent: string[] = [];
    let closed = false;

    const fakeWs: ServerWebSocket<WsData> = {
      data: { abort: new AbortController() },
      send: (msg: string) => {
        sent.push(msg);
        return 1;
      },
      close: () => {
        closed = true;
      },
    } as unknown as ServerWebSocket<WsData>;

    const badFrame = JSON.stringify({
      version: WIRE_PROTOCOL_VERSION,
      conversationId: "any",
      message: {
        type: "request",
        providerId: "stub",
        prompt: "hi",
        thinking: "yes",
      },
    });

    await handlers.message!(fakeWs, badFrame);

    expect(closed).toBe(true);
    expect(sent).toHaveLength(1);
    const parsed = chatFrameSchema.parse(JSON.parse(sent[0]));
    expect(parsed.event.type).toBe("error");
  });

  test("F10.6 parse-fail: reasoningEffort with unknown tier gets rejected", async () => {
    const store = makeMemStore();
    const handlers = chatWebSocketHandlers(store);
    const sent: string[] = [];
    let closed = false;

    const fakeWs: ServerWebSocket<WsData> = {
      data: { abort: new AbortController() },
      send: (msg: string) => {
        sent.push(msg);
        return 1;
      },
      close: () => {
        closed = true;
      },
    } as unknown as ServerWebSocket<WsData>;

    const badFrame = JSON.stringify({
      version: WIRE_PROTOCOL_VERSION,
      conversationId: "any",
      message: {
        type: "request",
        providerId: "stub",
        prompt: "hi",
        reasoningEffort: "ultra",
      },
    });

    await handlers.message!(fakeWs, badFrame);

    expect(closed).toBe(true);
    expect(sent).toHaveLength(1);
    const parsed = chatFrameSchema.parse(JSON.parse(sent[0]));
    expect(parsed.event.type).toBe("error");
  });

  test("parse-fail: extra keys in envelope get rejected and close 1008", async () => {
    const store = makeMemStore();
    const handlers = chatWebSocketHandlers(store);
    const sent: string[] = [];
    let closed = false;

    const fakeWs: ServerWebSocket<WsData> = {
      data: { abort: new AbortController() },
      send: (msg: string) => {
        sent.push(msg);
        return 1;
      },
      close: () => {
        closed = true;
      },
    } as unknown as ServerWebSocket<WsData>;

    const badFrame = JSON.stringify({
      version: WIRE_PROTOCOL_VERSION,
      conversationId: "any",
      message: { type: "request", providerId: "stub", prompt: "hi" },
      surprise: "extra-key",
    });

    await handlers.message!(fakeWs, badFrame);

    expect(closed).toBe(true);
    expect(sent).toHaveLength(1);
    const parsed = chatFrameSchema.parse(JSON.parse(sent[0]));
    expect(parsed.event.type).toBe("error");
  });
});

describe("WebSocket upgrade gate", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    const store = makeMemStore();
    const app = new Hono();
    chatRoutes(app, store, makeWorkflowDeps());

    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/api/chat/ws") {
          return handleChatUpgrade(req, srv);
        }
        return app.fetch(req);
      },
      websocket: chatWebSocketHandlers(store),
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("rejects WS upgrade from a disallowed Origin with 403", async () => {
    const res = await fetch(`${baseUrl}/api/chat/ws`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        Origin: "http://evil.example",
      },
    });
    expect(res.status).toBe(403);
  });

  test("rejects WS upgrade with no Origin header with 403", async () => {
    const res = await fetch(`${baseUrl}/api/chat/ws`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("handleChatRequest — token usage", () => {
  function makeFrame(conversationId: string, providerId: string, prompt: string): ClientFrame {
    return {
      version: WIRE_PROTOCOL_VERSION,
      conversationId,
      message: { type: "request", providerId, prompt },
    };
  }

  test("streams the provider's usage chunk to the client", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    const sent: ChatFrame[] = [];

    await handleChatRequest(makeFrame(conv.id, "stub", "one two three"), {
      send: (f) => sent.push(f),
      store,
      abortSignal: new AbortController().signal,
    });

    for (const f of sent) chatFrameSchema.parse(f);
    const usageFrames = sent.filter(
      (f) => f.event.type === "chunk" && f.event.payload.type === "usage",
    );
    expect(usageFrames).toHaveLength(1);
    const event = usageFrames[0].event;
    if (event.type === "chunk" && event.payload.type === "usage") {
      expect(event.payload.usage).toEqual({
        inputTokens: 3,
        outputTokens: 3,
        contextTokens: 6,
        contextWindow: 8192,
      });
    }
  });

  test("persists usage on the assistant message and round-trips through the store", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });

    await handleChatRequest(makeFrame(conv.id, "stub", "alpha beta"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    const stored = store.get(conv.id);
    expect(stored).toBeDefined();
    const assistant = stored!.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.usage).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      contextTokens: 4,
      contextWindow: 8192,
    });
    // The user row never carries usage.
    const user = stored!.messages.find((m) => m.role === "user");
    expect(user!.usage).toBeUndefined();
    // And the full conversation still validates against the wire schema.
    conversationSchema.parse(stored);
  });
});

describe("handleChatRequest — usage-only turn persistence", () => {
  test("a turn that reports usage but streams no content still persists an assistant row", async () => {
    const spyId = `usage-only-${crypto.randomUUID().slice(0, 8)}`;
    const capabilities: ProviderCapabilities = {
      sessionResume: false,
      streaming: true,
      tools: false,
      models: ["m"],
      defaultModel: "m",
    };
    registerProvider({
      id: spyId,
      displayName: "UsageOnly",
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "m" }],
        async *sendQuery(): AsyncGenerator<MessageChunk> {
          yield { type: "usage", usage: { inputTokens: 12, outputTokens: 0 } };
          yield { type: "done" };
        },
      }),
    });
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });

    await handleChatRequest(
      {
        version: WIRE_PROTOCOL_VERSION,
        conversationId: conv.id,
        message: { type: "request", providerId: spyId, prompt: "spend tokens" },
      },
      { send: () => {}, store, abortSignal: new AbortController().signal },
    );

    const stored = store.get(conv.id);
    const assistant = stored!.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe("");
    expect(assistant!.usage).toEqual({ inputTokens: 12, outputTokens: 0 });
  });
});

describe("handleChatRequest — usage boundary hardening", () => {
  function spyCapabilities(): ProviderCapabilities {
    return {
      sessionResume: false,
      streaming: true,
      tools: false,
      models: ["m"],
      defaultModel: "m",
    };
  }

  test("a malformed provider usage payload is coerced, not thrown by the strict frame parse", async () => {
    const spyId = `junk-usage-${crypto.randomUUID().slice(0, 8)}`;
    const capabilities = spyCapabilities();
    registerProvider({
      id: spyId,
      displayName: "JunkUsage",
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "m" }],
        async *sendQuery(): AsyncGenerator<MessageChunk> {
          yield { type: "text", content: "fine answer" };
          // Float count + extra key — the shape an out-of-tree provider
          // might emit. Cast past the union: the runtime boundary is the test.
          yield {
            type: "usage",
            usage: { inputTokens: 421.7, outputTokens: 37, totalTokens: 458 },
          } as unknown as MessageChunk;
          yield { type: "done" };
        },
      }),
    });
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const sent: ChatFrame[] = [];

    await handleChatRequest(
      {
        version: WIRE_PROTOCOL_VERSION,
        conversationId: conv.id,
        message: { type: "request", providerId: spyId, prompt: "hi" },
      },
      { send: (f) => sent.push(f), store, abortSignal: new AbortController().signal },
    );

    // No error frame — the turn succeeded; every sent frame is wire-valid.
    for (const f of sent) chatFrameSchema.parse(f);
    expect(sent.some((f) => f.event.type === "error")).toBe(false);
    const assistant = store.get(conv.id)!.messages.find((m) => m.role === "assistant");
    expect(assistant!.truncated).toBeUndefined();
    expect(assistant!.usage).toEqual({ inputTokens: 421, outputTokens: 37 });
  });

  test("usage delivered after a user abort still persists on the truncated row", async () => {
    const spyId = `abort-usage-${crypto.randomUUID().slice(0, 8)}`;
    const capabilities = spyCapabilities();
    const abort = new AbortController();
    registerProvider({
      id: spyId,
      displayName: "AbortUsage",
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "m" }],
        async *sendQuery(): AsyncGenerator<MessageChunk> {
          yield { type: "text", content: "partial" };
          // Providers deliver accumulated usage after the drain on a Stop.
          yield { type: "usage", usage: { inputTokens: 900, outputTokens: 12 } };
        },
      }),
    });
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });

    await handleChatRequest(
      {
        version: WIRE_PROTOCOL_VERSION,
        conversationId: conv.id,
        message: { type: "request", providerId: spyId, prompt: "hi" },
      },
      {
        // Abort as soon as the first content frame lands — the usage chunk
        // arrives while the signal is already aborted.
        send: (f) => {
          if (f.event.type === "chunk" && f.event.payload.type === "text") abort.abort();
        },
        store,
        abortSignal: abort.signal,
      },
    );

    const assistant = store.get(conv.id)!.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.truncated).toBe(true);
    expect(assistant!.usage).toEqual({ inputTokens: 900, outputTokens: 12 });
  });

  test("a zero-spend context-only report does not mint an empty assistant row", async () => {
    const spyId = `ctx-only-${crypto.randomUUID().slice(0, 8)}`;
    const capabilities = spyCapabilities();
    registerProvider({
      id: spyId,
      displayName: "CtxOnly",
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "m" }],
        async *sendQuery(): AsyncGenerator<MessageChunk> {
          yield {
            type: "usage",
            usage: { inputTokens: 0, outputTokens: 0, contextTokens: 900, contextWindow: 64000 },
          };
          yield { type: "done" };
        },
      }),
    });
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });

    await handleChatRequest(
      {
        version: WIRE_PROTOCOL_VERSION,
        conversationId: conv.id,
        message: { type: "request", providerId: spyId, prompt: "hi" },
      },
      { send: () => {}, store, abortSignal: new AbortController().signal },
    );

    const messages = store.get(conv.id)!.messages;
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

describe("handleChatRequest — resolved-model chunk", () => {
  function spyCapabilities(): ProviderCapabilities {
    return {
      sessionResume: false,
      streaming: true,
      tools: false,
      models: ["m"],
      defaultModel: "m",
    };
  }

  function registerModelSpy(spyId: string, modelChunk: unknown): void {
    const capabilities = spyCapabilities();
    registerProvider({
      id: spyId,
      displayName: "ModelSpy",
      builtIn: false,
      capabilities,
      factory: () => ({
        getType: () => "spy",
        getCapabilities: () => capabilities,
        listModels: async () => [{ id: "m" }],
        async *sendQuery(): AsyncGenerator<MessageChunk> {
          yield modelChunk as MessageChunk;
          yield { type: "text", content: "answer" };
          yield { type: "done" };
        },
      }),
    });
  }

  test("a model chunk is forwarded to the client and stays out of the persisted parts", async () => {
    const spyId = `model-spy-${crypto.randomUUID().slice(0, 8)}`;
    registerModelSpy(spyId, { type: "model", model: "openai/gpt-5.2" });
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const sent: ChatFrame[] = [];

    await handleChatRequest(
      {
        version: WIRE_PROTOCOL_VERSION,
        conversationId: conv.id,
        message: { type: "request", providerId: spyId, prompt: "hi" },
      },
      { send: (f) => sent.push(f), store, abortSignal: new AbortController().signal },
    );

    const modelFrames = sent.filter(
      (f) => f.event.type === "chunk" && f.event.payload.type === "model",
    );
    expect(modelFrames).toHaveLength(1);
    const assistant = store.get(conv.id)!.messages.find((m) => m.role === "assistant");
    expect(assistant!.contentParts).toEqual([{ type: "text", text: "answer" }]);
  });

  test("a malformed model chunk is dropped, not thrown by the strict frame parse", async () => {
    const spyId = `model-junk-${crypto.randomUUID().slice(0, 8)}`;
    registerModelSpy(spyId, { type: "model", model: "" });
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const sent: ChatFrame[] = [];

    await handleChatRequest(
      {
        version: WIRE_PROTOCOL_VERSION,
        conversationId: conv.id,
        message: { type: "request", providerId: spyId, prompt: "hi" },
      },
      { send: (f) => sent.push(f), store, abortSignal: new AbortController().signal },
    );

    for (const f of sent) chatFrameSchema.parse(f);
    expect(sent.some((f) => f.event.type === "error")).toBe(false);
    expect(sent.some((f) => f.event.type === "chunk" && f.event.payload.type === "model")).toBe(
      false,
    );
  });
});
