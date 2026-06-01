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
import { type ClientFrame, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import { handleChatRequest } from "../src/chat-handler.ts";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createProjectNotebookStore } from "../src/project-notebook-store.ts";
import { createProjectsStore } from "../src/projects-store.ts";

function makeFrame(conversationId: string, providerId: string, prompt: string): ClientFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    message: { type: "request", providerId, prompt },
  };
}

// Spy provider — captures the SendQueryOptions the harness forwarded, yields nothing.
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

beforeAll(() => {
  if (!isRegisteredProvider("stub")) registerStubProvider();
});

function setup(spyId: string, capture: (opts: SendQueryOptions | undefined) => void) {
  const db = openDatabase({ path: ":memory:" });
  const store = createConversationStore(db);
  const projects = createProjectsStore(db);
  const notebooks = createProjectNotebookStore(db);
  const project = projects.create({ name: "p", rootPath: "/tmp/p" });
  registerSpy(spyId, capture);
  return { store, notebooks, project };
}

describe("chat project-notebook injection", () => {
  test("injects the project notebook into the system prompt", async () => {
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-notebook-inject";
    const { store, notebooks, project } = setup(spyId, (o) => {
      captured = o;
    });
    notebooks.upsert(project.id, "## Gotchas\n- chat cwd defaults to ~/keelson, not the repo");
    const conv = store.create({ providerId: spyId, projectId: project.id });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      projectNotebookStore: notebooks,
      abortSignal: new AbortController().signal,
    });

    const sp = captured?.systemPrompt;
    expect(sp).toBeDefined();
    expect(sp).toContain("## Project notebook");
    expect(sp).toContain("chat cwd defaults to ~/keelson");
  });

  test("no notebook → system prompt stays untouched", async () => {
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-notebook-absent";
    const { store, notebooks, project } = setup(spyId, (o) => {
      captured = o;
    });
    const conv = store.create({ providerId: spyId, projectId: project.id });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      projectNotebookStore: notebooks,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.systemPrompt).toBeUndefined();
  });

  test("notebook is injected ahead of the conversation seed", async () => {
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-notebook-order";
    const { store, notebooks, project } = setup(spyId, (o) => {
      captured = o;
    });
    const seed = "you are a helpful assistant";
    notebooks.upsert(project.id, "## Conventions\n- comments are terse");
    const conv = store.create({ providerId: spyId, projectId: project.id, seedSystemPrompt: seed });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      projectNotebookStore: notebooks,
      abortSignal: new AbortController().signal,
    });

    const sp = captured!.systemPrompt!;
    expect(sp).toContain("## Project notebook");
    expect(sp).toContain(seed);
    expect(sp.indexOf("## Project notebook")).toBeLessThan(sp.indexOf(seed));
  });

  test("the ## Archive section is held back from the injected notebook", async () => {
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-notebook-archive";
    const { store, notebooks, project } = setup(spyId, (o) => {
      captured = o;
    });
    notebooks.upsert(
      project.id,
      "## Log\n- 2026-06-01: recent thing\n\n## Archive\n- 2026-01-01: ancient thing\n",
    );
    const conv = store.create({ providerId: spyId, projectId: project.id });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      projectNotebookStore: notebooks,
      abortSignal: new AbortController().signal,
    });

    const sp = captured!.systemPrompt!;
    expect(sp).toContain("recent thing");
    expect(sp).not.toContain("ancient thing");
    expect(sp).not.toContain("## Archive");
  });
});

describe("chat note_project tool wiring", () => {
  test("note_project is offered when a notebook store and project are present", async () => {
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-note-tool-present";
    const { store, notebooks, project } = setup(spyId, (o) => {
      captured = o;
    });
    const conv = store.create({ providerId: spyId, projectId: project.id });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      projectNotebookStore: notebooks,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.tools?.some((t) => t.name === "note_project")).toBe(true);
  });

  test("note_project is omitted when no notebook store is wired", async () => {
    let captured: SendQueryOptions | undefined;
    const spyId = "spy-note-tool-absent";
    const { store, project } = setup(spyId, (o) => {
      captured = o;
    });
    const conv = store.create({ providerId: spyId, projectId: project.id });

    await handleChatRequest(makeFrame(conv.id, spyId, "hi"), {
      send: () => {},
      store,
      abortSignal: new AbortController().signal,
    });

    expect(captured?.tools?.some((t) => t.name === "note_project") ?? false).toBe(false);
  });
});
