// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RememberChatMessageResponse } from "@keelson/shared";
import { Hono } from "hono";
import { chatRememberRoutes } from "../src/chat-remember-handler.ts";
import { type ConversationStore, createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createMemoryStore, type MemoryStore } from "../src/memory-store.ts";
import { rmTemp } from "./temp.ts";

const ORIGIN = "http://127.0.0.1:5173";

let tmpDir: string;
let db: Database;
let conversationStore: ConversationStore;
let memoryStore: MemoryStore;
let app: Hono;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-chat-remember-route-"));
  db = openDatabase({ path: join(tmpDir, "test.db") });
  conversationStore = createConversationStore(db);
  memoryStore = createMemoryStore(db);
  app = new Hono();
  chatRememberRoutes(app, { conversationStore, memoryStore });
});

afterEach(() => {
  db.close();
  rmTemp(tmpDir);
});

function postJson(path: string, body: unknown) {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

function seedConversationWithMessage(content: string): {
  conversationId: string;
  messageId: string;
} {
  const conv = conversationStore.create({ providerId: "stub", model: "test-model" });
  const messageId = crypto.randomUUID();
  conversationStore.appendMessage(conv.id, {
    id: messageId,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  });
  return { conversationId: conv.id, messageId };
}

describe("POST /api/chat/:cid/messages/:mid/remember", () => {
  test("persists a pending memory and returns memoryId", async () => {
    const { conversationId, messageId } = seedConversationWithMessage(
      "Always use `bun --filter` for workspace commands.",
    );

    const res = await app.fetch(
      postJson(`/api/chat/${conversationId}/messages/${messageId}/remember`, {
        type: "constraint",
        summary: "Workspace commands use bun --filter",
        content: "Always use `bun --filter` for workspace commands.",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RememberChatMessageResponse;
    expect(body.status).toBe("ok");
    if (body.status !== "ok") return;

    const stored = memoryStore.getById(body.memoryId);
    expect(stored?.summary).toBe("Workspace commands use bun --filter");
    expect(stored?.provenance).toBe("observed");
    expect(stored?.reviewStatus).toBe("pending");
    expect(stored?.usePolicy.canUseAsInstruction).toBe(false);
    expect(stored?.runtime).toBe("chat");
    expect(stored?.taskId).toBe(conversationId);
    expect(stored?.sourceRefs[0]?.kind).toBe("chat_message");
    expect(stored?.sourceRefs[0]?.uri).toBe(`conversation/${conversationId}/message/${messageId}`);
  });

  test("missing conversation returns 404", async () => {
    const res = await app.fetch(
      postJson("/api/chat/unknown-conv/messages/unknown-msg/remember", {
        type: "lesson",
        summary: "x",
        content: "y",
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("conversation not found");
  });

  test("missing message returns 404", async () => {
    const conv = conversationStore.create({ providerId: "stub" });
    const res = await app.fetch(
      postJson(`/api/chat/${conv.id}/messages/missing/remember`, {
        type: "lesson",
        summary: "x",
        content: "y",
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("message not found");
  });

  test("secret-shaped content is blocked by guardrails", async () => {
    const { conversationId, messageId } = seedConversationWithMessage(
      "AKIAIOSFODNN7EXAMPLE looks like an AWS key.",
    );
    const res = await app.fetch(
      postJson(`/api/chat/${conversationId}/messages/${messageId}/remember`, {
        type: "lesson",
        summary: "leaky",
        content: "AKIAIOSFODNN7EXAMPLE",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RememberChatMessageResponse;
    expect(body.status).toBe("blocked");
    if (body.status !== "blocked") return;
    expect(body.reason).toBe("potential_secret");
  });

  test("double-submit of identical content dedupes to the original memoryId", async () => {
    const { conversationId, messageId } = seedConversationWithMessage("noted");
    const payload = {
      type: "lesson" as const,
      summary: "summary",
      content: "noted",
    };
    const first = (await (
      await app.fetch(
        postJson(`/api/chat/${conversationId}/messages/${messageId}/remember`, payload),
      )
    ).json()) as RememberChatMessageResponse;
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const second = (await (
      await app.fetch(
        postJson(`/api/chat/${conversationId}/messages/${messageId}/remember`, payload),
      )
    ).json()) as RememberChatMessageResponse;
    expect(second.status).toBe("deduped");
    if (second.status !== "deduped") return;
    expect(second.memoryId).toBe(first.memoryId);
  });

  test("dedupes whitespace-only content variants and stores the normalized form", async () => {
    const { conversationId, messageId } = seedConversationWithMessage("noted");
    const first = (await (
      await app.fetch(
        postJson(`/api/chat/${conversationId}/messages/${messageId}/remember`, {
          type: "lesson",
          summary: "s",
          content: "noted",
        }),
      )
    ).json()) as RememberChatMessageResponse;
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const second = (await (
      await app.fetch(
        postJson(`/api/chat/${conversationId}/messages/${messageId}/remember`, {
          type: "lesson",
          summary: "s",
          content: "  noted  ",
        }),
      )
    ).json()) as RememberChatMessageResponse;
    expect(second.status).toBe("deduped");
    if (second.status !== "deduped") return;
    expect(second.memoryId).toBe(first.memoryId);

    const stored = memoryStore.getById(first.memoryId);
    expect(stored?.content).toBe("noted");
  });

  test("rejects malformed body with 400", async () => {
    const { conversationId, messageId } = seedConversationWithMessage("hi");
    const res = await app.fetch(
      postJson(`/api/chat/${conversationId}/messages/${messageId}/remember`, {
        type: "not_a_real_type",
        summary: "",
        content: "",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects foreign Origin with 403", async () => {
    const { conversationId, messageId } = seedConversationWithMessage("hi");
    const req = new Request(
      `http://test/api/chat/${conversationId}/messages/${messageId}/remember`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example.com",
        },
        body: JSON.stringify({ type: "lesson", summary: "x", content: "y" }),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
  });
});
