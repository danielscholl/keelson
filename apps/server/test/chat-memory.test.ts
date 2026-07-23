// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { beforeAll, describe, expect, test } from "bun:test";
import {
  isRegisteredProvider,
  type ProviderCapabilities,
  type ProviderRegistration,
  registerProvider,
  registerStubProvider,
  type SendQueryOptions,
} from "@keelson/providers";
import {
  type ClientFrame,
  RECALL_REQUEST_SCHEMA_VERSION,
  RECALL_RESPONSE_SCHEMA_VERSION,
  type RecallItem,
  type RecallRequest,
  type RecallResponse,
  type ToolDefinition,
  WIRE_PROTOCOL_VERSION,
  type WritebackRequest,
  type WritebackResponse,
} from "@keelson/shared";
import { clearRegistry, registerTool } from "@keelson/skills";
import { z } from "zod";
import { handleChatRequest } from "../src/chat-handler.ts";
import { type ConversationStore, createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import type { MemoryStore } from "../src/memory-store.ts";
import { createProjectsStore } from "../src/projects-store.ts";

const RECALL_SECTION_HEADING = "## Relevant prior memory";

function makeMemStore(): ConversationStore {
  return createConversationStore(openDatabase({ path: ":memory:" }));
}

function makeFrame(conversationId: string, providerId: string, prompt: string): ClientFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    message: { type: "request", providerId, prompt },
  };
}

// Spy provider — captures the SendQueryOptions the harness forwarded and
// yields nothing. Re-registered per id so tests don't fight over a shared
// provider registry (registry is idempotent on id).
function registerSpy(id: string, capture: (opts: SendQueryOptions | undefined) => void): void {
  const capabilities: ProviderCapabilities = {
    sessionResume: false,
    streaming: true,
    tools: false,
    models: ["spy-model"],
    defaultModel: "spy-model",
  };
  const reg: ProviderRegistration = {
    id,
    displayName: `Spy (${id})`,
    builtIn: false,
    capabilities,
    factory: () => ({
      getType: () => "spy",
      getCapabilities: () => capabilities,
      listModels: async () => [{ id: "spy-model" }],
      // biome-ignore lint/correctness/useYield: spy generator captures and exits
      async *sendQuery(_prompt, _cwd, _resume, options) {
        capture(options);
      },
    }),
  };
  registerProvider(reg);
}

interface FakeMemoryStoreOptions {
  items?: readonly RecallItem[];
  throwOnRecall?: Error;
}

// Stand-in store: gives the test direct control over recall's return value
// without seeding the real FTS5 index (which couples assertions to BM25
// ranking quirks). Writeback / confirm / listPending / getById throw because
// chat-recall must not invoke them.
function makeFakeMemoryStore(opts: FakeMemoryStoreOptions = {}): {
  store: MemoryStore;
  calls: RecallRequest[];
} {
  const calls: RecallRequest[] = [];
  const store: MemoryStore = {
    recall(req): RecallResponse {
      calls.push(req);
      if (opts.throwOnRecall) throw opts.throwOnRecall;
      const items = opts.items ?? [];
      return {
        schemaVersion: RECALL_RESPONSE_SCHEMA_VERSION,
        requestId: "test-request-id",
        items: [...items],
        trace: { traceId: "test-trace-id", returned: items.length },
      };
    },
    writeback(_req: WritebackRequest): WritebackResponse {
      throw new Error("writeback must not be called from chat recall path");
    },
    confirm(_input) {
      throw new Error("confirm must not be called from chat recall path");
    },
    listPending(_query) {
      throw new Error("listPending must not be called from chat recall path");
    },
    getById(_id) {
      throw new Error("getById must not be called from chat recall path");
    },
  };
  return { store, calls };
}

// Default to a fully injectable item — instruction-promoted, no confirmation
// gate, not flagged for manual-only injection. Promotion requires user_confirmed
// or imported provenance per the schema gate, hence the matching default below.
// Tests that verify the gating filter override usePolicy / provenance explicitly.
function makeRecallItem(overrides: Partial<RecallItem> = {}): RecallItem {
  return {
    memoryId: overrides.memoryId ?? "mem-1",
    type: overrides.type ?? "lesson",
    summary: overrides.summary ?? "port assignment",
    content: overrides.content ?? "the server listens on 7878",
    provenance: overrides.provenance ?? "user_confirmed",
    usePolicy: overrides.usePolicy ?? {
      canUseAsInstruction: true,
      canUseAsEvidence: true,
      requiresUserConfirmation: false,
      doNotInjectAutomatically: false,
    },
    scope: overrides.scope ?? { visibility: "project" },
    sourceRefs: overrides.sourceRefs ?? [],
    artifacts: overrides.artifacts ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    rankingScore: overrides.rankingScore ?? 0.9,
  };
}

beforeAll(() => {
  if (!isRegisteredProvider("stub")) registerStubProvider();
});

describe("chat memory recall", () => {
  test("builds a recall envelope tagged with the chat runtime and per-turn ids", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    const { store: memoryStore, calls } = makeFakeMemoryStore();

    await handleChatRequest(makeFrame(conv.id, "stub", "what port does the server use?"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.schemaVersion).toBe(RECALL_REQUEST_SCHEMA_VERSION);
    expect(req.scope).toEqual({ visibility: "project" });
    expect(req.task.runtime).toBe("chat");
    expect(req.task.taskId).toBe(conv.id);
    // flowId is the freshly minted user-message id; assert it's a UUID and
    // matches the persisted row rather than hard-coding a value.
    const stored = store.get(conv.id);
    const userMsg = stored?.messages.find((m) => m.role === "user");
    expect(req.task.flowId).toBe(userMsg?.id);
    expect(req.query).toBe("what port does the server use?");
    expect(req.limits?.maxItems).toBe(5);
  });

  test("prepends a memory section to systemPrompt when recall returns items", async () => {
    const spyId = "spy-recall-injects";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [
        makeRecallItem({ memoryId: "m1", summary: "port", content: "listens on 7878" }),
        makeRecallItem({
          memoryId: "m2",
          summary: "stub provider",
          content: "use KEELSON_PROVIDERS=stub for offline runs",
        }),
      ],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hello"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.systemPrompt).toBeDefined();
    const sp = captured!.systemPrompt!;
    expect(sp).toContain(RECALL_SECTION_HEADING);
    expect(sp).toContain("port: listens on 7878");
    expect(sp).toContain("stub provider: use KEELSON_PROVIDERS=stub");
  });

  test("preserves seedSystemPrompt with the recall section prepended above it", async () => {
    const spyId = "spy-recall-with-seed";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const seed = "you are a helpful assistant";
    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: seed });
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [makeRecallItem({ summary: "policy", content: "always be concise" })],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hello"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    const sp = captured!.systemPrompt!;
    expect(sp).toContain(RECALL_SECTION_HEADING);
    expect(sp).toContain(seed);
    // Recall section appears before the seed.
    expect(sp.indexOf(RECALL_SECTION_HEADING)).toBeLessThan(sp.indexOf(seed));
  });

  test("leaves systemPrompt untouched when recall returns no items", async () => {
    const spyId = "spy-recall-empty";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: "seed-only" });
    const { store: memoryStore } = makeFakeMemoryStore({ items: [] });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    // Not whole-prompt equality: the guidance sections ride on which tools are
    // registered this turn — ambient state this test doesn't control.
    expect(captured?.systemPrompt?.startsWith("seed-only")).toBe(true);
    expect(captured?.systemPrompt).not.toContain(RECALL_SECTION_HEADING);
  });

  test("warn-and-continues on recall failure without surfacing an error frame", async () => {
    const spyId = "spy-recall-throws";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: "seed" });
    const { store: memoryStore } = makeFakeMemoryStore({
      throwOnRecall: new Error("simulated DB outage"),
    });

    const sent: unknown[] = [];
    await handleChatRequest(makeFrame(conv.id, spyId, "ask"), {
      send: (f) => sent.push(f),
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.systemPrompt?.startsWith("seed")).toBe(true);
    expect(captured?.systemPrompt).not.toContain(RECALL_SECTION_HEADING);
    // No error frames in the stream — recall failure stays observable in logs
    // but never reaches the client.
    expect(sent.some((f) => (f as { event: { type: string } }).event.type === "error")).toBe(false);
  });

  test("injects the workflow index into systemPrompt when tools + catalog are wired", async () => {
    const spyId = "spy-wf-index";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: "seed" });

    const noopTool: ToolDefinition = {
      name: "workflow_run",
      description: "stub",
      inputSchema: z.object({}),
      execute: async () => {},
    };

    await handleChatRequest(makeFrame(conv.id, spyId, "run smoke-test"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
      workflowTools: [noopTool],
      workflowCatalog: {
        list: () => [
          { name: "smoke-test", description: "Use when: verify the engine\nTriggers: smoke test" },
        ],
      },
    });

    const sp = captured!.systemPrompt!;
    expect(sp).toContain("seed");
    expect(sp).toContain("## Workflows");
    expect(sp).toContain("- smoke-test");
    expect(sp).toContain("Do NOT run the name as a shell command");
  });

  test("scopes the workflow index to the conversation's project", async () => {
    const spyId = "spy-wf-index-scoped";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const db = openDatabase({ path: ":memory:" });
    const store = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "scoped", rootPath: "/tmp" });
    const conv = store.create({ providerId: spyId, projectId: project.id });

    const noopTool: ToolDefinition = {
      name: "workflow_run",
      description: "stub",
      inputSchema: z.object({}),
      execute: async () => {},
    };

    let capturedScope: { projectId?: string } | undefined;
    await handleChatRequest(makeFrame(conv.id, spyId, "what can you run?"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
      workflowTools: [noopTool],
      workflowCatalog: {
        list: (scope?: { projectId?: string }) => {
          capturedScope = scope;
          return [{ name: "proj-flow", description: "Use when: project-scoped testing" }];
        },
      },
    });

    expect(capturedScope).toEqual({ projectId: project.id });
    expect(captured!.systemPrompt!).toContain("- proj-flow");
  });

  test("builds authoring tools per request with the conversation's project, shadowing rib collisions", async () => {
    const spyId = "spy-authoring-tools";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const db = openDatabase({ path: ":memory:" });
    const store = createConversationStore(db);
    const projectsStore = createProjectsStore(db);
    const project = projectsStore.create({ name: "authoring", rootPath: "/tmp" });
    const conv = store.create({ providerId: spyId, projectId: project.id });

    const harnessSave: ToolDefinition = {
      name: "workflow_save",
      description: "harness-authoring-save",
      inputSchema: z.object({}),
      execute: async () => {},
    };
    // A rib registering a colliding name must not shadow the harness copy.
    registerTool({
      name: "workflow_save",
      description: "rib-imposter",
      inputSchema: z.object({}),
      execute: async () => {},
    });

    let factoryProject: { id: string; rootPath: string } | null | undefined;
    try {
      await handleChatRequest(makeFrame(conv.id, spyId, "save my workflow"), {
        send: () => {},
        store,
        abortSignal: new AbortController().signal,
        projectsStore,
        workflowAuthoringTools: (p) => {
          factoryProject = p;
          return [harnessSave];
        },
      });
    } finally {
      clearRegistry();
    }

    expect(factoryProject).toEqual({ id: project.id, rootPath: "/tmp" });
    const saves = (captured?.tools ?? []).filter((t) => t.name === "workflow_save");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.description).toBe("harness-authoring-save");
  });

  test("does not invoke recall for workflow-linked conversations", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "workflow" });
    const { store: memoryStore, calls } = makeFakeMemoryStore();

    const sent: unknown[] = [];
    await handleChatRequest(makeFrame(conv.id, "workflow", "hi"), {
      send: (f) => sent.push(f),
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    expect(calls).toHaveLength(0);
    // Existing 400-path error code still fires.
    const first = sent[0] as { event: { type: string; code?: string } };
    expect(first.event.type).toBe("error");
    expect(first.event.code).toBe("WORKFLOW_CONVERSATION_READONLY");
  });

  test("is a no-op when no memoryStore is wired", async () => {
    const spyId = "spy-no-mem";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: "seed" });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.systemPrompt).toBe("seed");
  });

  test("truncates long content with an ellipsis and stays under the cap", async () => {
    const spyId = "spy-recall-truncates";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const longContent = "x".repeat(500);
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [makeRecallItem({ summary: "big", content: longContent })],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    const sp = captured!.systemPrompt!;
    expect(sp).toContain("…");
    // The injected line is "- big: <content>" — content body must be capped.
    const xCount = (sp.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(200);
  });

  test("caps the whole rendered line so a long summary cannot bust the bound", async () => {
    const spyId = "spy-recall-summary-cap";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const longSummary = "S".repeat(400);
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [makeRecallItem({ summary: longSummary, content: "short content" })],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    const sp = captured!.systemPrompt!;
    // The injected line "- <summary>: <content>" must respect the 200-char body cap.
    const lineMatch = sp.match(/^- [^\n]*$/m);
    expect(lineMatch).not.toBeNull();
    const lineBody = lineMatch![0].slice(2); // strip leading "- "
    expect(lineBody.length).toBeLessThanOrEqual(200);
    expect(lineBody.endsWith("…")).toBe(true);
    // Content was never reached because summary alone fills the budget.
    expect(sp).not.toContain("short content");
  });

  test("excludes recalled items with canUseAsInstruction = false", async () => {
    const spyId = "spy-recall-not-instruction";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: "seed" });
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [
        makeRecallItem({
          memoryId: "evidence-only",
          summary: "gen-evidence",
          content: "workflow-written, not promoted",
          provenance: "generated",
          usePolicy: {
            canUseAsInstruction: false,
            canUseAsEvidence: true,
            requiresUserConfirmation: false,
            doNotInjectAutomatically: false,
          },
        }),
      ],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    // Filtered out → no injection, systemPrompt is just the seed.
    expect(captured?.systemPrompt).toBe("seed");
  });

  test("excludes recalled items that require user confirmation", async () => {
    const spyId = "spy-recall-requires-confirm";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: "seed" });
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [
        makeRecallItem({
          memoryId: "needs-confirm",
          summary: "gated",
          content: "requires human sign-off before use",
          usePolicy: {
            canUseAsInstruction: true,
            canUseAsEvidence: true,
            requiresUserConfirmation: true,
            doNotInjectAutomatically: false,
          },
        }),
      ],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.systemPrompt).toBe("seed");
  });

  test("excludes recalled items flagged doNotInjectAutomatically (defense-in-depth)", async () => {
    const spyId = "spy-recall-do-not-inject";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId, seedSystemPrompt: "seed" });
    // The store's recall SQL already excludes these — this fake bypasses
    // that gate so the handler-side filter is exercised independently.
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [
        makeRecallItem({
          memoryId: "manual-only",
          summary: "manual",
          content: "operator-only memory",
          usePolicy: {
            canUseAsInstruction: true,
            canUseAsEvidence: true,
            requiresUserConfirmation: false,
            doNotInjectAutomatically: true,
          },
        }),
      ],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.systemPrompt).toBe("seed");
  });

  test("injects only the items that pass every gate, dropping the rest", async () => {
    const spyId = "spy-recall-mixed-policy";
    let captured: SendQueryOptions | undefined;
    registerSpy(spyId, (opts) => {
      captured = opts;
    });

    const store = makeMemStore();
    const conv = store.create({ providerId: spyId });
    const { store: memoryStore } = makeFakeMemoryStore({
      items: [
        // Passes — default helper sets canUseAsInstruction: true.
        makeRecallItem({ memoryId: "pass", summary: "ok", content: "use this" }),
        // Blocked — not instruction-grade.
        makeRecallItem({
          memoryId: "blocked-evidence",
          summary: "evidence-only",
          content: "should not appear",
          provenance: "generated",
          usePolicy: {
            canUseAsInstruction: false,
            canUseAsEvidence: true,
            requiresUserConfirmation: false,
            doNotInjectAutomatically: false,
          },
        }),
      ],
    });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    const sp = captured!.systemPrompt!;
    expect(sp).toContain("ok: use this");
    expect(sp).not.toContain("should not appear");
  });

  test("skips recall when the user prompt is whitespace-only", async () => {
    const store = makeMemStore();
    const conv = store.create({ providerId: "stub" });
    const { store: memoryStore, calls } = makeFakeMemoryStore();

    await handleChatRequest(makeFrame(conv.id, "stub", "   \t  \n  "), {
      send: () => {},
      store,
      memoryStore,
      abortSignal: new AbortController().signal,
    });

    expect(calls).toHaveLength(0);
  });
});
