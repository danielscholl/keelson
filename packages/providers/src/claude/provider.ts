// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { TokenUsage, ToolContext } from "@keelson/shared";
import type { ClaudeAuthMode } from "@keelson/shared/config";
import { ChunkQueue } from "../chunk-queue.ts";
import { toTokenCount } from "../token-count.ts";
import type {
  IAgentProvider,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  ProviderFinishReason,
  SendQueryOptions,
} from "../types.ts";
import { buildFriendlyClaudeError } from "./errors.ts";
import {
  type ClaudeApiUsage,
  type ClaudeContentBlock,
  ClaudeQueryFactory,
  type ClaudeQueryHandle,
  type ClaudeSdkMessage,
  type ClaudeToolProjectionContext,
} from "./factory.ts";

export const CLAUDE_CREDENTIAL_SERVICE_ID = "claude" as const;

// SDK has no listModels endpoint; curated. Update when the Claude Code lineup shifts.
export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8" as const;

// Hand-maintained — the Agent SDK has no programmatic models.list(), and the Messages
// API /v1/models endpoint returns bare API ids, not the family aliases the Claude Code
// CLI exposes. Mirror the CLI's picker. costTier is a coarse 3-level signal: Fable is the
// priciest tier (above Opus), so Opus and Sonnet — the closest-priced pair — share mid.
const CLAUDE_MODEL_CATALOG: readonly ModelInfo[] = [
  {
    id: "claude-fable-5",
    displayName: "Fable",
    description: "Most capable — hardest and longest-running tasks.",
    costTier: "high",
    supports: { vision: true, tools: true, thinking: true },
  },
  {
    id: CLAUDE_DEFAULT_MODEL,
    displayName: "Opus",
    description: "Highly capable — deep reasoning and long-horizon agentic work.",
    costTier: "mid",
    supports: { vision: true, tools: true, thinking: true },
  },
  {
    id: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Balanced cost and capability; efficient for routine tasks.",
    costTier: "mid",
    supports: { vision: true, tools: true, thinking: true },
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Haiku",
    description: "Fastest and lowest-cost, for quick answers.",
    costTier: "low",
    supports: { vision: true, tools: true, thinking: true },
  },
];

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  // The chat handler persists the session id (onSessionId) and resumes it on
  // the next turn, so multi-turn context survives.
  sessionResume: true,
  streaming: true,
  tools: true,
  // Same source of truth as listModels(); providerInfoSchema's bare-id
  // shape gets projected here so the two don't drift.
  models: CLAUDE_MODEL_CATALOG.map((m) => m.id),
  defaultModel: CLAUDE_DEFAULT_MODEL,
};

export type GetCredentialFn = (serviceId: string) => Promise<string | undefined>;

export interface ClaudeProviderOptions {
  getCredential: GetCredentialFn;
  queryFactory?: ClaudeQueryFactory;
  // Credential preference; defaults to "auto" (prefer a Pro/Max subscription
  // when one is detected, else fall back to the API key).
  authPreference?: ClaudeAuthMode;
}

export class ClaudeProvider implements IAgentProvider {
  private readonly getCredential: GetCredentialFn;
  private readonly factory: ClaudeQueryFactory;
  private readonly authPreference: ClaudeAuthMode;

  constructor(options: ClaudeProviderOptions) {
    this.getCredential = options.getCredential;
    this.factory = options.queryFactory ?? new ClaudeQueryFactory();
    this.authPreference = options.authPreference ?? "auto";
  }

  // Whether this turn should strip the API key and bill the subscription:
  // explicit modes are honored verbatim; "auto" prefers a detected subscription
  // over any API key, else falls back to the key.
  private preferSubscription(): Promise<boolean> {
    if (this.authPreference === "subscription") return Promise.resolve(true);
    if (this.authPreference === "api-key") return Promise.resolve(false);
    return this.factory.detectSubscription();
  }

  getType(): string {
    return "claude";
  }

  getCapabilities(): ProviderCapabilities {
    return CLAUDE_CAPABILITIES;
  }

  async listModels(): Promise<ModelInfo[]> {
    // Deep-clone the supports block so callers can't mutate the catalog.
    return CLAUDE_MODEL_CATALOG.map((m) => ({
      ...m,
      ...(m.supports ? { supports: { ...m.supports } } : {}),
    }));
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    if (options?.abortSignal?.aborted) return;

    // Optional: absent opts the SDK into the `claude auth login` fallback.
    const token = await this.getCredential(CLAUDE_CREDENTIAL_SERVICE_ID);
    if (options?.abortSignal?.aborted) return;

    // "auto" mode probes `claude auth status` (cached); subscription wins over
    // any API key when present.
    const preferSubscription = await this.preferSubscription();
    if (options?.abortSignal?.aborted) return;

    const controller = new AbortController();
    const detachAbort = forwardAbort(options?.abortSignal, controller);

    // Shared queue interleaves SDK-derived chunks (text/thinking deltas,
    // tool blocks) with chunks pushed by in-process tool handlers via
    // ctx.emit. queue.next() awaits both producers, so a tool's text chunks
    // surface even while the SDK iterable is parked on a slow tool call.
    const queue = new ChunkQueue();
    const pushChunk = (chunk: MessageChunk) => queue.push(chunk);
    const toolProjection: ClaudeToolProjectionContext = {
      pushChunk,
      contextFactory: (): ToolContext => ({
        cwd,
        emit: pushChunk,
        abortSignal: options?.abortSignal ?? controller.signal,
      }),
      ...(options?.evaluateToolCall !== undefined
        ? { evaluateToolCall: options.evaluateToolCall }
        : {}),
      ...(options?.evaluateToolResult !== undefined
        ? { evaluateToolResult: options.evaluateToolResult }
        : {}),
    };

    let handle: ClaudeQueryHandle;
    try {
      handle = await this.factory.createQuery({
        token,
        preferSubscription,
        cwd,
        prompt,
        abortController: controller,
        ...(resumeSessionId !== undefined ? { sessionId: resumeSessionId } : {}),
        ...(options?.model !== undefined ? { model: options.model } : {}),
        ...(options?.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        ...(options?.thinking !== undefined ? { thinking: options.thinking } : {}),
        ...(options?.allowedDirectories !== undefined
          ? { allowedDirectories: options.allowedDirectories }
          : {}),
        ...(options?.tools && options.tools.length > 0
          ? { tools: options.tools, toolProjection }
          : {}),
        ...(options?.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
        ...(options?.disallowedTools !== undefined
          ? { disallowedTools: options.disallowedTools }
          : {}),
        ...(options?.registeredMcpToolNames !== undefined
          ? { registeredMcpToolNames: options.registeredMcpToolNames }
          : {}),
        ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
        // Forwarded independently of `tools`/`toolProjection` so the built-in
        // PreToolUse gate covers Bash/Edit/Write even on a turn with no keelson
        // tools (where `toolProjection` is omitted).
        ...(options?.evaluateToolCall !== undefined
          ? { evaluateToolCall: options.evaluateToolCall }
          : {}),
      });
    } catch (err) {
      detachAbort();
      const msg = buildFriendlyClaudeError(err);
      yield { type: "system", content: msg };
      throw err instanceof Error ? err : new Error(msg);
    }

    let abortedDuringStream = false;
    // Captured by the producer; thrown after queue drain so the error chunk
    // reaches the consumer before the throw.
    let terminalError: Error | null = null;

    // Drains the SDK iterable into the shared queue and closes it on end
    // (success, error, abort). Tool handlers push concurrently via their
    // captured ctx.emit closure.
    // Last API call's usage — each assistant message carries that call's
    // BetaUsage; the final one is the context-fill measure (result.usage sums
    // cache reads across calls, so it can't serve as a context gauge).
    let lastApiUsage: ClaudeApiUsage | undefined;
    // Emit the SDK session id once; the handler persists it so the next turn
    // resumes the same conversation. Resume echoes the same id back.
    let sessionIdSeen = false;
    let finishReasonSeen = false;

    const producer = (async () => {
      try {
        for await (const msg of handle) {
          // Surface the session id before the abort check: a turn aborted right
          // after the session opens should still be resumable next time, so the
          // handler must learn the id even on this iteration.
          if (!sessionIdSeen && typeof msg.session_id === "string" && msg.session_id.length > 0) {
            sessionIdSeen = true;
            options?.onSessionId?.(msg.session_id);
          }

          if (options?.abortSignal?.aborted) {
            abortedDuringStream = true;
            return;
          }

          if (msg.type === "assistant" && typeof msg.error === "string") {
            const errMsg = buildFriendlyClaudeError(new Error(msg.error));
            queue.push({ type: "error", message: errMsg });
            terminalError = new Error(errMsg);
            return;
          }
          if (msg.type === "assistant" && (msg.parent_tool_use_id ?? null) === null) {
            const finishReason = mapClaudeStopReason(msg.message?.stop_reason);
            if (!finishReasonSeen && finishReason !== undefined) {
              finishReasonSeen = true;
              options?.onFinishReason?.(finishReason);
            }
            if (msg.message?.usage !== undefined) {
              // Root-agent messages only — a Task subagent's tiny fresh context
              // must not masquerade as the conversation's fill level.
              lastApiUsage = msg.message.usage;
            }
          }

          for (const chunk of mapSdkMessageToChunks(msg)) queue.push(chunk);

          if (msg.type === "result") {
            // Emit before the error branch — an errored turn still spent tokens.
            const usage = buildClaudeTokenUsage(msg, lastApiUsage);
            if (usage !== undefined) queue.push({ type: "usage", usage });
            if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
              const errs = msg.errors && msg.errors.length > 0 ? msg.errors.join("; ") : undefined;
              const errMsg = buildFriendlyClaudeError(
                new Error(`Claude turn ended: ${msg.subtype ?? "error"}`),
                errs,
              );
              queue.push({ type: "error", message: errMsg });
              terminalError = new Error(errMsg);
            }
            return;
          }
        }
      } catch (err) {
        terminalError = err instanceof Error ? err : new Error(String(err));
      } finally {
        queue.close();
      }
    })();

    try {
      while (true) {
        if (options?.abortSignal?.aborted) {
          abortedDuringStream = true;
          break;
        }
        const chunk = await queue.next();
        if (chunk === null) break;
        // Re-check after await: consumer may have aborted while we parked.
        if (options?.abortSignal?.aborted) {
          abortedDuringStream = true;
          break;
        }
        yield chunk;
      }
      // Await so any producer rejection surfaces (not orphaned).
      await producer;
      if (terminalError) throw terminalError;
    } finally {
      detachAbort();
      // interrupt() is only supported in streaming-input mode; on success
      // or iterator failure the SDK has already torn down, so calling it
      // there would throw against a closed transport.
      if (abortedDuringStream && handle.interrupt) {
        try {
          await handle.interrupt();
        } catch {
          // interrupt failures during cleanup are non-fatal
        }
      }
    }
  }
}

// Pure; no side effects.
//
// stream_event content_block_delta → text / thinking chunks. assistant →
// tool_use chunks (text/thinking blocks skip; already streamed via deltas).
// user → tool_result chunks (SDK-injected after tool handler returns).
// assistant.error is handled before this call to avoid double-emit.
function mapSdkMessageToChunks(msg: ClaudeSdkMessage): MessageChunk[] {
  if (
    msg.type === "stream_event" &&
    msg.event?.type === "content_block_delta" &&
    msg.event.delta?.type === "text_delta" &&
    typeof msg.event.delta.text === "string" &&
    msg.event.delta.text.length > 0
  ) {
    return [{ type: "text", content: msg.event.delta.text }];
  }
  if (
    msg.type === "stream_event" &&
    msg.event?.type === "content_block_delta" &&
    msg.event.delta?.type === "thinking_delta" &&
    typeof msg.event.delta.thinking === "string" &&
    msg.event.delta.thinking.length > 0
  ) {
    return [{ type: "thinking", content: msg.event.delta.thinking }];
  }
  if (msg.type === "assistant") {
    const blocks = msg.message?.content;
    if (!blocks) return [];
    const out: MessageChunk[] = [];
    for (const block of blocks) {
      const chunk = mapContentBlock(block);
      if (chunk) out.push(chunk);
    }
    return out;
  }
  if (msg.type === "user") {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    const out: MessageChunk[] = [];
    for (const block of content) {
      const chunk = mapToolResultBlock(block);
      if (chunk) out.push(chunk);
    }
    return out;
  }
  return [];
}

function mapClaudeStopReason(reason: string | null | undefined): ProviderFinishReason | undefined {
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "end_turn" || reason === "stop_sequence") return "end";
  return undefined;
}

function mapContentBlock(block: ClaudeContentBlock): MessageChunk | null {
  if (block.type === "tool_use" && typeof block.name === "string") {
    const input = block.input;
    const inputObj =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined;
    // Block id pairs with the eventual tool_result.tool_use_id; synthesize
    // when the SDK omits it (defensive).
    const id = block.id ?? crypto.randomUUID();
    return inputObj
      ? { type: "tool_use", id, toolName: block.name, toolInput: inputObj }
      : { type: "tool_use", id, toolName: block.name };
  }
  return null;
}

// tool_use_id matches the originating assistant block. Content is string |
// Array<TextBlockParam | ...>; we join text fields and drop the rest.
function mapToolResultBlock(block: ClaudeContentBlock): MessageChunk | null {
  if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
    return null;
  }
  const content = stringifyToolResultContent(block.content);
  return {
    type: "tool_result",
    toolUseId: block.tool_use_id,
    content,
    ...(block.is_error === true ? { isError: true } : {}),
  };
}

function stringifyToolResultContent(content: ClaudeContentBlock["content"]): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  // Drop image / search-result / document blocks; chunk channel + persisted
  // shape carry a single content string today.
  const parts: string[] = [];
  for (const item of content) {
    if (item && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}

// Pure. Turn totals come from result.usage; context fill from the last
// assistant message's per-call usage (input side only — matches the
// convention Claude Code's statusline documents); contextWindow from the
// result's per-model breakdown. Returns undefined when the SDK reported no
// counts at all so callers emit nothing rather than zeros. Cache fields are
// included only when positive — a cache-miss turn's 0 would otherwise render
// as a "Cache read 0" row (the Copilot path applies the same gate).
function buildClaudeTokenUsage(
  msg: ClaudeSdkMessage,
  lastApiUsage: ClaudeApiUsage | undefined,
): TokenUsage | undefined {
  const input = toTokenCount(msg.usage?.input_tokens);
  const output = toTokenCount(msg.usage?.output_tokens);
  const cacheRead = toTokenCount(msg.usage?.cache_read_input_tokens);
  const cacheCreation = toTokenCount(msg.usage?.cache_creation_input_tokens);
  const lastInput = toTokenCount(lastApiUsage?.input_tokens);
  const lastCacheRead = toTokenCount(lastApiUsage?.cache_read_input_tokens);
  const lastCacheCreation = toTokenCount(lastApiUsage?.cache_creation_input_tokens);
  // Build whenever the SDK reported anything usable — a result whose usage
  // carries only cache counts, or no usage at all while assistant messages
  // supplied per-call context, still has data worth surfacing. Gate on the
  // sanitized last-call counts so an empty usage object ({}) doesn't pass
  // the predicate and emit zero totals with no context fields.
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheCreation === undefined &&
    lastInput === undefined &&
    lastCacheRead === undefined &&
    lastCacheCreation === undefined
  ) {
    return undefined;
  }
  const usage: TokenUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  if (cacheRead !== undefined && cacheRead > 0) usage.cacheReadInputTokens = cacheRead;
  if (cacheCreation !== undefined && cacheCreation > 0) {
    usage.cacheCreationInputTokens = cacheCreation;
  }
  if (lastInput !== undefined || lastCacheRead !== undefined || lastCacheCreation !== undefined) {
    usage.contextTokens = (lastInput ?? 0) + (lastCacheRead ?? 0) + (lastCacheCreation ?? 0);
  }
  if (msg.modelUsage !== undefined) {
    let window: number | undefined;
    for (const entry of Object.values(msg.modelUsage)) {
      const w = toTokenCount(entry?.contextWindow);
      if (w !== undefined && w > 0 && (window === undefined || w > window)) window = w;
    }
    if (window !== undefined) usage.contextWindow = window;
  }
  return usage;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);
  return () => signal.removeEventListener("abort", onAbort);
}
