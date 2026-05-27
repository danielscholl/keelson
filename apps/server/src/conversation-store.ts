// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Database } from "bun:sqlite";
import type {
  ContentBlock,
  Conversation,
  ConversationWorkflowProjection,
  Message,
  WorkflowRunStatus,
} from "@keelson/shared";

export interface CreateConversationInput {
  id?: string;
  providerId: string;
  model?: string;
  seedSystemPrompt?: string;
  name?: string;
}

// Patch shape for `update()`. Each key is optional so callers only pay for
// the fields they're touching. `name` accepts an explicit `null` so the
// caller can clear the name back to the "Untitled" placeholder, distinct
// from omitting the key (no-op). `model` is non-null because there's no
// "unset" affordance in the UI — the picker always selects a concrete id.
export interface UpdateConversationPatch {
  name?: string | null;
  model?: string;
}

export interface ConversationStore {
  get(id: string): Conversation | undefined;
  list(): Conversation[];
  create(input: CreateConversationInput): Conversation;
  appendMessage(id: string, message: Message): void;
  setProviderSessionId(id: string, sessionId: string): void;
  update(id: string, patch: UpdateConversationPatch): Conversation | undefined;
  delete(id: string): boolean;
}

interface ConvRow {
  id: string;
  providerId: string;
  model: string | null;
  providerSessionId: string | null;
  name: string | null;
  seedSystemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  // Populated by the LEFT JOIN against workflow_runs in list/get. NULL for
  // ordinary chat conversations and for workflow conversations whose run row
  // has been deleted (FK SET NULL via DELETE cascade).
  workflow_run_id: string | null;
  workflow_name: string | null;
  workflow_status: string | null;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  content_parts: string | null;
  truncated: number | null;
  createdAt: string;
}

// Hydrate the JSON-serialized content_parts column. Degrades to undefined on
// parse failure rather than throwing — a malformed row is logged and the
// caller falls back to the denormalized `content` string. This preserves
// the "load existing conversations" path even if a write path elsewhere
// stored bad JSON (which shouldn't happen, but the cost of defending is one
// try/catch).
function parseContentParts(raw: string | null): ContentBlock[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed as ContentBlock[];
  } catch (err) {
    console.warn(
      `[keelson] failed to parse messages.content_parts JSON; falling back to content string. (${err instanceof Error ? err.message : String(err)})`,
    );
    return undefined;
  }
}

function rowToMessage(row: MessageRow): Message {
  const parts = parseContentParts(row.content_parts);
  const msg: Message = {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  };
  if (parts !== undefined) msg.contentParts = parts;
  if (row.truncated !== null && row.truncated > 0) msg.truncated = true;
  return msg;
}

// Conservative coercion — projection only flows when JOIN returned all three
// run columns AND the status string matches the durable enum. Anything else
// surfaces as `undefined` (chat conversation) rather than a malformed row.
function workflowProjection(row: ConvRow): ConversationWorkflowProjection | undefined {
  if (row.workflow_run_id === null || row.workflow_name === null || row.workflow_status === null) {
    return undefined;
  }
  const status = row.workflow_status;
  if (
    status !== "running" &&
    status !== "paused" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    return undefined;
  }
  return {
    runId: row.workflow_run_id,
    workflowName: row.workflow_name,
    status: status as WorkflowRunStatus,
  };
}

function rowToConversation(row: ConvRow, messages: Message[]): Conversation {
  const conv: Conversation = {
    id: row.id,
    providerId: row.providerId,
    model: row.model ?? undefined,
    providerSessionId: row.providerSessionId ?? undefined,
    name: row.name ?? undefined,
    seedSystemPrompt: row.seedSystemPrompt ?? undefined,
    messages,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  const workflow = workflowProjection(row);
  if (workflow) conv.workflow = workflow;
  return conv;
}

export function createConversationStore(db: Database): ConversationStore {
  const insertConv = db.prepare(
    "INSERT INTO conversations(id, providerId, model, providerSessionId, name, seedSystemPrompt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // `*` plus the JOINed workflow columns — kept aliased so ConvRow's typed
  // shape matches the projection regardless of column order.
  const convSelectColumns = `
    c.id, c.providerId, c.model, c.providerSessionId, c.name,
    c.seedSystemPrompt, c.createdAt, c.updatedAt,
    w.id AS workflow_run_id,
    w.workflow_name AS workflow_name,
    w.status AS workflow_status
  `;
  const selectConv = db.prepare(
    `SELECT ${convSelectColumns}
       FROM conversations c
       LEFT JOIN workflow_runs w ON w.conversation_id = c.id
      WHERE c.id = ?`,
  );
  // rowid tiebreak preserves insertion order when two conversations share a
  // createdAt millisecond — without it, SQLite is free to return tied rows
  // in any order and `/api/conversations` ordering would drift.
  const listConv = db.prepare(
    `SELECT ${convSelectColumns}
       FROM conversations c
       LEFT JOIN workflow_runs w ON w.conversation_id = c.id
      ORDER BY c.createdAt ASC, c.rowid ASC`,
  );
  // Order by rowid (insertion order) so messages inserted within the same
  // millisecond preserve insertion order — UUID-id tiebreak would shuffle them.
  const selectMessages = db.prepare(
    "SELECT id, role, content, content_parts, truncated, createdAt FROM messages WHERE conversationId = ? ORDER BY rowid ASC",
  );
  // Batched IN(?,?,...) hydration for list(); arity varies so it can't be
  // pre-compiled. conversationId returned alongside the message columns so
  // results can be grouped without a second lookup.
  function fetchMessagesByConvIds(ids: string[]): Map<string, Message[]> {
    const groups = new Map<string, Message[]>();
    for (const id of ids) groups.set(id, []);
    if (ids.length === 0) return groups;
    // Chunked so the IN(?,…) parameter count never approaches SQLite's variable-count limit.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, role, content, content_parts, truncated, createdAt, conversationId
             FROM messages
            WHERE conversationId IN (${placeholders})
            ORDER BY conversationId, rowid ASC`,
        )
        .all(...chunk) as (MessageRow & { conversationId: string })[];
      for (const row of rows) {
        const list = groups.get(row.conversationId);
        if (list) list.push(rowToMessage(row));
      }
    }
    return groups;
  }
  const insertMsg = db.prepare(
    "INSERT INTO messages(id, conversationId, role, content, content_parts, truncated, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const touchConv = db.prepare("UPDATE conversations SET updatedAt = ? WHERE id = ?");
  const setSession = db.prepare("UPDATE conversations SET providerSessionId = ? WHERE id = ?");
  const setName = db.prepare("UPDATE conversations SET name = ?, updatedAt = ? WHERE id = ?");
  const setModel = db.prepare("UPDATE conversations SET model = ?, updatedAt = ? WHERE id = ?");
  // Messages cascade via the FK ON DELETE CASCADE on the messages table —
  // PRAGMA foreign_keys is enabled at openDatabase().
  const deleteConv = db.prepare("DELETE FROM conversations WHERE id = ?");

  return {
    get(id) {
      const row = selectConv.get(id) as ConvRow | null;
      if (!row) return undefined;
      const messages = (selectMessages.all(id) as MessageRow[]).map(rowToMessage);
      return rowToConversation(row, messages);
    },
    list() {
      const rows = listConv.all() as ConvRow[];
      const messagesByConv = fetchMessagesByConvIds(rows.map((r) => r.id));
      return rows.map((row) => rowToConversation(row, messagesByConv.get(row.id) ?? []));
    },
    create(input) {
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      insertConv.run(
        id,
        input.providerId,
        input.model ?? null,
        null,
        input.name ?? null,
        input.seedSystemPrompt ?? null,
        now,
        now,
      );
      return {
        id,
        providerId: input.providerId,
        model: input.model,
        name: input.name,
        seedSystemPrompt: input.seedSystemPrompt,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    appendMessage(id, message) {
      db.transaction(() => {
        const conv = selectConv.get(id) as ConvRow | null;
        if (!conv) return;
        const partsJson =
          message.contentParts !== undefined ? JSON.stringify(message.contentParts) : null;
        insertMsg.run(
          message.id,
          id,
          message.role,
          message.content,
          partsJson,
          message.truncated ? 1 : 0,
          message.createdAt,
        );
        touchConv.run(new Date().toISOString(), id);
      })();
    },
    setProviderSessionId(id, sessionId) {
      const conv = selectConv.get(id) as ConvRow | null;
      if (!conv) return;
      setSession.run(sessionId, id);
    },
    update(id, patch) {
      // Returns the post-update conversation so callers can echo it on PATCH;
      // returns undefined when the row doesn't exist (404 path).
      const existing = selectConv.get(id) as ConvRow | null;
      if (!existing) return undefined;
      const now = new Date().toISOString();
      if (Object.hasOwn(patch, "name")) {
        setName.run(patch.name ?? null, now, id);
      }
      if (patch.model !== undefined) {
        setModel.run(patch.model, now, id);
      }
      const refreshed = selectConv.get(id) as ConvRow | null;
      if (!refreshed) return undefined;
      const messages = (selectMessages.all(id) as MessageRow[]).map(rowToMessage);
      return rowToConversation(refreshed, messages);
    },
    delete(id) {
      const result = deleteConv.run(id);
      // bun:sqlite's RunResult exposes `changes` on the result object.
      return (result.changes ?? 0) > 0;
    },
  };
}
