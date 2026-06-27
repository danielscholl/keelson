// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { TokenUsage, ToolContext } from "@keelson/shared";
import { ChunkQueue } from "../chunk-queue.ts";
import { toTokenCount } from "../token-count.ts";
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
import { buildCopilotSessionHooks } from "./hooks-shim.ts";
import { buildPermissionGate } from "./permission-gate.ts";

export const COPILOT_CREDENTIAL_SERVICE_ID = "copilot" as const;

// "auto" delegates model choice to Copilot; keeps the default resilient to
// GitHub rotating the underlying model.
export const COPILOT_DEFAULT_MODEL = "auto" as const;

export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  // The chat handler persists the session id (onSessionId) and resumes it on
  // the next turn, so multi-turn context survives.
  sessionResume: true,
  streaming: true,
  tools: true,
  // Only the synthetic "auto" — GitHub rotates the live catalogue and retires
  // concrete ids (e.g. gpt-5, which then 404s at session.create), so listing
  // them here would advertise models that no longer exist. "auto" delegates the
  // choice to Copilot and is always valid; the real list comes from listModels().
  models: [COPILOT_DEFAULT_MODEL],
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
  // sendQuery detaches SDK teardown (see its finally) so a turn returns without
  // waiting out the SDK's up-to-10s runtime shutdown. The detached promise
  // completes on its own; this set only lets dispose() await in-flight ones.
  private readonly pendingTeardowns = new Set<Promise<void>>();

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

  // Awaits in-flight detached teardowns. Each turn gets a fresh provider the
  // server then drops, so production relies on the long-lived process outliving
  // the background teardown — this is a deterministic join for tests, not a
  // server-shutdown hook.
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.pendingTeardowns]);
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
      ...(options?.evaluateToolCall !== undefined
        ? { evaluateToolCall: options.evaluateToolCall }
        : {}),
      ...(options?.evaluateToolResult !== undefined
        ? { evaluateToolResult: options.evaluateToolResult }
        : {}),
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

      // Surface the session id so the handler can persist it for the next
      // turn's resume. createSession mints a new id; resumeSession echoes the
      // one we passed in.
      options?.onSessionId?.(session.sessionId);

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
      // Per-API-call usage metrics — summing across events gives turn totals
      // (each event is one model call, so this is accumulation across
      // requests, not double-counting stream snapshots).
      let turnInput = 0;
      let turnOutput = 0;
      let turnCacheRead = 0;
      let turnCacheWrite = 0;
      let sawCallUsage = false;
      // Context gauge straight from the SDK; latest event wins.
      let contextTokens: number | undefined;
      let contextWindow: number | undefined;
      unsubs.push(
        session.on("assistant.usage", (event: unknown) => {
          const input = readCount(event, "inputTokens");
          const output = readCount(event, "outputTokens");
          const cacheRead = readCount(event, "cacheReadTokens");
          const cacheWrite = readCount(event, "cacheWriteTokens");
          if (
            input === undefined &&
            output === undefined &&
            cacheRead === undefined &&
            cacheWrite === undefined
          ) {
            return;
          }
          sawCallUsage = true;
          turnInput += input ?? 0;
          turnOutput += output ?? 0;
          turnCacheRead += cacheRead ?? 0;
          turnCacheWrite += cacheWrite ?? 0;
        }),
      );
      unsubs.push(
        session.on("session.usage_info", (event: unknown) => {
          const current = readCount(event, "currentTokens");
          const limit = readCount(event, "tokenLimit");
          if (current !== undefined) contextTokens = current;
          if (limit !== undefined && limit > 0) contextWindow = limit;
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

      // Emit before the error checks — an errored turn still spent tokens.
      // Omitted entirely when the SDK reported nothing (no fabricated zeros).
      if (sawCallUsage || contextTokens !== undefined) {
        const usage: TokenUsage = { inputTokens: turnInput, outputTokens: turnOutput };
        if (turnCacheRead > 0) usage.cacheReadInputTokens = turnCacheRead;
        if (turnCacheWrite > 0) usage.cacheCreationInputTokens = turnCacheWrite;
        if (contextTokens !== undefined) usage.contextTokens = contextTokens;
        if (contextWindow !== undefined) usage.contextWindow = contextWindow;
        yield { type: "usage", usage };
      }

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
      // Detach SDK teardown from the turn. client.stop() waits on the Copilot
      // runtime's shutdown ack up to the SDK's 10s RUNTIME_SHUTDOWN_TIMEOUT, so
      // awaiting it here would stall the generator's return — and with it the
      // turn's terminal `done` frame and the CLI's exit — long after the answer
      // streamed. Run it in the background (the SDK force-kills the runtime if
      // graceful shutdown times out); dispose() drains in-flight teardowns.
      const teardown = settleCopilotTeardown(client);
      this.pendingTeardowns.add(teardown);
      void teardown.finally(() => this.pendingTeardowns.delete(teardown));
    }
  }
}

// Best-effort SDK teardown, detached from the turn (see sendQuery's finally).
// client.stop() disconnects this turn's session itself, so stopping the client
// is the whole teardown. Never rejects: failure is non-fatal and the SDK
// force-kills the runtime if its graceful shutdown times out.
async function settleCopilotTeardown(client: CopilotClientLike): Promise<void> {
  try {
    await client.stop();
  } catch {
    // stop errors during cleanup are non-fatal
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
  // Apply the same allow/deny rail to the projected custom tools so the
  // provider enforces its own contract (`allowedTools: []` ⇒ no tools) rather
  // than relying on the workflow handler's prefiltering. Built-in tools are
  // gated separately via the permission handler below.
  if (options?.tools && options.tools.length > 0) {
    const railed = filterToolsByRail(
      options.tools,
      options?.allowedTools,
      options?.disallowedTools,
    );
    if (railed.length > 0) {
      config.tools = projectToolsForCopilot(railed, toolProjection);
    }
  }
  // Per-node `allowed_tools` / `denied_tools` gate the SDK's BUILT-IN tools
  // (custom/rib tools are already filtered upstream). The permission handler
  // only sees a coarse capability `kind`, so the rail is enforced there. The
  // policy engine's per-call gate ALSO governs built-in capabilities, so install
  // the gate whenever a rail OR an evaluateToolCall is present; with neither, the
  // bare approveAll passes through unchanged.
  if (
    options?.allowedTools !== undefined ||
    options?.disallowedTools !== undefined ||
    options?.evaluateToolCall !== undefined
  ) {
    config.onPermissionRequest = buildPermissionGate({
      approveAll: permissionHandler,
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools !== undefined
        ? { disallowedTools: options.disallowedTools }
        : {}),
      ...(options.evaluateToolCall !== undefined
        ? { evaluateToolCall: options.evaluateToolCall }
        : {}),
    });
  }
  // Project per-node PreToolUse / PostToolUse matchers onto the SDK's native
  // hooks. Other hook events have no Copilot equivalent and stay claude-only.
  if (options?.hooks !== undefined) {
    const sessionHooks = buildCopilotSessionHooks(options.hooks);
    if (sessionHooks !== undefined) config.hooks = sessionHooks;
  }
  return config;
}

// MCP-projected tools register as `mcp__<server>__<tool>`; allow/deny lists may
// use either the bare or qualified form. Strip the wrapper so both match — the
// server segment is consumed up to the next `__` (mirrors the workflow handler).
function stripMcpPrefix(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const serverEnd = name.indexOf("__", 5);
  if (serverEnd < 0) return name;
  return name.slice(serverEnd + 2);
}

// Intersect the projected tool list with `allowedTools` and subtract
// `disallowedTools`, comparing on bare names. An empty `allowedTools` yields no
// tools, satisfying the documented "no tools" contract.
function filterToolsByRail<T extends { name: string }>(
  tools: T[],
  allowedTools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined,
): T[] {
  let result = tools;
  if (allowedTools !== undefined) {
    const allow = new Set(allowedTools.map(stripMcpPrefix));
    result = result.filter((t) => allow.has(stripMcpPrefix(t.name)));
  }
  if (disallowedTools !== undefined) {
    const deny = new Set(disallowedTools.map(stripMcpPrefix));
    result = result.filter((t) => !deny.has(stripMcpPrefix(t.name)));
  }
  return result;
}

function readString(event: unknown, key: string): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function readCount(event: unknown, key: string): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  return toTokenCount((data as Record<string, unknown>)[key]);
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
