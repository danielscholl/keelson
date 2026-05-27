// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type RememberChatMessageResponse,
  rememberChatMessageRequestSchema,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
} from "@keelson/shared";
import type { Context, Hono } from "hono";
import type { ConversationStore } from "./conversation-store.ts";
import type { MemoryStore } from "./memory-store.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface ChatRememberRoutesDeps {
  conversationStore: ConversationStore;
  memoryStore: MemoryStore;
}

function internalErrorResponse(c: Context, scope: string, err: unknown) {
  console.warn(`[memory] ${scope} failed: ${err instanceof Error ? err.message : String(err)}`);
  return c.json({ error: "internal error" }, 500);
}

// SHA-256 of normalized (trimmed) content. The hash is the per-draft
// idempotency input for MemoryStore.writeback — recomputing it server-side
// guarantees the client can't desync its hash from the content the route
// actually persists. crypto.subtle is available under Bun's runtime.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function chatRememberRoutes(app: Hono, deps: ChatRememberRoutesDeps): void {
  const { conversationStore, memoryStore } = deps;

  // Same CSRF posture as memoryRoutes — irreversible enough that a missing
  // Origin (curl on loopback) is allowed but a foreign Origin is rejected.
  app.use("/api/chat/:cid/messages/:mid/remember", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  });

  app.post("/api/chat/:cid/messages/:mid/remember", async (c) => {
    const conversationId = c.req.param("cid");
    const messageId = c.req.param("mid");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = rememberChatMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const draft = parsed.data;
    const normalizedContent = draft.content.trim();
    if (normalizedContent.length === 0) {
      return c.json({ error: "content must not be blank" }, 400);
    }

    const conv = conversationStore.get(conversationId);
    if (!conv) {
      return c.json({ error: "conversation not found" }, 404);
    }
    const message = conv.messages.find((m) => m.id === messageId);
    if (!message) {
      return c.json({ error: "message not found" }, 404);
    }

    let contentHash: string;
    try {
      contentHash = await sha256Hex(normalizedContent);
    } catch (err) {
      return internalErrorResponse(c, "remember.hash", err);
    }

    const sourceRefUri = `conversation/${conversationId}/message/${messageId}`;
    // Inherit the conversation's projectId when the client omits one so saved
    // chat memories survive the project-scoped recall filter.
    const baseScope = draft.scope ?? { visibility: "project" as const };
    const scope =
      baseScope.projectId === undefined && conv.projectId !== undefined
        ? { ...baseScope, projectId: conv.projectId }
        : baseScope;

    try {
      const result = memoryStore.writeback({
        schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
        // Envelope idempotency — guards a double-submit of the modal from
        // producing two audit-event rows. The per-draft dedupe key is built
        // from contentHash below.
        idempotencyKey: `chat:${conversationId}:${messageId}:${contentHash}`,
        scope,
        task: {
          runtime: "chat",
          taskId: conversationId,
          ...(conv.providerId ? { provider: conv.providerId } : {}),
          ...(conv.model ? { model: conv.model } : {}),
        },
        memories: [
          {
            type: draft.type,
            summary: draft.summary,
            content: normalizedContent,
            contentHash,
            // Operator-observed; the review queue's Confirm action is what promotes to user_confirmed
            // and flips canUseAsInstruction — the evidence-default invariant.
            provenance: "observed",
            sourceRefs: [{ kind: "chat_message", uri: sourceRefUri }],
            artifacts: [],
            ...(draft.staleAfterDays !== undefined ? { staleAfterDays: draft.staleAfterDays } : {}),
          },
        ],
      });

      // The writeback response is a per-draft verdict array. We only sent one
      // draft, so exactly one of the three buckets carries the verdict.
      const written = result.written[0];
      if (written) {
        const payload: RememberChatMessageResponse = {
          status: "ok",
          memoryId: written.memoryId,
        };
        return c.json(payload);
      }
      const blocked = result.blocked[0];
      if (blocked) {
        const payload: RememberChatMessageResponse = {
          status: "blocked",
          reason: blocked.reason,
          summary: blocked.summary,
        };
        return c.json(payload);
      }
      const deduped = result.deduped[0];
      if (deduped) {
        const payload: RememberChatMessageResponse = {
          status: "deduped",
          memoryId: deduped.memoryId,
        };
        return c.json(payload);
      }
      // Shouldn't happen — writeback always reports something for each input
      // draft. If it does, surface as 500 rather than a silent success.
      return c.json({ error: "writeback returned no verdict" }, 500);
    } catch (err) {
      return internalErrorResponse(c, "remember.writeback", err);
    }
  });
}
