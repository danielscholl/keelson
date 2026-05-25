// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ToolContext } from "@keelson/shared";
import { ChunkQueue } from "../chunk-queue.ts";
import type {
  IAgentProvider,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  SendQueryOptions,
} from "../types.ts";
import { buildFriendlyCopilotError } from "./errors.ts";
import {
  CopilotClientFactory,
  type CopilotClientLike,
  type CopilotPermissionHandler,
  type CopilotSessionLike,
  type CopilotToolProjectionContext,
  projectToolsForCopilot,
} from "./factory.ts";

export const COPILOT_CREDENTIAL_SERVICE_ID = "copilot" as const;

// "auto" delegates model choice to Copilot; keeps the default resilient to
// GitHub rotating the underlying model.
export const COPILOT_DEFAULT_MODEL = "auto" as const;

export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  // chat-handler doesn't propagate sessionId yet.
  sessionResume: false,
  streaming: true,
  tools: true,
  // Curated fallback when the live SDK.listModels() probe fails (signed out
  // or CLI missing).
  models: [COPILOT_DEFAULT_MODEL, "gpt-5", "gpt-4o", "claude-sonnet-4.5", "o4-mini"],
  defaultModel: COPILOT_DEFAULT_MODEL,
};

export type GetCredentialFn = (serviceId: string) => Promise<string | undefined>;

export interface CopilotProviderOptions {
  getCredential: GetCredentialFn;
  clientFactory?: CopilotClientFactory;
}

export class CopilotProvider implements IAgentProvider {
  private readonly getCredential: GetCredentialFn;
  private readonly factory: CopilotClientFactory;
  // Process-lifetime cache; CLI spawn for listModels costs ~1s.
  private modelListCache: Promise<ModelInfo[]> | null = null;

  constructor(options: CopilotProviderOptions) {
    this.getCredential = options.getCredential;
    this.factory = options.clientFactory ?? new CopilotClientFactory();
  }

  getType(): string {
    return "copilot";
  }

  getCapabilities(): ProviderCapabilities {
    return COPILOT_CAPABILITIES;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.modelListCache) {
      this.modelListCache = this.fetchModels();
    }
    return this.modelListCache;
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    const token = await this.getCredential(COPILOT_CREDENTIAL_SERVICE_ID);
    const live = await this.factory.listModels(token, process.cwd());
    // null = probe failed (signed out, CLI missing). Drop the cache so the
    // next request retries instead of serving the bare-id fallback forever.
    if (live === null) {
      this.modelListCache = null;
      return COPILOT_CAPABILITIES.models.map((id) => ({ id }));
    }
    return live;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    // Bail before SDK work if the caller already gave up — avoids spawning a
    // CLI process that nothing will read.
    if (options?.abortSignal?.aborted) return;

    // Optional: undefined opts the factory into the `copilot auth login`
    // fallback. Missing both surfaces as a session-error from the SDK.
    const token = await this.getCredential(COPILOT_CREDENTIAL_SERVICE_ID);
    if (options?.abortSignal?.aborted) return;

    let client: CopilotClientLike;
    let permissionHandler: CopilotPermissionHandler;
    try {
      const created = await this.factory.createClient(token, cwd);
      client = created.client;
      permissionHandler = created.permissionHandler;
    } catch (err) {
      const msg = buildFriendlyCopilotError(err);
      yield { type: "system", content: msg };
      throw err instanceof Error ? err : new Error(msg);
    }

    // Abort during createClient: tear down the CLI process before returning.
    if (options?.abortSignal?.aborted) {
      try {
        await client.stop();
      } catch {
        // cleanup errors during abort are non-fatal
      }
      return;
    }

    const queue = new ChunkQueue();
    const unsubs: Array<() => void> = [];
    let session: CopilotSessionLike | null = null;
    let lastSessionError: string | null = null;

    // Per-request wiring for custom tools. The closure captures queue + cwd +
    // abortSignal so SDK-side handlers emit into the stream the UI drains.
    const toolProjection: CopilotToolProjectionContext = {
      pushChunk: (chunk) => queue.push(chunk),
      contextFactory: (toolCallId): ToolContext => ({
        cwd,
        emit: (chunk) => queue.push(chunk),
        abortSignal: options?.abortSignal ?? new AbortController().signal,
        // toolCallId is consumed inside the projection closure, not on
        // ToolContext (avoiding contract widening).
        ...(toolCallId ? {} : {}),
      }),
    };

    const abortListener = () => {
      // Best-effort SDK abort + queue close; outer abort path is authoritative.
      if (session) {
        session
          .abort()
          .catch(() => {})
          .finally(() => queue.close());
      } else {
        queue.close();
      }
    };

    try {
      if (options?.abortSignal) {
        options.abortSignal.addEventListener("abort", abortListener);
      }

      try {
        const sessionConfig = buildSessionConfig(options, permissionHandler, cwd, toolProjection);
        session = resumeSessionId
          ? await client.resumeSession(resumeSessionId, sessionConfig)
          : await client.createSession(sessionConfig);
      } catch (err) {
        const msg = buildFriendlyCopilotError(err);
        yield { type: "system", content: msg };
        throw err instanceof Error ? err : new Error(msg);
      }

      // ResumeSessionConfig doesn't reliably retarget effort on the next
      // turn; setModel is the documented per-turn override. Create-session
      // already carries effort via buildSessionConfig.
      if (resumeSessionId && options?.reasoningEffort && options?.model) {
        try {
          await session.setModel(options.model, {
            reasoningEffort: options.reasoningEffort,
          });
        } catch (err) {
          // Non-fatal — the SDK will resurface this as a session.error if
          // the model genuinely rejects the effort tier.
          const msg = err instanceof Error ? err.message : String(err);
          yield { type: "system", content: `setModel failed: ${msg}` };
        }
      }

      // Don't submit if cancel raced session creation — would spend tokens
      // for output nothing reads. Outer finally cleans up the session.
      if (options?.abortSignal?.aborted) {
        return;
      }

      // Track delta length so the final message-event only fills in the
      // remainder — guards against double-emit when both streaming and a
      // final message land, and against silent empties when streaming
      // doesn't fire.
      let streamedTextLen = 0;
      // Same pattern for reasoning: deltas are model-dependent (sub-agents
      // may skip them) so the final-event handler ships the remainder.
      let streamedReasoningLen = 0;
      unsubs.push(
        session.on("assistant.message_delta", (event: unknown) => {
          const delta = readString(event, "deltaContent");
          if (delta && delta.length > 0) {
            streamedTextLen += delta.length;
            queue.push({ type: "text", content: delta });
          }
        }),
      );
      // Translate reasoning_delta → `thinking` chunks so ThinkingBlock
      // renders them verbatim without an extra component.
      unsubs.push(
        session.on("assistant.reasoning_delta", (event: unknown) => {
          const delta = readString(event, "deltaContent");
          if (delta && delta.length > 0) {
            streamedReasoningLen += delta.length;
            queue.push({ type: "thinking", content: delta });
          }
        }),
      );
      // Final reasoning event — same fallback shape as assistant.message.
      // When streaming worked the tail is empty; when it didn't, the whole
      // payload lands here so the UI doesn't silently drop reasoning.
      unsubs.push(
        session.on("assistant.reasoning", (event: unknown) => {
          const full = readString(event, "content");
          if (!full) return;
          if (full.length > streamedReasoningLen) {
            queue.push({
              type: "thinking",
              content: full.slice(streamedReasoningLen),
            });
            streamedReasoningLen = full.length;
          }
        }),
      );
      unsubs.push(
        session.on("assistant.message", (event: unknown) => {
          const full = readString(event, "content");
          if (!full) return;
          // Emit only the unstreamed remainder.
          if (full.length > streamedTextLen) {
            queue.push({ type: "text", content: full.slice(streamedTextLen) });
            streamedTextLen = full.length;
          }
        }),
      );
      unsubs.push(
        session.on("tool.execution_start", (event: unknown) => {
          const toolName = readString(event, "toolName");
          if (!toolName) return;
          const args = readObject(event, "arguments");
          // Forward the SDK's toolCallId so persisted contentParts and the
          // UI <ToolCallsBlock> can pair this tool_use with its tool_result.
          const id = readString(event, "toolCallId") ?? crypto.randomUUID();
          queue.push(
            args
              ? { type: "tool_use", id, toolName, toolInput: args }
              : { type: "tool_use", id, toolName },
          );
        }),
      );
      unsubs.push(
        session.on("session.error", (event: unknown) => {
          lastSessionError = readString(event, "message") ?? "session error";
          queue.close();
        }),
      );
      unsubs.push(
        session.on("session.idle", () => {
          queue.close();
        }),
      );

      // Send resolves at turn-end (session.idle), so awaiting it would
      // buffer every delta and break real-time streaming. Drain concurrently;
      // failures land in `sendError` and close the queue to exit the drain.
      let sendError: Error | null = null;
      const sendPromise = session.send({ prompt }).catch((err: unknown) => {
        sendError = err instanceof Error ? err : new Error(String(err));
        queue.close();
      });

      while (true) {
        const chunk = await queue.next();
        if (chunk === null) break;
        yield chunk;
      }

      // .catch above absorbs rejection; await ensures the promise settles
      // before the finally cleanup tears the session down.
      await sendPromise;

      // Session errors carry typed errorType (auth, rate_limit) — more
      // informative than a bare send rejection.
      if (lastSessionError) {
        const msg = buildFriendlyCopilotError(lastSessionError);
        yield { type: "error", message: msg };
        throw new Error(msg);
      }
      if (sendError) {
        const msg = buildFriendlyCopilotError(sendError);
        yield { type: "error", message: msg };
        throw sendError;
      }
    } finally {
      options?.abortSignal?.removeEventListener("abort", abortListener);
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // unsubscribe errors are non-fatal
        }
      }
      if (session) {
        try {
          await session.disconnect();
        } catch {
          // disconnect errors during cleanup are non-fatal
        }
      }
      try {
        await client.stop();
      } catch {
        // stop errors during cleanup are non-fatal
      }
    }
  }
}

function buildSessionConfig(
  options: SendQueryOptions | undefined,
  permissionHandler: CopilotPermissionHandler,
  cwd: string,
  toolProjection: CopilotToolProjectionContext,
): unknown {
  // `unknown` because the SDK's SessionConfig type is owned by the SDK
  // module; the structural CopilotClientLike avoids importing it statically.
  // onPermissionRequest is REQUIRED — sessions reject without it. streaming
  // is required for assistant.message_delta events; without it the drain
  // would yield no text.
  const config: Record<string, unknown> = {
    onPermissionRequest: permissionHandler,
    streaming: true,
    workingDirectory: cwd,
  };
  if (options?.model) config.model = options.model;
  if (options?.systemPrompt) {
    config.systemMessage = { content: options.systemPrompt };
  }
  // Forward unconditionally — wire gating is the web's job; a mismatch
  // surfaces as a typed SDK session.error.
  if (options?.reasoningEffort) {
    config.reasoningEffort = options.reasoningEffort;
  }
  // Empty arrays still forward (lets a caller explicitly disable inherited
  // tools); only the absent case omits the field.
  if (options?.tools && options.tools.length > 0) {
    config.tools = projectToolsForCopilot(options.tools, toolProjection);
  }
  return config;
}

function readString(event: unknown, key: string): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function readObject(event: unknown, key: string): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}
