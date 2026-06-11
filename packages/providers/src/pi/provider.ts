// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { ChunkQueue } from "../chunk-queue.ts";
import type {
  IAgentProvider,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  SendQueryOptions,
} from "../types.ts";
import { mapPiEvent } from "./event-bridge.ts";
import { PiAgentSessionFactory, type PiSession, type PiSessionFactory } from "./factory.ts";

// Empty → "let pi decide" (no model on the wire). pi is multi-vendor, so there
// is no single right default; pi picks from the user's own settings/auth.
export const PI_DEFAULT_MODEL = "" as const;

// Curated subset of pi's model registry (vendor/model refs). pi supports many
// more vendors and models; this is the picker baseline. listModels() and
// capabilities.models share this so the two can't drift.
const PI_MODEL_CATALOG: readonly ModelInfo[] = [
  {
    id: "anthropic/claude-opus-4.5",
    displayName: "Claude Opus 4.5 (pi)",
    description: "Anthropic via pi. Needs ANTHROPIC_API_KEY or pi auth.",
    costTier: "high",
    supports: { tools: true, thinking: true },
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6 (pi)",
    description: "Balanced Anthropic model via pi.",
    costTier: "mid",
    supports: { tools: true, thinking: true },
  },
  {
    id: "anthropic/claude-haiku-4.5",
    displayName: "Claude Haiku 4.5 (pi)",
    description: "Fast, low-cost Anthropic model via pi.",
    costTier: "low",
    supports: { tools: true, thinking: true },
  },
  {
    id: "google/gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro (pi)",
    description: "Google via pi. Needs GEMINI_API_KEY or pi auth.",
    costTier: "mid",
    supports: { tools: true, thinking: true },
  },
  {
    id: "google/gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash (pi)",
    description: "Fast Google model via pi.",
    costTier: "low",
    supports: { tools: true },
  },
];

export const PI_CAPABILITIES: ProviderCapabilities = {
  // No server-side session resume wired yet — each turn is a fresh pi session.
  sessionResume: false,
  streaming: true,
  // pi's built-in tools are disabled (no keelson rails); keelson MCP/rib tools
  // are not yet projected to pi. Pure chat/reasoning for now.
  tools: false,
  models: PI_MODEL_CATALOG.map((m) => m.id),
  defaultModel: PI_DEFAULT_MODEL,
};

export interface PiProviderOptions {
  // Injected in tests; defaults to the real lazy-loaded pi SDK adapter.
  factory?: PiSessionFactory;
}

export class PiProvider implements IAgentProvider {
  private readonly factory: PiSessionFactory;

  constructor(options: PiProviderOptions = {}) {
    this.factory = options.factory ?? new PiAgentSessionFactory();
  }

  getType(): string {
    return "pi";
  }

  getCapabilities(): ProviderCapabilities {
    return PI_CAPABILITIES;
  }

  async listModels(): Promise<ModelInfo[]> {
    return PI_MODEL_CATALOG.map((m) => ({
      ...m,
      ...(m.supports ? { supports: { ...m.supports } } : {}),
    }));
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    if (options?.abortSignal?.aborted) return;

    let session: PiSession;
    try {
      session = await this.factory.createSession({
        cwd,
        ...(options?.model ? { model: options.model } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `pi session failed to start: ${msg}` };
      return;
    }

    // No system-prompt hook on a fresh pi session, so the identity + recall
    // prompt rides in front of the user text. Acceptable while sessionResume is
    // off (every turn is fresh and re-seeds it).
    const text = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;

    const queue = new ChunkQueue();
    let unsubscribe: () => void = () => {};
    // Captured by the producer; surfaced after the queue drains so any error
    // chunk reaches the consumer first.
    let terminalError: Error | null = null;

    // Never rejects: subscribe + prompt run here, all failures captured into
    // terminalError, and the queue always closes — so a consumer that aborts
    // and stops awaiting can't orphan a rejecting promise.
    const producer = (async () => {
      try {
        unsubscribe = session.subscribe((event) => {
          for (const chunk of mapPiEvent(event)) queue.push(chunk);
          // pi signals end-of-turn with agent_end; close so the consumer ends
          // even if prompt() is still settling its promise.
          if (event.type === "agent_end") queue.close();
        });
        await session.prompt(text);
      } catch (err) {
        terminalError = err instanceof Error ? err : new Error(String(err));
      } finally {
        queue.close();
      }
    })();

    try {
      while (true) {
        if (options?.abortSignal?.aborted) break;
        const chunk = await queue.next();
        if (chunk === null) break;
        if (options?.abortSignal?.aborted) break;
        yield chunk;
      }
      await producer;
      if (terminalError) {
        yield { type: "error", message: (terminalError as Error).message };
      }
    } finally {
      unsubscribe();
    }
  }
}
