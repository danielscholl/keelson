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
import { type PiCatalogSource, realPiCatalogSource } from "./catalog.ts";
import { mapPiEvent, mapPiFinishReason } from "./event-bridge.ts";
import { PiAgentSessionFactory, type PiSession, type PiSessionFactory } from "./factory.ts";
import { projectToolsForPi } from "./tool-projection.ts";

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
  // Keelson tools project into the session as pi custom tools; pi's own
  // built-in read/bash/edit/write stay disabled (no keelson rails).
  tools: true,
  models: PI_MODEL_CATALOG.map((m) => m.id),
  defaultModel: PI_DEFAULT_MODEL,
};

// Deep copy of the static baseline, returned when the dynamic catalog can't run.
function curatedModels(): ModelInfo[] {
  return PI_MODEL_CATALOG.map((m) => ({
    ...m,
    ...(m.supports ? { supports: { ...m.supports } } : {}),
  }));
}

export interface PiProviderOptions {
  // Injected in tests; defaults to the real lazy-loaded pi SDK adapter.
  factory?: PiSessionFactory;
  // Injected in tests; defaults to the real lazy-loaded pi SDK + auth read.
  catalogSource?: PiCatalogSource;
}

export class PiProvider implements IAgentProvider {
  private readonly factory: PiSessionFactory;
  private readonly catalogSource: PiCatalogSource;

  constructor(options: PiProviderOptions = {}) {
    this.factory = options.factory ?? new PiAgentSessionFactory();
    this.catalogSource = options.catalogSource ?? realPiCatalogSource;
  }

  getType(): string {
    return "pi";
  }

  getCapabilities(): ProviderCapabilities {
    return PI_CAPABILITIES;
  }

  // The picker's catalog: pi's real, per-vendor authenticated models (with a
  // truthful metered/subscription billing tag). Falls back to the curated
  // baseline when the source can't run — a missing pi install, an unreadable
  // auth.json, or an empty result — so the picker is never left blank.
  async listModels(): Promise<ModelInfo[]> {
    try {
      const dynamic = await this.catalogSource();
      if (dynamic.length > 0) return dynamic;
    } catch {
      // fall through to the curated baseline below
    }
    return curatedModels();
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    if (options?.abortSignal?.aborted) return;

    const queue = new ChunkQueue();
    const customTools =
      options?.tools !== undefined && options.tools.length > 0
        ? projectToolsForPi(options.tools, {
            cwd,
            pushChunk: (chunk) => queue.push(chunk),
            ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
            ...(options.turnContext !== undefined ? { turnContext: options.turnContext } : {}),
            ...(options.evaluateToolCall !== undefined
              ? { evaluateToolCall: options.evaluateToolCall }
              : {}),
          })
        : undefined;

    let session: PiSession;
    try {
      session = await this.factory.createSession({
        cwd,
        ...(options?.model ? { model: options.model } : {}),
        ...(customTools !== undefined ? { customTools } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `pi session failed to start: ${msg}` };
      return;
    }

    // createSession is slow (SDK import + auth/registry load) — an abort that
    // landed during it must not start a full, uninterruptible pi turn.
    if (options?.abortSignal?.aborted) return;

    // pi resolves the model session-side when none was requested (settings →
    // auth fallback); surface the pick so footers/pickers can show the truth.
    if (session.modelRef !== undefined) {
      yield { type: "model", model: session.modelRef };
    }

    // No system-prompt hook on a fresh pi session, so the identity + recall
    // prompt rides in front of the user text. Acceptable while sessionResume is
    // off (every turn is fresh and re-seeds it).
    const text = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;

    let unsubscribe: () => void = () => {};
    let finishReasonSeen = false;
    // Captured by the producer; surfaced after the queue drains so any error
    // chunk reaches the consumer first.
    let terminalError: Error | null = null;

    // Never rejects: subscribe + prompt run here, all failures captured into
    // terminalError, and the queue always closes — so a consumer that aborts
    // and stops awaiting can't orphan a rejecting promise.
    const producer = (async () => {
      try {
        unsubscribe = session.subscribe((event) => {
          if (!finishReasonSeen) {
            const reason = mapPiFinishReason(event);
            if (reason !== undefined) {
              finishReasonSeen = true;
              options?.onFinishReason?.(reason);
            }
          }
          for (const chunk of mapPiEvent(event)) queue.push(chunk);
        });
        // prompt() resolves only when the whole turn is done (including any pi
        // auto-retry), so the finally below is the single, correct close point.
        // Closing on an `agent_end` event would truncate a turn pi is about to
        // retry (its session agent_end carries `willRetry`).
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
      // On abort, return without awaiting the turn: pi has no interrupt, so the
      // producer only settles when prompt() finishes. It never rejects (all
      // failures are captured into terminalError), so leaving it detached is
      // safe and lets cancellation free the generator promptly.
      if (!options?.abortSignal?.aborted) {
        await producer;
        if (terminalError) {
          yield { type: "error", message: (terminalError as Error).message };
        }
      }
    } finally {
      unsubscribe();
    }
  }
}
