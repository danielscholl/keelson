// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { ChunkQueue } from "../chunk-queue.ts";
import { deriveModelClasses } from "../model-classes.ts";
import type {
  IAgentProvider,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  SendQueryOptions,
} from "../types.ts";
import { type PiCatalogSource, realPiCatalogSource } from "./catalog.ts";
import { PiVendorSlots } from "./concurrency.ts";
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
    id: "anthropic/claude-opus-5-5",
    displayName: "Claude Opus 5.5 (pi)",
    description: "Anthropic via pi. Needs ANTHROPIC_API_KEY or pi auth.",
    costTier: "high",
    supports: { tools: true, thinking: true },
  },
  {
    id: "anthropic/claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5 (pi)",
    description: "Balanced Anthropic model via pi.",
    costTier: "mid",
    supports: { tools: true, thinking: true },
  },
  {
    id: "anthropic/claude-haiku-5-5",
    displayName: "Claude Haiku 5.5 (pi)",
    description: "Fast, low-cost Anthropic model via pi.",
    costTier: "low",
    supports: { tools: true, thinking: true },
  },
  {
    id: "google/gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro (pi)",
    description: "Google via pi. Needs GEMINI_API_KEY or pi auth.",
    costTier: "mid",
    supports: { tools: true, thinking: true },
  },
  {
    id: "google/gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash (pi)",
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
  reasoningEffort: false,
  models: PI_MODEL_CATALOG.map((m) => m.id),
  defaultModel: PI_DEFAULT_MODEL,
  modelClasses: deriveModelClasses(PI_MODEL_CATALOG, PI_DEFAULT_MODEL),
};

// Capabilities with config `pi.model` as the default: it becomes every tier's
// class unless `pi.modelClasses` overrides one, so a node that names no model
// runs on it instead of pi's own settings default.
export function piCapabilities(defaultModel?: string): ProviderCapabilities {
  if (!defaultModel) return PI_CAPABILITIES;
  return {
    ...PI_CAPABILITIES,
    models: [defaultModel, ...PI_CAPABILITIES.models.filter((m) => m !== defaultModel)],
    defaultModel,
    modelClasses: { fast: defaultModel, balanced: defaultModel, deep: defaultModel },
  };
}

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
  // pi's built-in coding tools behind keelson's policy gates. Default on;
  // config `pi.builtinTools: false` turns them off.
  builtinTools?: boolean;
  // Shared per-vendor turn limits (config `pi.concurrency`). Registration hands
  // every PiProvider the same instance so the limit spans all turns.
  slots?: PiVendorSlots;
  // Allowlist of pi vendors keelson may use (config `pi.vendors`), e.g.
  // ["rec"] for local-only. Unset = every vendor pi can authenticate.
  vendors?: readonly string[];
  // config `pi.model`: the model a turn runs on when it names none.
  defaultModel?: string;
  // Absolute pi extension paths (resolved from config `pi.extensions`).
  extensionPaths?: readonly string[];
  // Extension-registered tools a session may call (config `pi.extensionTools`).
  extensionTools?: readonly string[];
  // Default seconds for a bash call that sets no timeout (config
  // `pi.bashTimeoutSec`); defaults to 300.
  bashTimeoutSec?: number;
  // Identical call + identical result repeats allowed before the call is
  // blocked (config `pi.repeatCallLimit`); defaults to 3, 0 disables.
  repeatCallLimit?: number;
}

export class PiProvider implements IAgentProvider {
  private readonly factory: PiSessionFactory;
  private readonly catalogSource: PiCatalogSource;
  private readonly builtinTools: boolean;
  private readonly slots: PiVendorSlots;
  private readonly vendors: ReadonlySet<string> | undefined;
  private readonly capabilities: ProviderCapabilities;
  private readonly extensionPaths: readonly string[];
  private readonly extensionTools: readonly string[];
  private readonly bashTimeoutSec: number;
  private readonly repeatCallLimit: number;

  constructor(options: PiProviderOptions = {}) {
    this.factory = options.factory ?? new PiAgentSessionFactory();
    this.catalogSource = options.catalogSource ?? realPiCatalogSource;
    this.builtinTools = options.builtinTools ?? true;
    this.slots = options.slots ?? new PiVendorSlots();
    this.capabilities = piCapabilities(options.defaultModel);
    this.extensionPaths = options.extensionPaths ?? [];
    this.extensionTools = options.extensionTools ?? [];
    this.bashTimeoutSec = options.bashTimeoutSec ?? 300;
    this.repeatCallLimit = options.repeatCallLimit ?? 3;
    this.vendors =
      options.vendors !== undefined && options.vendors.length > 0
        ? new Set(options.vendors)
        : undefined;
  }

  getType(): string {
    return "pi";
  }

  private allows(modelRef: string): boolean {
    return this.vendors === undefined || this.vendors.has(modelRef.split("/")[0] ?? "");
  }

  getCapabilities(): ProviderCapabilities {
    return this.capabilities;
  }

  // The picker's catalog: pi's real, per-vendor authenticated models (with a
  // truthful metered/subscription billing tag). Falls back to the curated
  // baseline when the source can't run — a missing pi install, an unreadable
  // auth.json, or an empty result — so the picker is never left blank.
  async listModels(): Promise<ModelInfo[]> {
    return (await this.listModelsLive()) ?? curatedModels().filter((m) => this.allows(m.id));
  }

  async listModelsLive(): Promise<ModelInfo[] | null> {
    try {
      const dynamic = (await this.catalogSource()).filter((m) => this.allows(m.id));
      if (dynamic.length > 0) return dynamic;
    } catch {
      return null;
    }
    return null;
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
            ...(options.evaluateToolResult !== undefined
              ? { evaluateToolResult: options.evaluateToolResult }
              : {}),
          })
        : undefined;

    const requestedModel = options?.model || this.capabilities.defaultModel || undefined;
    let session: PiSession;
    try {
      session = await this.factory.createSession({
        cwd,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(this.capabilities.defaultModel && this.capabilities.defaultModel !== requestedModel
          ? { fallbackModel: this.capabilities.defaultModel }
          : {}),
        ...(customTools !== undefined ? { customTools } : {}),
        gates: {
          ...(options?.evaluateToolCall !== undefined
            ? { evaluateToolCall: options.evaluateToolCall }
            : {}),
          ...(options?.evaluateToolResult !== undefined
            ? { evaluateToolResult: options.evaluateToolResult }
            : {}),
        },
        builtinTools: this.builtinTools,
        bashTimeoutSec: this.bashTimeoutSec,
        repeatCallLimit: this.repeatCallLimit,
        ...(this.extensionPaths.length > 0 ? { extensionPaths: this.extensionPaths } : {}),
        ...(this.extensionTools.length > 0 ? { extensionTools: this.extensionTools } : {}),
        ...(options?.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
        ...(options?.disallowedTools !== undefined
          ? { disallowedTools: options.disallowedTools }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `pi session failed to start: ${msg}` };
      return;
    }

    // createSession is slow (SDK import + auth/registry load) — an abort that
    // landed during it must not start a full, uninterruptible pi turn.
    if (options?.abortSignal?.aborted) return;

    // Checked before prompt(), so a disallowed vendor never receives a request.
    if (this.vendors !== undefined && !this.allows(session.modelRef ?? "")) {
      session.dispose?.();
      yield {
        type: "error",
        message: `pi resolved "${session.modelRef ?? "no model"}"${requestedModel ? ` for "${requestedModel}"` : ""}, which is outside pi.vendors (${[...this.vendors].join(", ")}); refusing to run the turn.`,
      };
      return;
    }

    // pi resolves the model session-side when none was requested (settings →
    // auth fallback); surface the pick so footers/pickers can show the truth.
    if (session.modelRef !== undefined) {
      yield { type: "model", model: session.modelRef };
    }
    // An unresolvable ref falls back to pi's settings default, which may be a
    // different vendor entirely — say so rather than switch routes silently.
    if (requestedModel && session.modelRef !== undefined && session.modelRef !== requestedModel) {
      yield {
        type: "system",
        content: `pi could not resolve model "${requestedModel}" (not in ~/.pi/agent models or not authenticated); running "${session.modelRef}" instead.`,
      };
    }

    const vendor = session.modelRef?.split("/")[0] ?? "";
    if (this.slots.isSaturated(vendor)) {
      yield { type: "system", content: `Waiting for a free '${vendor}' slot…` };
    }
    const release = await this.slots.acquire(vendor, options?.abortSignal);
    if (release === null) return;

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
    const onAbort = () => {
      void session.abort?.().catch(() => {});
    };
    options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
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
        // Released when pi's turn actually ends, not when the consumer stops
        // reading: an abort asks pi to stop, but the slot frees only once it has.
        options?.abortSignal?.removeEventListener("abort", onAbort);
        release();
        session.dispose?.();
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
      // On abort, return without awaiting the turn: the producer settles once
      // pi's abort lands and prompt() returns. It never rejects (all failures
      // are captured into terminalError), so leaving it detached is safe and
      // lets cancellation free the generator promptly.
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
