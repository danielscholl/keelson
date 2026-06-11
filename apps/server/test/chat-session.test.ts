// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  type ProviderCapabilities,
  type ProviderRegistration,
  registerProvider,
  type SendQueryOptions,
} from "@keelson/providers";
import { type ClientFrame, WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import { handleChatRequest } from "../src/chat-handler.ts";
import { type ConversationStore, createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";

function makeStore(): ConversationStore {
  return createConversationStore(openDatabase({ path: ":memory:" }));
}

function makeFrame(conversationId: string, providerId: string, prompt: string): ClientFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    message: { type: "request", providerId, prompt },
  };
}

// A provider that records the resumeSessionId it was handed and emits a fixed
// session id via onSessionId — the two halves of the multi-turn handshake.
function registerSessionProvider(
  id: string,
  sessionId: string | undefined,
  recordResume: (resume: string | undefined) => void,
): void {
  const capabilities: ProviderCapabilities = {
    sessionResume: true,
    streaming: true,
    tools: false,
    models: ["session-model"],
    defaultModel: "session-model",
  };
  const reg: ProviderRegistration = {
    id,
    displayName: `Session (${id})`,
    builtIn: false,
    capabilities,
    factory: () => ({
      getType: () => "session",
      getCapabilities: () => capabilities,
      listModels: async () => [{ id: "session-model" }],
      async *sendQuery(_prompt, _cwd, resume, options: SendQueryOptions | undefined) {
        recordResume(resume);
        if (sessionId !== undefined) options?.onSessionId?.(sessionId);
        yield { type: "text", content: "ok" };
      },
    }),
  };
  registerProvider(reg);
}

const noopDeps = () => ({ send: () => {}, abortSignal: new AbortController().signal });

// A provider that surfaces a session id and then trips the abort signal mid-turn,
// so the handler's loop bails before consuming the chunk it yields.
function registerAbortingProvider(
  id: string,
  sessionId: string,
  controller: AbortController,
): void {
  const capabilities: ProviderCapabilities = {
    sessionResume: true,
    streaming: true,
    tools: false,
    models: ["session-model"],
    defaultModel: "session-model",
  };
  registerProvider({
    id,
    displayName: `Aborting (${id})`,
    builtIn: false,
    capabilities,
    factory: () => ({
      getType: () => "session",
      getCapabilities: () => capabilities,
      listModels: async () => [{ id: "session-model" }],
      async *sendQuery(_prompt, _cwd, _resume, options: SendQueryOptions | undefined) {
        options?.onSessionId?.(sessionId);
        controller.abort();
        yield { type: "text", content: "partial" };
      },
    }),
  });
}

describe("chat session continuity", () => {
  test("persists the provider session id surfaced via onSessionId", async () => {
    const id = "session-persist";
    registerSessionProvider(id, "sess-A", () => {});
    const store = makeStore();
    const conv = store.create({ providerId: id });

    await handleChatRequest(makeFrame(conv.id, id, "hello"), { store, ...noopDeps() });

    expect(store.get(conv.id)?.providerSessionId).toBe("sess-A");
  });

  test("resumes with the stored session id on the next turn", async () => {
    const id = "session-resume";
    const resumes: Array<string | undefined> = [];
    registerSessionProvider(id, "sess-A", (r) => resumes.push(r));
    const store = makeStore();
    const conv = store.create({ providerId: id });

    await handleChatRequest(makeFrame(conv.id, id, "first"), { store, ...noopDeps() });
    await handleChatRequest(makeFrame(conv.id, id, "second"), { store, ...noopDeps() });

    // Turn 1 had nothing to resume; turn 2 resumes turn 1's session.
    expect(resumes).toEqual([undefined, "sess-A"]);
  });

  test("does not resume or overwrite the stored session across a provider switch", async () => {
    const provA = "session-switch-a";
    const provB = "session-switch-b";
    const resumesB: Array<string | undefined> = [];
    registerSessionProvider(provA, "sess-A", () => {});
    registerSessionProvider(provB, "sess-B", (r) => resumesB.push(r));

    const store = makeStore();
    const conv = store.create({ providerId: provA });

    // Turn 1 on provA stores its session id.
    await handleChatRequest(makeFrame(conv.id, provA, "first"), { store, ...noopDeps() });
    expect(store.get(conv.id)?.providerSessionId).toBe("sess-A");

    // Turn 2 swaps to provB: it must NOT receive provA's session id, and its
    // own id must NOT overwrite the one belonging to the conversation's provider.
    await handleChatRequest(makeFrame(conv.id, provB, "second"), { store, ...noopDeps() });
    expect(resumesB).toEqual([undefined]);
    expect(store.get(conv.id)?.providerSessionId).toBe("sess-A");
  });

  test("persists the session id even when the turn aborts after it is surfaced", async () => {
    const id = "session-abort";
    const controller = new AbortController();
    registerAbortingProvider(id, "sess-A", controller);
    const store = makeStore();
    const conv = store.create({ providerId: id });

    await handleChatRequest(makeFrame(conv.id, id, "hello"), {
      send: () => {},
      store,
      abortSignal: controller.signal,
    });

    // The turn aborted mid-stream, but the session it opened is resumable.
    expect(store.get(conv.id)?.providerSessionId).toBe("sess-A");
  });

  test("does not rewrite the session id when the provider echoes the same id", async () => {
    const id = "session-idempotent";
    registerSessionProvider(id, "sess-A", () => {});
    const store = makeStore();
    const conv = store.create({ providerId: id });

    let writes = 0;
    const realSet = store.setProviderSessionId.bind(store);
    store.setProviderSessionId = (cid, sid) => {
      writes += 1;
      realSet(cid, sid);
    };

    await handleChatRequest(makeFrame(conv.id, id, "first"), { store, ...noopDeps() });
    await handleChatRequest(makeFrame(conv.id, id, "second"), { store, ...noopDeps() });

    // Turn 1 writes; turn 2 sees the same id already stored and skips the write.
    expect(writes).toBe(1);
    expect(store.get(conv.id)?.providerSessionId).toBe("sess-A");
  });
});
