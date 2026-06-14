// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type AgentRef,
  type ChatEvent,
  type ClientFrame,
  chatFrameSchema,
  listAgentsResponseSchema,
  type MessageChunk,
  type OpenChatSeed,
  openChatSeedSchema,
  type ReasoningEffortLevel,
  WIRE_PROTOCOL_VERSION,
} from "@keelson/shared";

import { normalizeBase, originHeader } from "./base.ts";
import { HttpError } from "./workflow-client.ts";

function jsonHeaders(baseUrl: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    origin: originHeader(baseUrl),
  };
}

export interface ConversationRow {
  id: string;
  providerId: string;
  model?: string;
}

export interface ProviderCapabilitiesRow {
  // Empty string means "let the SDK decide" — matches packages/shared
  // providerCapabilitiesSchema.
  defaultModel: string;
  models: string[];
}

export interface ProviderInfoRow {
  id: string;
  displayName: string;
  builtIn: boolean;
  capabilities: ProviderCapabilitiesRow;
}

export interface CreateConversationOpts {
  providerId: string;
  model?: string;
  // Omitted → the server binds the conversation to the default workspace
  // project; the bound project's root becomes the agent's cwd.
  projectId?: string;
  // Seed an agent's system prompt + name (the open-as-chat path).
  seedSystemPrompt?: string;
  name?: string;
}

// Mirror the SPA's pickInitialRef (apps/web/src/views/Chat.tsx:131):
// copilot → stub → first registered non-workflow. The synthetic `workflow`
// provider is registered for run-as-conversation rows but rejects chat
// turns, so we skip it in the fallback.
export function pickDefaultHttpProvider(providers: readonly ProviderInfoRow[]): string {
  const ids = new Set(providers.map((p) => p.id));
  if (ids.has("copilot")) return "copilot";
  if (ids.has("stub")) return "stub";
  const first = providers.find((p) => p.id !== "workflow");
  if (first) return first.id;
  throw new Error(
    "no chat-capable provider registered on the server; run `keelson start` with KEELSON_PROVIDERS unset or include stub/copilot/claude",
  );
}

// Server-up chat creates a regular conversation row so the SPA sidebar
// renders the one-shot turn the same as any browser turn. Workflow / synthetic
// providers are rejected by the server with 400.
export async function createConversation(
  baseUrl: string,
  opts: CreateConversationOpts,
): Promise<ConversationRow> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/conversations`, {
    method: "POST",
    headers: jsonHeaders(baseUrl),
    body: JSON.stringify({
      providerId: opts.providerId,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.seedSystemPrompt ? { seedSystemPrompt: opts.seedSystemPrompt } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, `POST /api/conversations failed: ${res.status} ${body}`);
  }
  return (await res.json()) as ConversationRow;
}

// Agents (the GET /api/agents source). Both reach the server's /api/agents routes;
// resolve returns the seed the caller hands to createConversation.
export async function listAgents(baseUrl: string): Promise<AgentRef[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/agents`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new HttpError(res.status, `GET /api/agents failed: ${res.status}`);
  return listAgentsResponseSchema.parse(await res.json()).agents;
}

export async function resolveAgent(
  baseUrl: string,
  ribId: string,
  slug: string,
): Promise<OpenChatSeed> {
  const res = await fetch(
    `${normalizeBase(baseUrl)}/api/agents/${encodeURIComponent(ribId)}/${encodeURIComponent(slug)}/resolve`,
    { method: "POST", headers: jsonHeaders(baseUrl) },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, `resolve agent failed: ${res.status} ${body}`);
  }
  return openChatSeedSchema.parse(await res.json());
}

export interface ConversationSummaryRow {
  id: string;
  providerId: string;
  name?: string;
  updatedAt?: string;
}

// List conversations for the interactive welcome card's recent-sessions
// section; tolerant of absent name/updatedAt on older rows.
export async function listConversations(baseUrl: string): Promise<ConversationSummaryRow[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/conversations`, {
    headers: { accept: "application/json", origin: originHeader(baseUrl) },
  });
  if (!res.ok) {
    throw new HttpError(res.status, `GET /api/conversations failed: ${res.status}`);
  }
  const payload = (await res.json()) as { conversations?: ConversationSummaryRow[] };
  return payload.conversations ?? [];
}

// Resolve an existing conversation so `keelson chat --conversation <id>`
// routes turns through the same provider/model the SPA recorded when the
// row was created, instead of the CLI's CLI-side guess.
export async function getConversation(baseUrl: string, id: string): Promise<ConversationRow> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/conversations/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json", origin: originHeader(baseUrl) },
  });
  if (res.status === 404) {
    throw new HttpError(404, `unknown conversation '${id}'`);
  }
  if (!res.ok) {
    throw new HttpError(res.status, `GET /api/conversations/${id} failed: ${res.status}`);
  }
  return (await res.json()) as ConversationRow;
}

// List providers the server has registered so the CLI can mirror the SPA's
// fallback chain (copilot → stub → first registered non-workflow). The
// synthetic `workflow` provider sits in this list but rejects chat turns;
// callers must skip it.
export async function listProviders(baseUrl: string): Promise<ProviderInfoRow[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/providers`, {
    headers: { accept: "application/json", origin: originHeader(baseUrl) },
  });
  if (!res.ok) {
    throw new HttpError(res.status, `GET /api/providers failed: ${res.status}`);
  }
  const payload = (await res.json()) as { providers?: ProviderInfoRow[] };
  return payload.providers ?? [];
}

export interface ChatViaServerOptions {
  baseUrl: string;
  conversationId: string;
  providerId: string;
  message: string;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
  onChunk?: (chunk: MessageChunk) => void;
  signal?: AbortSignal;
}

export interface ChatViaServerResult {
  // Server-driven chat ends on done | error. `errored: true` means the
  // server emitted a chat-level error frame before the done frame.
  errored: boolean;
  errorMessage?: string;
}

// Open the chat WS, send a single request frame, stream chunks until done.
// Mirrors the SPA's chat client (apps/web/src/api/chat.ts) but bounded to
// one turn — no follow-up sends.
export function chatViaServer(opts: ChatViaServerOptions): Promise<ChatViaServerResult> {
  const wsUrl = `${normalizeBase(opts.baseUrl).replace(/^http/, "ws")}/api/chat/ws`;
  const frame: ClientFrame = {
    version: WIRE_PROTOCOL_VERSION,
    conversationId: opts.conversationId,
    message: {
      type: "request",
      providerId: opts.providerId,
      prompt: opts.message,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    // Bun's WebSocket accepts a non-standard `headers` option that the
    // standard typings don't model; cast to keep TS happy. Same trick as
    // workflow-client.ts:attachRun.
    const WS = WebSocket as unknown as new (
      url: string,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const ws = new WS(wsUrl, { headers: { origin: originHeader(opts.baseUrl) } });

    let errored = false;
    let errorMessage: string | undefined;
    // The server emits a `done` chat-event (or a `done` message chunk
    // inside one) on every successful turn. Tracking it here means a
    // mid-stream socket close (server restart, network blip) is reported
    // as a failure instead of a silent exit-0 — same treatment workflow
    // run-attaches give a WS that closes without a `run_done`.
    let sawDone = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        ws.close(1000, "client abort");
      } catch {
        // ignore
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (): void => {
      sawDone = true;
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        ws.close(1000, "client done");
      } catch {
        // ignore
      }
    };

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(frame));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const parsed = chatFrameSchema.parse(JSON.parse(String(ev.data)));
        const event: ChatEvent = parsed.event;
        if (event.type === "chunk") {
          opts.onChunk?.(event.payload);
          if (event.payload.type === "done") {
            finish();
          }
        } else if (event.type === "error") {
          errored = true;
          errorMessage = event.message;
        } else if (event.type === "done") {
          finish();
        }
      } catch (err) {
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          ws.close(1003, "bad frame");
        } catch {
          // ignore
        }
        reject(err);
      }
    });
    ws.addEventListener("close", () => {
      opts.signal?.removeEventListener("abort", onAbort);
      // Surface a transport-level failure when the socket closed before a
      // terminal frame arrived (and the caller didn't explicitly abort).
      // Without this, runChatViaHttp would exit success after printing a
      // partial response — exactly the silent-incomplete-turn case the
      // workflow runner's WS_NO_TERMINAL check guards against.
      if (!sawDone && !errored && !aborted) {
        errored = true;
        errorMessage = "chat stream ended without a terminal frame (server unreachable mid-turn?)";
      }
      resolve({ errored, ...(errorMessage ? { errorMessage } : {}) });
    });
    ws.addEventListener("error", (ev) => {
      opts.signal?.removeEventListener("abort", onAbort);
      const message = ev instanceof ErrorEvent ? ev.message : "websocket error";
      reject(new Error(message));
    });
  });
}
