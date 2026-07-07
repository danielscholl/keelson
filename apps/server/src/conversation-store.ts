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
import {
  canvasArtifactKey,
  canvasArtifactSlugSchema,
  parsePersistedTokenUsage,
} from "@keelson/shared";

export interface CreateConversationInput {
  id?: string;
  providerId: string;
  model?: string;
  seedSystemPrompt?: string;
  name?: string;
  projectId?: string;
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
  // `provider`/`model` are persisted on the row but never round-tripped onto
  // the wire `Message` type — they're server-internal provenance, not part of
  // the chat wire schema.
  appendMessage(id: string, message: Message, provenance?: MessageProvenance): void;
  setProviderSessionId(id: string, sessionId: string): void;
  update(id: string, patch: UpdateConversationPatch): Conversation | undefined;
  delete(id: string): boolean;
  // Accumulated assistant-turn spend for one conversation: the count of
  // assistant messages (`turns`) and the sum of their input+output tokens
  // (`totalTokens`). Backs the request-phase budget gate without loading full
  // message bodies.
  getUsageTotals(id: string): { totalTokens: number; turns: number };
}

export interface ConversationStoreDeps {
  onArtifactsOrphaned?: (slugs: string[]) => void;
}

// Provider/model provenance for one assistant row. Kept out of the wire
// `Message` type (see appendMessage) so persisting it can't accidentally
// widen SCHEMA_VERSION.
export interface MessageProvenance {
  provider?: string;
  model?: string;
}

interface ConvRow {
  id: string;
  providerId: string;
  model: string | null;
  providerSessionId: string | null;
  name: string | null;
  seedSystemPrompt: string | null;
  project_id: string | null;
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
  usage_json: string | null;
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

function parsePublishResultSlug(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("slug" in parsed) ||
    typeof parsed.slug !== "string"
  ) {
    return undefined;
  }
  return canvasArtifactSlugSchema.safeParse(parsed.slug).success ? parsed.slug : undefined;
}

function publishedCanvasSlugs(parts: ContentBlock[]): string[] {
  const toolNames = new Map<string, string>();
  for (const part of parts) {
    if (part.type === "tool_use") toolNames.set(part.id, part.toolName);
  }
  const slugs = new Set<string>();
  for (const part of parts) {
    if (
      part.type !== "tool_result" ||
      part.isError === true ||
      toolNames.get(part.toolUseId) !== "canvas_publish"
    ) {
      continue;
    }
    const slug = parsePublishResultSlug(part.content);
    if (slug !== undefined) slugs.add(slug);
  }
  return Array.from(slugs);
}

function publishedCanvasSlugsFromRows(rows: Array<{ content_parts: string | null }>): string[] {
  const slugs = new Set<string>();
  for (const row of rows) {
    const parts = parseContentParts(row.content_parts);
    if (parts === undefined) continue;
    for (const slug of publishedCanvasSlugs(parts)) slugs.add(slug);
  }
  return Array.from(slugs);
}

function rowToMessage(row: MessageRow): Message {
  const parts = parseContentParts(row.content_parts);
  const usage = parsePersistedTokenUsage(row.usage_json);
  const msg: Message = {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  };
  if (parts !== undefined) msg.contentParts = parts;
  if (row.truncated !== null && row.truncated > 0) msg.truncated = true;
  if (usage !== undefined) msg.usage = usage;
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
  if (row.project_id !== null) conv.projectId = row.project_id;
  const workflow = workflowProjection(row);
  if (workflow) conv.workflow = workflow;
  return conv;
}

export function createConversationStore(
  db: Database,
  deps: ConversationStoreDeps = {},
): ConversationStore {
  const insertConv = db.prepare(
    "INSERT INTO conversations(id, providerId, model, providerSessionId, name, seedSystemPrompt, project_id, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const convSelectColumns = `
    c.id, c.providerId, c.model, c.providerSessionId, c.name,
    c.seedSystemPrompt, c.project_id, c.createdAt, c.updatedAt,
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
    "SELECT id, role, content, content_parts, truncated, usage_json, createdAt FROM messages WHERE conversationId = ? ORDER BY rowid ASC",
  );
  const selectContentParts = db.prepare(
    "SELECT content_parts FROM messages WHERE conversationId = ? ORDER BY rowid ASC",
  );
  const selectOtherContentPartsByArtifact = db.prepare(
    "SELECT content_parts FROM messages WHERE conversationId != ? AND content_parts LIKE ?",
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
          `SELECT id, role, content, content_parts, truncated, usage_json, createdAt, conversationId
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
    "INSERT INTO messages(id, conversationId, role, content, content_parts, truncated, usage_json, provider, model, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // Usage rides as JSON in usage_json, so the sum is done in JS over the
  // assistant rows rather than in SQL. Selects only the JSON column.
  const selectAssistantUsage = db.prepare(
    "SELECT usage_json FROM messages WHERE conversationId = ? AND role = 'assistant'",
  );
  const touchConv = db.prepare("UPDATE conversations SET updatedAt = ? WHERE id = ?");
  const setSession = db.prepare("UPDATE conversations SET providerSessionId = ? WHERE id = ?");
  const setName = db.prepare("UPDATE conversations SET name = ?, updatedAt = ? WHERE id = ?");
  const setModel = db.prepare("UPDATE conversations SET model = ?, updatedAt = ? WHERE id = ?");
  // Messages cascade via the FK ON DELETE CASCADE on the messages table —
  // PRAGMA foreign_keys is enabled at openDatabase().
  const deleteConv = db.prepare("DELETE FROM conversations WHERE id = ?");
  const deleteConversation = db.transaction(
    (id: string): { deleted: boolean; orphaned: string[] } => {
      const existing = selectConv.get(id) as ConvRow | null;
      if (!existing) return { deleted: false, orphaned: [] };

      const ownedSlugs = publishedCanvasSlugsFromRows(
        selectContentParts.all(id) as Array<{ content_parts: string | null }>,
      );
      const orphaned: string[] = [];
      for (const slug of ownedSlugs) {
        const candidates = selectOtherContentPartsByArtifact.all(
          id,
          `%${canvasArtifactKey(slug)}%`,
        ) as Array<{ content_parts: string | null }>;
        const stillPublished = publishedCanvasSlugsFromRows(candidates).includes(slug);
        if (!stillPublished) orphaned.push(slug);
      }

      const result = deleteConv.run(id);
      return { deleted: (result.changes ?? 0) > 0, orphaned };
    },
  );

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
        input.projectId ?? null,
        now,
        now,
      );
      const conv: Conversation = {
        id,
        providerId: input.providerId,
        model: input.model,
        name: input.name,
        seedSystemPrompt: input.seedSystemPrompt,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      if (input.projectId !== undefined) conv.projectId = input.projectId;
      return conv;
    },
    appendMessage(id, message, provenance) {
      db.transaction(() => {
        const conv = selectConv.get(id) as ConvRow | null;
        if (!conv) return;
        const partsJson =
          message.contentParts !== undefined ? JSON.stringify(message.contentParts) : null;
        const usageJson = message.usage !== undefined ? JSON.stringify(message.usage) : null;
        insertMsg.run(
          message.id,
          id,
          message.role,
          message.content,
          partsJson,
          message.truncated ? 1 : 0,
          usageJson,
          provenance?.provider ?? null,
          provenance?.model ?? null,
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
      const { deleted, orphaned } = deleteConversation(id);
      if (!deleted) return false;
      if (orphaned.length > 0) deps.onArtifactsOrphaned?.(orphaned);
      return true;
    },
    getUsageTotals(id) {
      const rows = selectAssistantUsage.all(id) as { usage_json: string | null }[];
      let totalTokens = 0;
      for (const row of rows) {
        const usage = parsePersistedTokenUsage(row.usage_json);
        if (usage !== undefined) totalTokens += usage.inputTokens + usage.outputTokens;
      }
      return { totalTokens, turns: rows.length };
    },
  };
}
