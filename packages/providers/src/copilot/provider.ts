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
import { buildFriendlyCopilotError, isCopilotConnectionError } from "./errors.ts";
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

// How long a warm client may sit idle (no turns) before it's evicted and its
// subprocess stopped. An idle language-server is ~0 CPU, so this is hygiene
// (bound how long a possibly-stale subprocess + token stay resident), not
// resource pressure. Operator override via KEELSON_COPILOT_WARM_IDLE_MS;
// ≤ 0 disables warmth entirely (every turn spawns fresh, the pre-warm path).
export const COPILOT_DEFAULT_WARM_IDLE_MS = 10 * 60 * 1000;

function resolveWarmIdleMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.KEELSON_COPILOT_WARM_IDLE_MS;
  if (raw === undefined || raw.trim() === "") return COPILOT_DEFAULT_WARM_IDLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : COPILOT_DEFAULT_WARM_IDLE_MS;
}

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
  // Idle-eviction window for the warm client; see COPILOT_DEFAULT_WARM_IDLE_MS.
  // Tests pass a small value (or ≤ 0 to disable warmth) to exercise eviction
  // deterministically without waiting out the 10-minute default.
  idleMs?: number;
}

// A started, reusable client plus the SDK identity it was constructed with.
// `token` / `cwd` key the cache: a turn whose credential or working directory
// differs evicts and respawns, so a warm client never serves stale auth or the
// wrong workspace root.
interface WarmClient {
  client: CopilotClientLike;
  permissionHandler: CopilotPermissionHandler;
  token: string | undefined;
  cwd: string;
  // How many in-flight turns are streaming on this client. Eviction defers the
  // stop() while this is > 0 so a concurrent turn (e.g. a different workspace
  // that thrashes the single warm slot) can't kill a subprocess mid-stream.
  inUse: number;
  // Set when eviction wanted to stop a client that was still in use; the last
  // turn to release it performs the deferred stop.
  stopRequested: boolean;
}

class RetryableConnectionError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RetryableConnectionError";
  }
}

// The warm client lives as instance state, so the instance must outlive a
// single turn. registration.ts registers this provider as a process-lifetime
// singleton (one instance returned from every getAgentProvider("copilot")
// call) precisely so that warmth — and the disposeAllProviders() drain —
// span turns; the default per-turn-provider shape would discard it each turn.
export class CopilotProvider implements IAgentProvider {
  private readonly getCredential: GetCredentialFn;
  private readonly factory: CopilotClientFactory;
  private readonly idleMs: number;
  // Process-lifetime cache; CLI spawn for listModels costs ~1s.
  private modelListCache: Promise<ModelInfo[]> | null = null;
  // The single warm client reused across turns, or null when none is resident.
  private warm: WarmClient | null = null;
  // In-flight spawn, so concurrent first turns coalesce onto one subprocess
  // rather than racing two into existence. The generation tags each spawn so a
  // turn's finally only clears the slot it set (a concurrent spawn may have
  // replaced it) — a numeric tag, not the promise itself, to keep the identity
  // check out of an await-less comparison.
  private warmCreating: Promise<WarmClient> | null = null;
  private warmCreatingGen = 0;
  // Set once dispose() runs so an in-flight spawn that resolves afterward
  // doesn't re-cache a client onto an already-drained provider.
  private disposed = false;
  // Fires idleMs after the last turn to stop a possibly-stale subprocess.
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Detached teardowns (evicted clients, per-turn session disconnects). The SDK
  // runtime shutdown can take up to 10s, so we never await it on the turn's
  // critical path; this set only lets dispose() join in-flight ones at exit.
  private readonly pendingTeardowns = new Set<Promise<void>>();

  constructor(options: CopilotProviderOptions) {
    this.getCredential = options.getCredential;
    this.factory = options.clientFactory ?? new CopilotClientFactory();
    this.idleMs = resolveWarmIdleMs(options.idleMs);
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

  // Stops the warm client and joins every in-flight detached teardown. Wired
  // into the server shutdown drain and the in-process CLI exit via the
  // registry's disposeAllProviders(); also the deterministic join tests use.
  // At shutdown we stop unconditionally — any in-flight turn is being torn
  // down anyway, so we don't defer on its hold.
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelIdleTimer();
    const warm = this.warm;
    this.warm = null;
    if (warm) this.trackTeardown(settleCopilotTeardown(warm.client));
    // A spawn still in flight when shutdown began would otherwise resolve and
    // cache a started client after the drain. acquireClient's disposed guard
    // stops it from caching; stop the resolved subprocess here so it's reaped.
    const creating = this.warmCreating;
    if (creating) {
      this.trackTeardown(
        creating.then(
          (w) => settleCopilotTeardown(w.client),
          () => {},
        ),
      );
    }
    await Promise.allSettled([...this.pendingTeardowns]);
  }

  // Returns a started client for (token, cwd), reusing the warm one when its
  // credential and workspace still match. A mismatch (re-auth, token rotation,
  // workspace switch) evicts the stale client first so we never serve a turn on
  // a subprocess holding the wrong token. Concurrent callers coalesce onto a
  // single in-flight spawn.
  private async acquireClient(token: string | undefined, cwd: string): Promise<WarmClient> {
    if (this.warm && this.warm.token === token && this.warm.cwd === cwd) {
      return this.warm;
    }
    if (this.warmCreating) {
      try {
        const inflight = await this.warmCreating;
        if (inflight.token === token && inflight.cwd === cwd) return inflight;
      } catch {
        // The in-flight spawn failed; fall through and try our own.
      }
    }
    if (this.warm) this.evictWarm();
    const gen = ++this.warmCreatingGen;
    const creating = this.spawnClient(token, cwd);
    this.warmCreating = creating;
    try {
      const warm = await creating;
      // Shutdown drained while we were spawning — don't re-cache onto a
      // disposed provider; dispose() reaps the subprocess via warmCreating.
      if (this.disposed) {
        throw new Error("Copilot provider is disposed");
      }
      this.warm = warm;
      return warm;
    } finally {
      if (this.warmCreatingGen === gen) this.warmCreating = null;
    }
  }

  private async spawnClient(token: string | undefined, cwd: string): Promise<WarmClient> {
    const created = await this.factory.createClient(token, cwd);
    return {
      client: created.client,
      permissionHandler: created.permissionHandler,
      token,
      cwd,
      inUse: 0,
      stopRequested: false,
    };
  }

  private retain(warm: WarmClient): void {
    warm.inUse += 1;
  }

  // Release a turn's hold; if eviction deferred the stop while we held it,
  // perform it now that no turn is streaming on the client.
  private release(warm: WarmClient): void {
    warm.inUse -= 1;
    if (warm.inUse <= 0 && warm.stopRequested) {
      warm.stopRequested = false;
      this.trackTeardown(settleCopilotTeardown(warm.client));
    }
  }

  // Stop a client, or defer the stop if a turn is still streaming on it.
  private dropClient(warm: WarmClient): void {
    if (warm.inUse > 0) {
      warm.stopRequested = true;
      return;
    }
    this.trackTeardown(settleCopilotTeardown(warm.client));
  }

  // Drop a specific client (e.g. a wedged one a turn just abandoned), clearing
  // the cache slot only if it still points at that client — so a concurrent
  // turn that already replaced the warm slot isn't disturbed.
  private discardClient(warm: WarmClient): void {
    if (this.warm === warm) {
      this.cancelIdleTimer();
      this.warm = null;
    }
    this.dropClient(warm);
  }

  private async openSession(
    warm: WarmClient,
    resumeSessionId: string | undefined,
    config: unknown,
  ): Promise<CopilotSessionLike> {
    return resumeSessionId
      ? warm.client.resumeSession(resumeSessionId, config)
      : warm.client.createSession(config);
  }

  // Open a session on the warm client; if that fails in a connection-y way (a
  // wedged or dead subprocess), drop the client, respawn fresh, and retry once.
  // Without this, one bad subprocess would poison every subsequent turn. Auth /
  // rate-limit failures are NOT connection errors, so they surface immediately
  // rather than burning a pointless respawn.
  //
  // The lease is taken BEFORE the first open await so a concurrent eviction
  // (a different-workspace turn thrashing the warm slot) defers the stop()
  // rather than killing the subprocess mid-open. On success the returned client
  // carries that one lease, which the caller releases; on any throw the lease
  // is released here so nothing leaks.
  private async openSessionWithRetry(
    warm: WarmClient,
    token: string | undefined,
    cwd: string,
    resumeSessionId: string | undefined,
    buildConfig: (handler: CopilotPermissionHandler) => unknown,
  ): Promise<{ warm: WarmClient; session: CopilotSessionLike }> {
    this.retain(warm);
    try {
      const session = await this.openSession(
        warm,
        resumeSessionId,
        buildConfig(warm.permissionHandler),
      );
      return { warm, session };
    } catch (err) {
      if (!isCopilotConnectionError(err)) {
        this.release(warm);
        throw err;
      }
      // Hand the lease from the wedged client to a fresh respawn.
      this.release(warm);
      this.discardClient(warm);
      const fresh = await this.acquireClient(token, cwd);
      this.retain(fresh);
      try {
        const session = await this.openSession(
          fresh,
          resumeSessionId,
          buildConfig(fresh.permissionHandler),
        );
        return { warm: fresh, session };
      } catch (retryErr) {
        // The respawn is wedged too — drop it so it isn't left cached, and let
        // the caller surface the failure.
        this.release(fresh);
        this.discardClient(fresh);
        throw retryErr;
      }
    }
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // Drop the cached client (idle timeout, credential/workspace change). The
  // stop() is detached — the SDK force-kills the runtime if graceful shutdown
  // times out — and deferred while a turn still streams on it.
  private evictWarm(): void {
    this.cancelIdleTimer();
    const warm = this.warm;
    this.warm = null;
    if (warm) this.dropClient(warm);
  }

  private trackTeardown(teardown: Promise<void>): void {
    this.pendingTeardowns.add(teardown);
    void teardown.finally(() => this.pendingTeardowns.delete(teardown));
  }

  // (Re)arm the idle-eviction timer after a turn. unref so a resident warm
  // client never keeps the process (or a one-shot CLI) alive on its own.
  private armIdleTimer(): void {
    this.cancelIdleTimer();
    if (!this.warm) return;
    // idleMs ≤ 0 opts out of warmth: evict now so the next turn respawns.
    if (this.idleMs <= 0) {
      this.evictWarm();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.evictWarm();
    }, this.idleMs);
    this.idleTimer.unref?.();
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

    for (let attempt = 0; attempt < 2; attempt++) {
      if (options?.abortSignal?.aborted) return;

      // Acquire the warm client (reused across turns; spawned on the first turn
      // or after eviction). A spawn failure surfaces as a friendly system error,
      // the same shape as a session-open failure below.
      let warm: WarmClient;
      try {
        warm = await this.acquireClient(token, cwd);
      } catch (err) {
        const msg = buildFriendlyCopilotError(err);
        yield { type: "system", content: msg };
        throw err instanceof Error ? err : new Error(msg);
      }

      // Abort raced the spawn: leave the client warm for the next turn rather
      // than stopping it, and don't open a session or send. Arm the idle timer so
      // a freshly spawned, then-abandoned client is still bounded by eviction.
      if (options?.abortSignal?.aborted) {
        this.armIdleTimer();
        return;
      }

      // A turn is starting on the warm client: cancel any pending idle eviction
      // so a timer armed by the previous turn can't fire mid-stream here.
      this.cancelIdleTimer();

      try {
        yield* this.streamTurn(prompt, warm, token, cwd, resumeSessionId, options, attempt === 0);
        return;
      } catch (err) {
        if (err instanceof RetryableConnectionError && attempt === 0) {
          continue;
        }
        if (err instanceof RetryableConnectionError) {
          yield { type: "error", message: err.message };
          throw err.cause ?? err;
        }
        throw err;
      }
    }
  }

  private async *streamTurn(
    prompt: string,
    warm: WarmClient,
    token: string | undefined,
    cwd: string,
    resumeSessionId: string | undefined,
    options: SendQueryOptions | undefined,
    canRetry: boolean,
  ): AsyncGenerator<MessageChunk> {
    const queue = new ChunkQueue();
    const unsubs: Array<() => void> = [];
    let session: CopilotSessionLike | null = null;
    let lastSessionError: string | null = null;
    let yieldedContent = false;
    const yieldChunk = (chunk: MessageChunk): MessageChunk => {
      yieldedContent = true;
      return chunk;
    };
    // Set when the turn fails in a connection-y way so the finally drops the
    // warm client (a wedged subprocess shouldn't poison the next turn). On a
    // clean turn the client stays warm and only this turn's session is released.
    let connectionFailure = false;
    // The client this turn ends up streaming on (openSessionWithRetry may swap
    // to a freshly respawned one) and whether we hold a refcount on it.
    let activeWarm = warm;
    let retained = false;

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
        const opened = await this.openSessionWithRetry(
          warm,
          token,
          cwd,
          resumeSessionId,
          (handler) => buildSessionConfig(options, handler, cwd, toolProjection),
        );
        session = opened.session;
        activeWarm = opened.warm;
        // openSessionWithRetry returns the client holding one lease; we own it
        // now and release it in the finally. The lease was taken before the
        // open await, so a concurrent eviction defers the stop() rather than
        // killing this subprocess mid-stream.
        retained = true;
      } catch (err) {
        // Session open failed even after the connection-respawn retry — the
        // lease is already released inside openSessionWithRetry. Drop the client
        // if it was a connection fault so the next turn starts clean.
        connectionFailure = isCopilotConnectionError(err);
        const msg = buildFriendlyCopilotError(err);
        yield yieldChunk({ type: "system", content: msg });
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
          yield yieldChunk({ type: "system", content: `setModel failed: ${msg}` });
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
      // The model that served the turn's root-agent calls. Copilot resolves
      // "auto" session-side; each usage event names the model that served that
      // API call, so surfacing it (deduped, last wins on a mid-turn switch)
      // lets downstream ledgers record what actually ran rather than the
      // requested alias. Sub-agent calls (top-level agentId set) are skipped so
      // a helper's model can't masquerade as the turn's.
      let reportedModel: string | undefined;
      unsubs.push(
        session.on("assistant.usage", (event: unknown) => {
          const servedModel = readString(event, "model");
          if (
            servedModel !== undefined &&
            servedModel.length > 0 &&
            servedModel !== reportedModel &&
            readTopLevelString(event, "agentId") === undefined
          ) {
            reportedModel = servedModel;
            queue.push({ type: "model", model: servedModel });
          }
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
          turnInput += Math.max(
            0,
            (input ?? 0) - (cacheRead ?? 0) - (cacheWrite ?? 0),
          );
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
        yield yieldChunk(chunk);
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
        yield yieldChunk({ type: "usage", usage });
      }

      // Session errors carry typed errorType (auth, rate_limit) — more
      // informative than a bare send rejection.
      if (lastSessionError) {
        connectionFailure = isCopilotConnectionError(lastSessionError);
        const msg = buildFriendlyCopilotError(lastSessionError);
        if (connectionFailure && canRetry && !yieldedContent) {
          throw new RetryableConnectionError(msg, new Error(msg));
        }
        yield yieldChunk({ type: "error", message: msg });
        throw new Error(msg);
      }
      if (sendError) {
        connectionFailure = isCopilotConnectionError(sendError);
        const msg = buildFriendlyCopilotError(sendError);
        if (connectionFailure && canRetry && !yieldedContent) {
          throw new RetryableConnectionError(msg, sendError);
        }
        yield yieldChunk({ type: "error", message: msg });
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
      // Drop our refcount first so a deferred stop can fire once we're done.
      if (retained) this.release(activeWarm);
      // The warm client survives the turn — this turn's session is released and
      // the idle timer rearmed, so the next turn skips the ~3s cold start. A
      // connection-y failure is the exception: drop the client we streamed on so
      // a wedged subprocess can't poison subsequent turns. (A failure before we
      // retained — open never succeeded — is already cleaned up by
      // openSessionWithRetry, so there's nothing to drop here.) Both the session
      // disconnect and the stop() are detached (the SDK runtime ack can take up
      // to 10s); dispose() joins them at exit.
      if (connectionFailure) {
        if (retained) this.discardClient(activeWarm);
      } else {
        if (session) this.trackTeardown(settleSessionDisconnect(session));
        this.armIdleTimer();
      }
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

// Release just this turn's session, leaving the warm client (and its
// subprocess) up for the next turn. Detached from the turn for the same reason
// stop() is: it round-trips the runtime and shouldn't stall the generator's
// return. Never rejects — a disconnect failure is non-fatal.
async function settleSessionDisconnect(session: CopilotSessionLike): Promise<void> {
  try {
    await session.disconnect();
  } catch {
    // disconnect errors during cleanup are non-fatal
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

// Reads a field beside `data` on the event envelope (e.g. `agentId`, which the
// SDK stamps on sub-agent events), unlike readString which reads inside `data`.
function readTopLevelString(event: unknown, key: string): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const v = (event as Record<string, unknown>)[key];
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
