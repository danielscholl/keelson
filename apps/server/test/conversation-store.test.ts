// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@keelson/shared";
import { createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { rmTemp } from "./temp.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keelson-store-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmTemp(tmpDir);
});

function makeMessage(overrides: Partial<Message> = {}): Message {
  const base: Message = {
    id: overrides.id ?? crypto.randomUUID(),
    role: overrides.role ?? "user",
    content: overrides.content ?? "hi",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
  if (overrides.contentParts !== undefined) {
    base.contentParts = overrides.contentParts;
  }
  if (overrides.truncated !== undefined) {
    base.truncated = overrides.truncated;
  }
  return base;
}

describe("SQLite ConversationStore", () => {
  test("create + get + list", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);

    const a = store.create({ providerId: "stub", model: "alpha" });
    const b = store.create({ providerId: "stub" });

    const fetched = store.get(a.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(a.id);
    expect(fetched!.providerId).toBe("stub");
    expect(fetched!.model).toBe("alpha");
    expect(fetched!.messages).toEqual([]);
    expect(fetched!.providerSessionId).toBeUndefined();

    const all = store.list();
    expect(all.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(all[1].model).toBeUndefined();

    db.close();
  });

  test("getUsageTotals sums assistant-turn tokens and counts assistant turns", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    expect(store.getUsageTotals(conv.id)).toEqual({ totalTokens: 0, turns: 0 });

    store.appendMessage(conv.id, makeMessage({ role: "user", content: "hi" }));
    store.appendMessage(conv.id, {
      ...makeMessage({ role: "assistant", content: "a" }),
      usage: { inputTokens: 100, outputTokens: 40 },
    });
    store.appendMessage(conv.id, {
      ...makeMessage({ role: "assistant", content: "b" }),
      usage: { inputTokens: 200, outputTokens: 60 },
    });
    // An assistant turn that recorded no usage still counts as a turn; the user
    // message never does.
    store.appendMessage(conv.id, makeMessage({ role: "assistant", content: "c" }));

    expect(store.getUsageTotals(conv.id)).toEqual({ totalTokens: 400, turns: 3 });

    db.close();
  });

  test("list preserves insertion order when createdAt ties", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);

    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    for (const id of ids) store.create({ id, providerId: "stub" });

    const listed = store.list().map((c) => c.id);
    expect(listed).toEqual(ids);

    db.close();
  });

  test("appendMessage preserves order and bumps updatedAt", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);

    const conv = store.create({ providerId: "stub" });
    const m1 = makeMessage({ id: "m1", createdAt: "2026-01-01T00:00:00.000Z" });
    const m2 = makeMessage({
      id: "m2",
      role: "assistant",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const m3 = makeMessage({ id: "m3", createdAt: "2026-01-01T00:00:02.000Z" });

    store.appendMessage(conv.id, m1);
    store.appendMessage(conv.id, m2);
    store.appendMessage(conv.id, m3);

    const stored = store.get(conv.id)!;
    expect(stored.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(stored.messages[1].role).toBe("assistant");
    // updatedAt is monotonic but may equal createdAt when appends land in
    // the same millisecond as create (very fast tests).
    expect(stored.updatedAt!.localeCompare(stored.createdAt)).toBeGreaterThanOrEqual(0);

    db.close();
  });

  test("appendMessage to nonexistent conversation is silent", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);

    const real = store.create({ providerId: "stub" });
    expect(() => store.appendMessage("ghost-id", makeMessage())).not.toThrow();

    const stored = store.get(real.id)!;
    expect(stored.messages).toHaveLength(0);

    const count = (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
    expect(count).toBe(0);

    db.close();
  });

  test("setProviderSessionId stores and silently no-ops on unknown id", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);

    const conv = store.create({ providerId: "stub" });
    store.setProviderSessionId(conv.id, "sess-xyz");
    expect(store.get(conv.id)!.providerSessionId).toBe("sess-xyz");

    expect(() => store.setProviderSessionId("ghost-id", "sess-nope")).not.toThrow();

    db.close();
  });

  test("conversations and messages survive a handle close + reopen", () => {
    let convId: string;
    {
      const db1 = openDatabase({ path: dbPath });
      const s1 = createConversationStore(db1);
      const conv = s1.create({ providerId: "stub", model: "gpt-x" });
      convId = conv.id;
      s1.appendMessage(
        conv.id,
        makeMessage({ id: "m1", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" }),
      );
      s1.appendMessage(
        conv.id,
        makeMessage({
          id: "m2",
          role: "assistant",
          content: "yo",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      s1.setProviderSessionId(conv.id, "sess-xyz");
      db1.close();
    }

    const db2 = openDatabase({ path: dbPath });
    const s2 = createConversationStore(db2);
    const all = s2.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(convId);
    expect(all[0].providerId).toBe("stub");
    expect(all[0].model).toBe("gpt-x");
    expect(all[0].providerSessionId).toBe("sess-xyz");
    expect(all[0].messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(all[0].messages[1].content).toBe("yo");
    db2.close();
  });

  test("migrations are idempotent across opens", () => {
    const db1 = openDatabase({ path: dbPath });
    db1.close();
    const db2 = openDatabase({ path: dbPath });
    const versions = db2
      .query("SELECT version FROM schema_version ORDER BY version ASC")
      .all() as Array<{ version: number }>;
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    db2.close();
  });

  test("create defaults name to undefined", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    expect(conv.name).toBeUndefined();
    expect(store.get(conv.id)!.name).toBeUndefined();
    db.close();
  });

  test("create with name persists it (no first-prompt auto-derive needed)", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub", name: "Features" });
    expect(conv.name).toBe("Features");
    expect(store.get(conv.id)!.name).toBe("Features");
    db.close();
  });

  test("seedSystemPrompt round-trips through create + get + list + reopen", () => {
    const seed = "## Features snapshot\n\nPulse: 3 critical, 7 stalled.";
    let convId: string;
    {
      const db1 = openDatabase({ path: dbPath });
      const s1 = createConversationStore(db1);
      const plain = s1.create({ providerId: "stub" });
      expect(plain.seedSystemPrompt).toBeUndefined();

      const seeded = s1.create({ providerId: "stub", seedSystemPrompt: seed });
      convId = seeded.id;
      expect(seeded.seedSystemPrompt).toBe(seed);

      expect(s1.get(seeded.id)!.seedSystemPrompt).toBe(seed);
      expect(s1.get(plain.id)!.seedSystemPrompt).toBeUndefined();

      const listed = s1.list();
      const fromList = listed.find((c) => c.id === seeded.id)!;
      expect(fromList.seedSystemPrompt).toBe(seed);
      db1.close();
    }

    const db2 = openDatabase({ path: dbPath });
    const s2 = createConversationStore(db2);
    expect(s2.get(convId)!.seedSystemPrompt).toBe(seed);
    db2.close();
  });

  test("update sets name and bumps updatedAt", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    const before = store.get(conv.id)!.updatedAt!;
    // Force at least 1ms gap so the touch is observable.
    const start = Date.now();
    while (Date.now() === start) {
      // spin briefly
    }
    const updated = store.update(conv.id, { name: "Renamed" });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.updatedAt!.localeCompare(before)).toBeGreaterThan(0);

    const refetched = store.get(conv.id)!;
    expect(refetched.name).toBe("Renamed");
    db.close();
  });

  test("update with explicit null clears name", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    store.update(conv.id, { name: "First" });
    expect(store.get(conv.id)!.name).toBe("First");
    const cleared = store.update(conv.id, { name: null });
    expect(cleared).toBeDefined();
    expect(cleared!.name).toBeUndefined();
    db.close();
  });

  test("update returns undefined for unknown id", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    expect(store.update("ghost-id", { name: "x" })).toBeUndefined();
    db.close();
  });

  test("delete removes conversation and cascades messages", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    store.appendMessage(conv.id, makeMessage({ id: "m1" }));
    store.appendMessage(conv.id, makeMessage({ id: "m2", role: "assistant" }));

    expect(store.delete(conv.id)).toBe(true);
    expect(store.get(conv.id)).toBeUndefined();

    const remaining = (
      db.query("SELECT COUNT(*) AS c FROM messages WHERE conversationId = ?").get(conv.id) as {
        c: number;
      }
    ).c;
    expect(remaining).toBe(0);
    db.close();
  });

  test("delete returns false for unknown id", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    expect(store.delete("ghost-id")).toBe(false);
    db.close();
  });

  test("appendMessage persists contentParts and get rehydrates them", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    const structured = makeMessage({
      id: "m1",
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
        {
          type: "tool_result",
          toolUseId: "call_1",
          content: "export const x = 1;",
        },
      ],
    });
    store.appendMessage(conv.id, structured);

    const stored = store.get(conv.id)!;
    expect(stored.messages).toHaveLength(1);
    const m = stored.messages[0];
    expect(m.content).toBe("Reading /foo.ts then summarizing.");
    expect(m.contentParts).toHaveLength(3);
    expect(m.contentParts?.[1]?.type).toBe("tool_use");
    if (m.contentParts?.[1]?.type === "tool_use") {
      expect(m.contentParts[1].id).toBe("call_1");
    }
    db.close();
  });

  test("messages without contentParts return contentParts: undefined", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    store.appendMessage(conv.id, makeMessage({ id: "m1", content: "plain text" }));

    const stored = store.get(conv.id)!;
    expect(stored.messages[0].content).toBe("plain text");
    expect(stored.messages[0].contentParts).toBeUndefined();
    db.close();
  });

  test("malformed content_parts JSON degrades to undefined without throwing", () => {
    // Write a bad JSON blob directly via the raw DB handle to simulate
    // corrupted data, then assert hydration falls back to undefined.
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    db.prepare(
      "INSERT INTO messages(id, conversationId, role, content, content_parts, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("m1", conv.id, "assistant", "fallback", "not-valid-json", new Date().toISOString());

    const stored = store.get(conv.id)!;
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0].content).toBe("fallback");
    expect(stored.messages[0].contentParts).toBeUndefined();
    db.close();
  });

  test("non-array content_parts JSON degrades to undefined", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    db.prepare(
      "INSERT INTO messages(id, conversationId, role, content, content_parts, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "m1",
      conv.id,
      "assistant",
      "x",
      JSON.stringify({ not: "an array" }),
      new Date().toISOString(),
    );
    const stored = store.get(conv.id)!;
    expect(stored.messages[0].contentParts).toBeUndefined();
    db.close();
  });

  test("F10.7b: truncated:true round-trips; absence is back-compat", () => {
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    store.appendMessage(
      conv.id,
      makeMessage({ id: "m1", role: "assistant", content: "partial", truncated: true }),
    );
    store.appendMessage(conv.id, makeMessage({ id: "m2", role: "assistant", content: "complete" }));

    const stored = store.get(conv.id)!;
    expect(stored.messages[0].truncated).toBe(true);
    expect(stored.messages[1].truncated).toBeUndefined();
    db.close();
  });

  test("F10.7b: legacy rows without truncated column hydrate cleanly", () => {
    // Simulate a row that pre-dates the v4 migration by writing through the
    // raw DB with the old 6-arg INSERT shape. The migration's DEFAULT 0 fills
    // truncated; rowToMessage maps 0 → undefined so legacy turns render the
    // same as any cleanly-completed turn.
    const db = openDatabase({ path: dbPath });
    const store = createConversationStore(db);
    const conv = store.create({ providerId: "stub" });
    db.prepare(
      "INSERT INTO messages(id, conversationId, role, content, content_parts, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("legacy-1", conv.id, "assistant", "old turn", null, new Date().toISOString());

    const stored = store.get(conv.id)!;
    expect(stored.messages[0].content).toBe("old turn");
    expect(stored.messages[0].truncated).toBeUndefined();
    db.close();
  });
});
