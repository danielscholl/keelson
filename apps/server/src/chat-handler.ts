// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { Hono } from "hono";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";
import {
  WIRE_PROTOCOL_VERSION,
  chatFrameSchema,
  clientFrameSchema,
  inferToolFamily,
  modelInfoSchema,
  registeredToolInfoSchema,
  renameConversationBodySchema,
  type ChatFrame,
  type ClientFrame,
  type MessageChunk,
} from "@keelson/shared";
import {
  UnknownProviderError,
  getAgentProvider,
  getProviderInfoList,
  isRegisteredProvider,
} from "@keelson/providers";
import { getRegisteredTools } from "@keelson/skills";
import type { ConversationStore } from "./conversation-store.ts";
import { createContentPartsAccumulator } from "./content-parts.ts";
import type { WorkflowStore } from "./workflow-store.ts";
import type { ActiveRuns } from "./workflows-handler.ts";
import { purgeWorkflowRun } from "./workflows-handler.ts";

export interface ChatRoutesWorkflowDeps {
  workflowStore: WorkflowStore;
  activeRuns: ActiveRuns;
}

// Any port allowed because Vite shifts to 5174/5175/… when 5173 is busy;
// hard-coding the dev port breaks /api/db/reset etc. in that case.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (!origin.startsWith("http://")) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(url.hostname);
}

// Discriminated by `kind` so the single Bun.serve `websocket` field can
// route chat and workflow-run frames.
export interface WsData {
  abort: AbortController;
  kind?: "chat" | "workflowRun";
  // Set on workflowRun upgrades so the per-runId subscriber set can be looked
  // up at message/close time.
  runId?: string;
}

const createConversationBodySchema = z
  .object({
    providerId: z.string(),
    model: z.string().optional(),
    // Defensive ceiling — lane primers target ~1–2KB; 8KB blocks
    // pathological seeds before they hit the model's context.
    seedSystemPrompt: z.string().min(1).max(8000).optional(),
    // Pre-set sidebar title. When provided, the first-prompt auto-derive
    // in the chat-turn handler is short-circuited.
    name: z.string().min(1).max(80).optional(),
  })
  .strict();

// Parse-at-the-edges so a provider drifting from modelInfoSchema surfaces
// as a visible 500, not silent picker metadata corruption.
const modelsResponseSchema = z.array(modelInfoSchema);

const toolsResponseSchema = z.array(registeredToolInfoSchema);

export function chatRoutes(
  app: Hono,
  store: ConversationStore,
  workflowDeps: ChatRoutesWorkflowDeps,
): void {
  app.get("/api/providers", (c) =>
    c.json({ providers: getProviderInfoList() }),
  );

  // Picker calls this on provider select. Providers never throw — signed-out
  // states return their curated fallback — so this just propagates.
  app.get("/api/providers/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!isRegisteredProvider(id)) {
      return c.json({ error: `unknown provider '${id}'` }, 404);
    }
    try {
      const provider = getAgentProvider(id);
      const models = modelsResponseSchema.parse(await provider.listModels());
      return c.json({ models });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // Snapshot of tools registered at boot; per-conversation filtering TBD.
  app.get("/api/tools", (c) => {
    const tools = getRegisteredTools().map((t) => ({
      name: t.name,
      description: t.description,
      family: inferToolFamily(t.name),
      state_changing: t.state_changing ?? false,
      requires_confirmation: t.requires_confirmation ?? false,
    }));
    return c.json({ tools: toolsResponseSchema.parse(tools) });
  });

  app.get("/api/conversations", (c) =>
    // Workflow conversations (Phase 4 W4.5) persist for run history but are
    // surfaced only via the Workflows tab; hide them from the chat sidebar so
    // the two mental models stay separated.
    c.json({
      conversations: store
        .list()
        .filter((conv) => conv.providerId !== "workflow"),
    }),
  );

  app.post("/api/conversations", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = createConversationBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    if (!isRegisteredProvider(parsed.data.providerId)) {
      return c.json(
        { error: `unknown provider '${parsed.data.providerId}'` },
        400,
      );
    }
    // The synthetic `workflow` provider is registered for run-as-conversation
    // (Phase 4 W4.5) but is non-chat. Reject manual creation so a stray client
    // can't allocate a row that the chat surface will then try to send turns
    // through (the provider's sendQuery throws on use).
    if (parsed.data.providerId === "workflow") {
      return c.json(
        {
          error:
            "workflow conversations are created via POST /api/workflows/:name/runs",
        },
        400,
      );
    }
    const conv = store.create(parsed.data);
    return c.json(conv, 201);
  });

  app.get("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    const conv = store.get(id);
    if (!conv) {
      return c.json({ error: `unknown conversation '${id}'` }, 404);
    }
    return c.json(conv);
  });

  app.patch("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const parsed = renameConversationBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const updated = store.update(id, { name: parsed.data.name });
    if (!updated) {
      return c.json({ error: `unknown conversation '${id}'` }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    // Purge the linked run BEFORE deleting the conversation — the FK is
    // SET NULL, so the reverse order would orphan the run row in Workflows.
    const linkedRunId = workflowDeps.workflowStore.getRunIdByConversationId(id);
    if (linkedRunId !== null) {
      await purgeWorkflowRun({
        runId: linkedRunId,
        store: workflowDeps.workflowStore,
        activeRuns: workflowDeps.activeRuns,
      });
    }
    const removed = store.delete(id);
    if (!removed) {
      return c.json({ error: `unknown conversation '${id}'` }, 404);
    }
    return c.body(null, 204);
  });
}

// Returns undefined for whitespace-only prompts so the caller skips writing.
export function deriveConversationName(prompt: string): string | undefined {
  const cleaned = prompt.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return undefined;
  const MAX = 60;
  return cleaned.length <= MAX ? cleaned : cleaned.slice(0, MAX - 1) + "…";
}

export function handleChatUpgrade(
  req: Request,
  server: Server<WsData>,
): Response | undefined {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new Response("forbidden origin", { status: 403 });
  }
  const data: WsData = { abort: new AbortController(), kind: "chat" };
  const ok = server.upgrade(req, { data });
  if (ok) return undefined;
  return new Response("expected websocket", { status: 426 });
}

export function chatWebSocketHandlers(
  store: ConversationStore,
): WebSocketHandler<WsData> {
  return {
    open(_ws) {},
    async message(ws, raw) {
      const text =
        typeof raw === "string"
          ? raw
          : new TextDecoder().decode(raw as ArrayBuffer | ArrayBufferView);
      let frame: ClientFrame;
      try {
        frame = clientFrameSchema.parse(JSON.parse(text));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendFrame(ws, errorFrame("", `invalid frame: ${msg}`, "PARSE_ERROR"));
        ws.close(1008, "invalid frame");
        return;
      }
      await handleChatRequest(frame, {
        send: (out) => sendFrame(ws, out),
        store,
        abortSignal: ws.data.abort.signal,
      });
    },
    close(ws) {
      ws.data.abort.abort();
    },
  };
}

export interface ChatDeps {
  send: (frame: ChatFrame) => void;
  store: ConversationStore;
  abortSignal: AbortSignal;
}

export async function handleChatRequest(
  frame: ClientFrame,
  deps: ChatDeps,
): Promise<void> {
  const { conversationId } = frame;
  const message = frame.message;
  if (message.type !== "request") return;

  const conv = deps.store.get(conversationId);
  if (!conv) {
    deps.send(
      errorFrame(
        conversationId,
        `unknown conversation '${conversationId}'`,
        "UNKNOWN_CONVERSATION",
      ),
    );
    deps.send(doneFrame(conversationId));
    return;
  }
  // Refuse chat turns against workflow-linked conversations. The UI disables
  // the composer for these in v1 (W4.6 will lift that for HITL approval, but
  // through POST /api/workflows/runs/:runId/resume, not this WS path).
  if (conv.providerId === "workflow") {
    deps.send(
      errorFrame(
        conversationId,
        "workflow conversations are read-only; use POST /api/workflows/runs/:runId/resume",
        "WORKFLOW_CONVERSATION_READONLY",
      ),
    );
    deps.send(doneFrame(conversationId));
    return;
  }

  // Record the user prompt immediately so it survives provider failures.
  // Assistant message persists in the finally block; aborted/errored turns
  // get `truncated: true` so the UI marks them on reload.
  deps.store.appendMessage(conversationId, {
    id: crypto.randomUUID(),
    role: "user",
    content: message.prompt,
    createdAt: new Date().toISOString(),
  });

  // Auto-name from first user prompt; PATCH-set `name` wins over auto-derive.
  if (conv.name === undefined) {
    const derived = deriveConversationName(message.prompt);
    if (derived) {
      deps.store.update(conversationId, { name: derived });
    }
  }

  // Mirror per-turn model swaps onto the stored row so hydration / sidebar /
  // next-turn fallback see the most recent id.
  if (message.model && message.model !== conv.model) {
    deps.store.update(conversationId, { model: message.model });
  }

  if (!isRegisteredProvider(message.providerId)) {
    deps.send(
      errorFrame(
        conversationId,
        `unknown provider '${message.providerId}'`,
        "UNKNOWN_PROVIDER",
      ),
    );
    deps.send(doneFrame(conversationId));
    return;
  }

  let provider;
  try {
    provider = getAgentProvider(message.providerId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof UnknownProviderError ? "UNKNOWN_PROVIDER" : "PROVIDER_ERROR";
    deps.send(errorFrame(conversationId, msg, code));
    deps.send(doneFrame(conversationId));
    return;
  }

  // Structured projection alongside the denormalized text so the message can
  // be replayed on reload. Text chunks fold into one Anthropic-style block;
  // tool_use / tool_result become their own. Thinking chunks excluded.
  const acc = createContentPartsAccumulator();
  let streamFailed = false;

  // v1 sends every registered tool; per-conversation filtering TBD.
  const tools = getRegisteredTools();

  const systemPromptParts = [conv.seedSystemPrompt].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const systemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

  try {
    for await (const chunk of provider.sendQuery(
      message.prompt,
      process.cwd(),
      conv.providerSessionId,
      {
        model: message.model ?? conv.model,
        abortSignal: deps.abortSignal,
        // Omit unset fields so providers see their SDK defaults.
        ...(message.thinking !== undefined
          ? { thinking: message.thinking }
          : {}),
        ...(message.reasoningEffort !== undefined
          ? { reasoningEffort: message.reasoningEffort }
          : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      },
    )) {
      if (deps.abortSignal.aborted) return;
      if (chunk.type === "done") continue;
      acc.ingest(chunk);
      deps.send(chunkFrame(conversationId, chunk));
    }
  } catch (err) {
    streamFailed = true;
    if (deps.abortSignal.aborted) return;
    const msg = err instanceof Error ? err.message : String(err);
    deps.send(errorFrame(conversationId, msg, "PROVIDER_ERROR"));
  } finally {
    // Persist whenever the turn accumulated content. The `truncated` flag
    // is purely a UI signal — providers resume via providerSessionId, not
    // these rows.
    const assistantContent = acc.text();
    const contentParts = acc.parts();
    const hasPersistable =
      assistantContent.length > 0 || contentParts.length > 0;
    if (hasPersistable) {
      const truncated = deps.abortSignal.aborted || streamFailed;
      deps.store.appendMessage(conversationId, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: assistantContent,
        ...(contentParts.length > 0 ? { contentParts } : {}),
        ...(truncated ? { truncated: true } : {}),
        createdAt: new Date().toISOString(),
      });
    }
    // Done frame closes the client-side turn. Skipped on abort (WS close
    // already signals termination); sent on provider error so the receiver
    // knows the stream finished.
    if (!deps.abortSignal.aborted) {
      deps.send(doneFrame(conversationId));
    }
  }
}


// --- Frame builders ---

function chunkFrame(conversationId: string, chunk: MessageChunk): ChatFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    event: { type: "chunk", payload: chunk },
  };
}

function errorFrame(
  conversationId: string,
  message: string,
  code?: string,
): ChatFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    event: { type: "error", message, ...(code ? { code } : {}) },
  };
}

function doneFrame(conversationId: string): ChatFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    event: { type: "done" },
  };
}

function sendFrame(ws: ServerWebSocket<WsData>, frame: ChatFrame): void {
  const validated = chatFrameSchema.parse(frame);
  ws.send(JSON.stringify(validated));
}
