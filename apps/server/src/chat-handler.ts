// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  getAgentProvider,
  getProviderInfoList,
  type IAgentProvider,
  isRegisteredProvider,
  UnknownProviderError,
} from "@keelson/providers";
import {
  type ChatFrame,
  type ClientFrame,
  chatFrameSchema,
  clientFrameSchema,
  inferToolFamily,
  type MessageChunk,
  modelInfoSchema,
  RECALL_REQUEST_SCHEMA_VERSION,
  type RecallRequest,
  type RecallResponse,
  registeredToolInfoSchema,
  renameConversationBodySchema,
  WIRE_PROTOCOL_VERSION,
} from "@keelson/shared";
import { getRegisteredTools } from "@keelson/skills";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Hono } from "hono";
import { z } from "zod";
import { createContentPartsAccumulator } from "./content-parts.ts";
import type { ConversationStore } from "./conversation-store.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { ProjectsStore } from "./projects-store.ts";
import { isAllowedOrigin, type WsData } from "./server-context.ts";
import type { WorkflowStore } from "./workflow-store.ts";
import type { ActiveRuns } from "./workflows-handler.ts";
import { purgeWorkflowRun } from "./workflows-handler.ts";

export interface ChatRoutesWorkflowDeps {
  workflowStore: WorkflowStore;
  activeRuns: ActiveRuns;
}

export interface ChatRoutesOptions {
  // Optional so tests can spin up chat routes without project wiring; in
  // production, conversations resolve cwd via the linked project's rootPath
  // and fall back to the default project when projectId is omitted.
  projectsStore?: ProjectsStore;
}

const createConversationBodySchema = z
  .object({
    providerId: z.string(),
    model: z.string().optional(),
    seedSystemPrompt: z.string().min(1).max(8000).optional(),
    name: z.string().min(1).max(80).optional(),
    projectId: z.string().optional(),
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
  opts: ChatRoutesOptions = {},
): void {
  app.get("/api/providers", (c) => c.json({ providers: getProviderInfoList() }));

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
    // Workflow conversations persist for run history but are surfaced only
    // via the Workflows tab; hide them from the chat sidebar so the two
    // mental models stay separated.
    c.json({
      conversations: store.list().filter((conv) => conv.providerId !== "workflow"),
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
      return c.json({ error: `unknown provider '${parsed.data.providerId}'` }, 400);
    }
    // The synthetic `workflow` provider is registered for run-as-conversation
    // but is non-chat. Reject manual creation so a stray client can't allocate
    // a row that the chat surface will then try to send turns through (the
    // provider's sendQuery throws on use).
    if (parsed.data.providerId === "workflow") {
      return c.json(
        {
          error: "workflow conversations are created via POST /api/workflows/:name/runs",
        },
        400,
      );
    }
    let projectId = parsed.data.projectId;
    if (projectId !== undefined && opts.projectsStore && !opts.projectsStore.get(projectId)) {
      return c.json({ error: `unknown project '${projectId}'` }, 400);
    }
    if (projectId === undefined && opts.projectsStore) {
      projectId = opts.projectsStore.getByName("default")?.id;
    }
    const conv = store.create({
      ...parsed.data,
      ...(projectId !== undefined ? { projectId } : {}),
    });
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
  return cleaned.length <= MAX ? cleaned : `${cleaned.slice(0, MAX - 1)}…`;
}

export function handleChatUpgrade(req: Request, server: Server<WsData>): Response | undefined {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new Response("forbidden origin", { status: 403 });
  }
  const data: WsData = { abort: new AbortController(), kind: "chat" };
  const ok = server.upgrade(req, { data });
  if (ok) return undefined;
  return new Response("expected websocket", { status: 426 });
}

export interface ChatWebSocketDeps {
  memoryStore?: MemoryStore;
  projectsStore?: ProjectsStore;
}

export function chatWebSocketHandlers(
  store: ConversationStore,
  deps: ChatWebSocketDeps = {},
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
        ...(deps.memoryStore !== undefined ? { memoryStore: deps.memoryStore } : {}),
        ...(deps.projectsStore !== undefined ? { projectsStore: deps.projectsStore } : {}),
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
  // When wired, a pre-turn recall against this store prepends a memory
  // section to `systemPrompt`. Undefined → recall skipped.
  memoryStore?: MemoryStore;
  // Resolves the conversation's projectId → rootPath used as the agent's cwd.
  // Undefined → falls back to process.cwd().
  projectsStore?: ProjectsStore;
}

// Worst-case section size is bounded at MAX_ITEMS × CONTENT_CHARS so a
// populated store can't bloat every turn's prompt.
const MEMORY_RECALL_MAX_ITEMS = 5;
const MEMORY_RECALL_CONTENT_CHARS = 200;
const MEMORY_SECTION_HEADER = "## Relevant prior memory";

export async function handleChatRequest(frame: ClientFrame, deps: ChatDeps): Promise<void> {
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
  // the composer for these; HITL approval flows through POST
  // /api/workflows/runs/:runId/resume, not this WS path.
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
  // get `truncated: true` so the UI marks them on reload. Minted up front
  // so it can be threaded into the recall envelope as `task.flowId`.
  const userMessageId = crypto.randomUUID();
  deps.store.appendMessage(conversationId, {
    id: userMessageId,
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
      errorFrame(conversationId, `unknown provider '${message.providerId}'`, "UNKNOWN_PROVIDER"),
    );
    deps.send(doneFrame(conversationId));
    return;
  }

  let provider: IAgentProvider;
  try {
    provider = getAgentProvider(message.providerId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof UnknownProviderError ? "UNKNOWN_PROVIDER" : "PROVIDER_ERROR";
    deps.send(errorFrame(conversationId, msg, code));
    deps.send(doneFrame(conversationId));
    return;
  }

  // Structured projection alongside the denormalized text so the message can
  // be replayed on reload. Text chunks fold into one Anthropic-style block;
  // tool_use / tool_result become their own. Thinking chunks excluded.
  const acc = createContentPartsAccumulator();
  let streamFailed = false;

  const tools = getRegisteredTools();

  // A projectId is always required for project-scoped recall; without it,
  // MemoryStore.recall would skip the filter and inject memories from every
  // project. Fall back to the default project when conv.projectId is unset
  // (e.g. a row whose project was deleted, FK SET NULL).
  const recallProjectId = conv.projectId ?? deps.projectsStore?.getByName("default")?.id;

  // Recall failures warn-and-continue with the section omitted; the turn
  // proceeds with whatever systemPrompt the seed would have produced.
  const recallSection = await runChatRecall({
    memoryStore: deps.memoryStore,
    conversationId,
    userMessageId,
    query: message.prompt,
    ...(recallProjectId !== undefined ? { projectId: recallProjectId } : {}),
  });

  const systemPromptParts: string[] = [];
  if (recallSection !== undefined) systemPromptParts.push(recallSection);
  if (typeof conv.seedSystemPrompt === "string" && conv.seedSystemPrompt.length > 0) {
    systemPromptParts.push(conv.seedSystemPrompt);
  }
  const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

  // Falls back to the default project's rootPath when conv.projectId was
  // NULLed (deleted project) or when the row's id no longer resolves; using
  // process.cwd() would send tools to the server's launch directory.
  const defaultRootPath = deps.projectsStore?.getByName("default")?.rootPath;
  const resolvedRootPath =
    conv.projectId && deps.projectsStore
      ? deps.projectsStore.get(conv.projectId)?.rootPath
      : undefined;
  const cwd = resolvedRootPath ?? defaultRootPath ?? process.cwd();

  try {
    for await (const chunk of provider.sendQuery(message.prompt, cwd, conv.providerSessionId, {
      model: message.model ?? conv.model,
      abortSignal: deps.abortSignal,
      // Omit unset fields so providers see their SDK defaults.
      ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
      ...(message.reasoningEffort !== undefined
        ? { reasoningEffort: message.reasoningEffort }
        : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    })) {
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
    const hasPersistable = assistantContent.length > 0 || contentParts.length > 0;
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

// --- Memory recall ---

interface RunChatRecallArgs {
  memoryStore: MemoryStore | undefined;
  conversationId: string;
  userMessageId: string;
  query: string;
  projectId?: string;
}

// Returns the formatted section to prepend onto systemPrompt, or undefined
// when recall is disabled, returned no items, or failed. Best-effort — a
// failure never surfaces to the caller.
async function runChatRecall(args: RunChatRecallArgs): Promise<string | undefined> {
  const { memoryStore, conversationId, userMessageId, query, projectId } = args;
  if (memoryStore === undefined) return undefined;
  // recallRequestSchema enforces query.min(1); guard here so a whitespace-
  // only prompt doesn't trip a parse error inside the store.
  const trimmed = query.trim();
  if (trimmed.length === 0) return undefined;

  const req: RecallRequest = {
    schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
    scope: {
      visibility: "project",
      ...(projectId !== undefined ? { projectId } : {}),
    },
    task: { runtime: "chat", taskId: conversationId, flowId: userMessageId },
    query,
    limits: { maxItems: MEMORY_RECALL_MAX_ITEMS },
  };

  let res: RecallResponse;
  try {
    res = memoryStore.recall(req);
  } catch (err) {
    console.warn(
      `[memory] chat recall failed (continuing without injection): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  // The system-prompt channel is the model's instruction channel — only
  // memories explicitly promoted to instruction-grade may enter it. The
  // schema's promotion gate (memory.ts) ties canUseAsInstruction to
  // user_confirmed / imported provenance, so workflow-written memories
  // (provenance: "generated") stay out until a human curates them through
  // the review queue. Defense-in-depth on the other two flags — recall's
  // SQL already excludes doNotInjectAutomatically.
  const injectable = res.items.filter(
    ({ usePolicy }) =>
      usePolicy.canUseAsInstruction &&
      !usePolicy.requiresUserConfirmation &&
      !usePolicy.doNotInjectAutomatically,
  );
  if (injectable.length === 0) return undefined;

  // Cap the whole rendered line (summary + content) so an unbounded summary
  // can't bust the MAX_ITEMS × CONTENT_CHARS section bound.
  const lines = injectable.map((item) => {
    const body = `${item.summary}: ${item.content}`;
    const truncated =
      body.length > MEMORY_RECALL_CONTENT_CHARS
        ? `${body.slice(0, MEMORY_RECALL_CONTENT_CHARS - 1)}…`
        : body;
    return `- ${truncated}`;
  });
  return `${MEMORY_SECTION_HEADER}\n\n${lines.join("\n")}`;
}

// --- Frame builders ---

function chunkFrame(conversationId: string, chunk: MessageChunk): ChatFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    event: { type: "chunk", payload: chunk },
  };
}

function errorFrame(conversationId: string, message: string, code?: string): ChatFrame {
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
