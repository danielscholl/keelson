// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type {
  IAgentProvider,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  SendQueryOptions,
} from "../types.ts";
import { type CodexRawEvent, mapCodexEvent } from "./event-bridge.ts";
import {
  CodexAgentThreadFactory,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type CodexThread,
  type CodexThreadFactory,
} from "./factory.ts";

// Empty → "let codex decide" (no model on the wire). codex resolves its own
// default from ~/.codex/config.toml, which avoids forcing a model the account
// can't access.
export const CODEX_DEFAULT_MODEL = "" as const;

// Curated picker baseline. The codex CLI has no programmatic models.list, so
// this is hand-maintained (like claude). capabilities.models projects these ids
// so the two can't drift.
const CODEX_MODEL_CATALOG: readonly ModelInfo[] = [
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    description: "OpenAI's latest coding model via Codex. Needs `codex login` or OPENAI_API_KEY.",
    costTier: "high",
    supports: { tools: true, reasoningEffort: true },
  },
  {
    id: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    description: "Prior Codex coding model.",
    costTier: "mid",
    supports: { tools: true, reasoningEffort: true },
  },
  {
    id: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    description: "Original GPT-5 Codex coding model.",
    costTier: "mid",
    supports: { tools: true, reasoningEffort: true },
  },
];

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  // The chat handler persists the thread id (onSessionId) and resumes it next
  // turn (codex persists threads in ~/.codex/sessions), so context survives.
  sessionResume: true,
  streaming: true,
  // Codex runs its OWN tools inside the `codex exec` subprocess, gated by its
  // sandbox — keelson does not project its MCP/rib tools into codex, so the
  // keelson-tool-projection capability is false (codex still acts agentically;
  // that surfaces through command_execution / file_change events).
  tools: false,
  models: CODEX_MODEL_CATALOG.map((m) => m.id),
  defaultModel: CODEX_DEFAULT_MODEL,
};

// Agentic by default: codex reads the repo and writes within the conversation's
// project cwd. Overridable via config.json `codex.sandbox`.
const DEFAULT_SANDBOX_MODE: CodexSandboxMode = "workspace-write";

export interface CodexProviderOptions {
  // Injected in tests; defaults to the real lazy-loaded codex-sdk adapter.
  factory?: CodexThreadFactory;
  sandboxMode?: CodexSandboxMode;
  // codex subprocess network access; off by default for safety.
  networkAccessEnabled?: boolean;
}

// keelson reasoning tiers → codex's. keelson's "none" has no codex equivalent
// and maps to "minimal"; the remaining literals are identical.
function mapReasoningEffort(
  level: SendQueryOptions["reasoningEffort"],
): CodexReasoningEffort | undefined {
  if (level === undefined) return undefined;
  return level === "none" ? "minimal" : level;
}

export class CodexProvider implements IAgentProvider {
  private readonly factory: CodexThreadFactory;
  private readonly sandboxMode: CodexSandboxMode;
  private readonly networkAccessEnabled: boolean;

  constructor(options: CodexProviderOptions = {}) {
    this.factory = options.factory ?? new CodexAgentThreadFactory();
    this.sandboxMode = options.sandboxMode ?? DEFAULT_SANDBOX_MODE;
    this.networkAccessEnabled = options.networkAccessEnabled ?? false;
  }

  getType(): string {
    return "codex";
  }

  getCapabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  async listModels(): Promise<ModelInfo[]> {
    return CODEX_MODEL_CATALOG.map((m) => ({
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

    const reasoningEffort = mapReasoningEffort(options?.reasoningEffort);
    let thread: CodexThread;
    try {
      thread = await this.factory.createThread({
        cwd,
        sandboxMode: this.sandboxMode,
        networkAccessEnabled: this.networkAccessEnabled,
        ...(options?.model ? { model: options.model } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    } catch (err) {
      yield { type: "error", message: `codex thread failed to start: ${errMessage(err)}` };
      return;
    }
    if (options?.abortSignal?.aborted) return;

    // A resumed thread keeps its id (no thread.started fires), so echo it up
    // front to keep the handler persisting it. A new thread's id arrives on the
    // thread.started event below.
    let sessionIdSeen = false;
    if (resumeSessionId) {
      options?.onSessionId?.(resumeSessionId);
      sessionIdSeen = true;
    }

    // Codex has no SDK system-prompt slot, so the identity + recall prompt rides
    // in front of the user text. Fine while each turn re-seeds it.
    const input = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;

    const controller = new AbortController();
    const detachAbort = forwardAbort(options?.abortSignal, controller);

    let events: AsyncIterable<CodexRawEvent>;
    try {
      events = await thread.runStreamed(input, controller.signal);
    } catch (err) {
      detachAbort();
      yield { type: "error", message: `codex turn failed: ${errMessage(err)}` };
      return;
    }

    let sawError = false;
    try {
      for await (const event of events) {
        // Capture a new thread's id before the abort check: a turn aborted just
        // after the thread opens should still be resumable, so the handler must
        // learn the id even on that iteration (mirrors the claude provider).
        if (!sessionIdSeen && event.type === "thread.started") {
          const id = typeof event.thread_id === "string" ? event.thread_id : undefined;
          if (id) {
            sessionIdSeen = true;
            options?.onSessionId?.(id);
          }
        }
        if (options?.abortSignal?.aborted) break;
        for (const chunk of mapCodexEvent(event)) {
          if (chunk.type === "error") sawError = true;
          yield chunk;
        }
      }
    } catch (err) {
      // A consumer-driven abort tears the SDK stream down mid-iteration; that's
      // expected cancellation, not a turn failure. A turn.failed / error event
      // already surfaced its own error chunk, so don't double-report it.
      if (!options?.abortSignal?.aborted && !sawError) {
        yield { type: "error", message: `codex stream error: ${errMessage(err)}` };
      }
    } finally {
      detachAbort();
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
