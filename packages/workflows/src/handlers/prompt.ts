// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `prompt` NodeHandler. Opens an `IAgentProvider` session per node, fans the
 * streamed chunks back to the run consumer via `ctx.emit`, accumulates the
 * assistant text into `NodeResult.output.text`, and surfaces `failed` on
 * provider errors / timeouts / aborts.
 *
 * Architectural rules:
 *
 * - This package has NO dependency on apps/server. The provider, tool registry,
 *   and lifecycle hooks are injected via factory options so the handler stays
 *   pure relative to the harness wiring.
 * - The run consumer (apps/server/src/workflows-handler.ts) re-accumulates
 *   `contentParts` from the chunk events it sees in `onEvent`, so this handler
 *   does NOT compute or surface structured content blocks itself.
 *
 * The chunks emitted via `ctx.emit({ type: "node_chunk", chunk })` are typed
 * as `unknown` on the executor's `NodeStreamEvent` boundary; consumers (and
 * the workflowFrameSchema validator) cast back to `MessageChunk` at the edge.
 */

import type { NodeHandler, NodeResult } from "../executor.ts";
import { buildOutputFormatSuffix, extractJsonValue } from "./output-format.ts";

// Loosely-typed handles to avoid pulling @keelson/providers and
// @keelson/shared into this package's dep graph. The composition root
// satisfies these at construction time.
export interface PromptHandlerProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: PromptHandlerSendOptions,
  ): AsyncGenerator<unknown>;
  // Optional structural mirror of `IAgentProvider.getType()`. Used only
  // by the per-run provider-mismatch warning (Slice 4). Spy / fake
  // providers in tests can omit it; the handler treats the absence as
  // "unknown provider" and skips the warning.
  getType?(): string;
  // Optional structural mirror of `IAgentProvider.getCapabilities()`.
  // Consulted as the final fallback in the model-resolution chain so the
  // routing decision stays visible to Keelson rather than deferring to
  // the SDK's own default. Spy / fake providers may omit it.
  getCapabilities?(): { defaultModel?: string };
}

export interface PromptHandlerSendOptions {
  abortSignal?: AbortSignal;
  tools?: readonly { name: string; [k: string]: unknown }[];
  model?: string;
  systemPrompt?: string;
  // SDK-level whitelist / blacklist by tool name (built-ins + MCP). Empty
  // `allowedTools` array means the model has no tools at all.
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  // Unfiltered registered-MCP tool name set — passed alongside `tools`
  // (which carries the post-filter MCP projection) so a Claude provider
  // can correctly identify MCP names even when one was filtered out by
  // the global denylist.
  registeredMcpToolNames?: readonly string[];
  // Per-node hook matchers from the vendored schema. Forwarded verbatim
  // to the provider, which projects them into the SDK's hook protocol.
  hooks?: Readonly<
    Record<
      string,
      Array<{
        matcher?: string;
        response: Record<string, unknown>;
        timeout?: number;
      }>
    >
  >;
}

export interface PromptHandlerLifecycle {
  beforeNode?: (ctx: { runId: string; nodeId: string }) => void | Promise<void>;
  afterNode?: (ctx: { runId: string; nodeId: string }, result: NodeResult) => void | Promise<void>;
}

export interface MakePromptHandlerOptions {
  /**
   * Resolves the provider to use for this node. Called once per invocation
   * with the effective provider id (`node.provider ?? workflow.provider`),
   * or undefined when neither is set — the resolver then picks its default.
   * Throwing surfaces as a normal failed `NodeResult` via the handler's
   * provider-error path.
   */
  getProvider: (id?: string) => PromptHandlerProvider;
  /** Registered tool catalog. Called once per node invocation so post-boot registrations are picked up. */
  getRegisteredTools: () => readonly { name: string; [k: string]: unknown }[];
  /** Tool names to exclude. Defaults to DEFAULT_TOOL_DENYLIST when undefined; an explicit empty array allows everything. */
  denylist?: readonly string[];
  /**
   * Tool names that are OFF by default in a prompt node and only appear when
   * the node explicitly opts in via `allowed_tools`. The harness fills this
   * with rib-registered tool names so a workflow inherits no rib tool it didn't
   * ask for (least-privilege), while still being able to call one it lists.
   * The global denylist always still applies on top.
   */
  defaultOffTools?: readonly string[];
  /** Per-node timeout in milliseconds. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Memory hook seam. Default is no-ops; reserved for the future memory layer. */
  lifecycle?: PromptHandlerLifecycle;
  /** Optional system prompt to seed every prompt-node session. */
  systemPrompt?: string;
}

// Default denylist is empty — Keelson core has no built-in tools, and ribs
// register their own destructive surface. Operators set
// KEELSON_WORKFLOW_TOOL_DENYLIST to forbid specific tool names, or pass
// `denylist` explicitly when constructing the prompt handler.
export const DEFAULT_TOOL_DENYLIST: readonly string[] = [];

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function makePromptHandler(opts: MakePromptHandlerOptions): NodeHandler {
  const denySet = new Set(opts.denylist ?? DEFAULT_TOOL_DENYLIST);
  const defaultOffSet = new Set(opts.defaultOffTools ?? []);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lifecycle = opts.lifecycle ?? {};
  const systemPrompt = opts.systemPrompt;

  return {
    type: "prompt",
    async handle(node, ctx): Promise<NodeResult> {
      // Lifecycle: beforeNode (memory recall plugs in here). Errors here
      // MUST NOT take the node down — the seam is a hook, not an oracle.
      try {
        await lifecycle.beforeNode?.({ runId: ctx.runId, nodeId: ctx.nodeId });
      } catch {
        // swallow — hooks are best-effort
      }

      // Race the provider stream against ctx.abortSignal (run cancel) and a
      // node-level timeout. handlerExit is the single source of truth for
      // "the handler is done" — both cancel and timeout flip it. Whatever
      // happens to the provider (even a hung sendQuery that never honors
      // abort), the race below guarantees handle() returns within bounded
      // time.
      const handlerExit = new AbortController();
      let timedOut = false;
      let cancelled = false;
      const onUserCancel = (): void => {
        cancelled = true;
        handlerExit.abort();
      };
      if (ctx.abortSignal.aborted) {
        cancelled = true;
        handlerExit.abort();
      } else {
        ctx.abortSignal.addEventListener("abort", onUserCancel, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        handlerExit.abort();
      }, timeoutMs);

      const allTools = opts.getRegisteredTools();

      // Per-node fields from the vendored schema if present. Cast through
      // `unknown`-shaped accessors because the executor's DagNode is a
      // discriminated union and these fields live on the prompt-shaped
      // member.
      const nodeModelRaw = (node as { model?: unknown }).model;
      const workflowModelRaw = ctx.workflow.model;
      // Resolution chain: node.model → workflow.model → provider.defaultModel.
      // The third step is deferred to consume(): it needs a successfully
      // resolved provider, and resolving it there keeps the fallback on the
      // same code path that surfaces unknown-provider errors as a failed
      // NodeResult.
      let model: string | undefined;
      if (typeof nodeModelRaw === "string" && nodeModelRaw.length > 0) {
        model = nodeModelRaw;
      } else if (typeof workflowModelRaw === "string" && workflowModelRaw.length > 0) {
        model = workflowModelRaw;
      }
      const nodeAllowed = readStringArray(node, "allowed_tools");
      const nodeDenied = readStringArray(node, "denied_tools");
      const nodeHooks = readHooksField(node);
      const nodeOutputFormat = readOutputFormat(node);
      const failOnToolError =
        (node as { fail_on_tool_error?: unknown }).fail_on_tool_error === true;

      // Provider resolution: node.provider overrides workflow.provider, which
      // overrides the resolver's own default. Passed verbatim to getProvider;
      // unknown ids throw inside the resolver and surface via consume()'s
      // error path.
      const nodeProviderRaw = (node as { provider?: unknown }).provider;
      const nodeProvider =
        typeof nodeProviderRaw === "string" && nodeProviderRaw.trim().length > 0
          ? nodeProviderRaw.trim()
          : undefined;
      const workflowProviderRaw = ctx.workflow.provider;
      const workflowProvider =
        typeof workflowProviderRaw === "string" && workflowProviderRaw.trim().length > 0
          ? workflowProviderRaw.trim()
          : undefined;
      const effectiveProviderId = nodeProvider ?? workflowProvider;

      // Slice 4 — surface a one-off `run_warning` when the active provider
      // can't honor the per-node config we just resolved. Only claude
      // implements the tool-gate / hook forwarding today; other providers
      // would silently no-op.
      //
      // Guarded against `getProvider()` throwing: a provider deregistered
      // mid-run (or a thunk that fails to resolve) MUST surface as a
      // structured node failure through `consume()` below, not bleed out
      // here before the timer / abort-listener cleanup. We treat any
      // preflight throw as "skip the warning" and let the real failure
      // path own the diagnostic.
      try {
        const providerType = opts.getProvider(effectiveProviderId).getType?.();
        if (providerType !== undefined && providerType !== "claude") {
          const usedFields: string[] = [];
          if (providerType === "copilot") {
            // copilot enforces allowed_tools / denied_tools (by capability) and
            // PreToolUse / PostToolUse hooks; only the other hook events no-op.
            const unsupportedHookEvents =
              nodeHooks === undefined
                ? []
                : Object.keys(nodeHooks).filter((e) => e !== "PreToolUse" && e !== "PostToolUse");
            if (unsupportedHookEvents.length > 0) {
              ctx.emit({
                type: "node_warning",
                message: `Provider 'copilot' enforces only PreToolUse / PostToolUse hooks — these events will silently no-op: ${unsupportedHookEvents.join(", ")}.`,
              });
            }
          } else {
            if (nodeAllowed !== undefined) usedFields.push("allowed_tools");
            if (nodeDenied !== undefined) usedFields.push("denied_tools");
            if (nodeHooks !== undefined) usedFields.push("hooks");
            if (usedFields.length > 0) {
              ctx.emit({
                type: "node_warning",
                message: `Provider '${providerType}' does not enforce per-node ${usedFields.join(", ")} — these will silently no-op.`,
              });
            }
          }
        }
      } catch {
        // swallow — consume() will hit the same getProvider() and
        // translate any real failure into a failed NodeResult.
      }

      // The global denylist (KEELSON_WORKFLOW_TOOL_DENYLIST) is the operator
      // safety floor — always applied, never overridable by workflow
      // authors. Per-node fields layer on top:
      //   - `node.allowed_tools` set → MCP catalog is intersected with
      //     allow-set, then the global denylist still subtracts ("ONLY
      //     these, minus anything the operator forbids").
      //   - `node.denied_tools` set → union with the global denylist
      //     (additive — author can deny MORE, never less).
      //   - neither set → global denylist only, PLUS the default-off set (rib
      //     tools), so a node inherits no rib tool it didn't explicitly allow.
      // SDK-level `allowedTools` / `disallowedTools` are forwarded so the
      // gate applies to SDK built-ins (Read/Write/Edit/Bash/Glob/Grep/…),
      // not just our MCP-projected tool catalog.
      //
      // `allow_tools` / `denied_tools` may list either the bare registry
      // name (`osdu_list_partitions`) or the SDK-qualified MCP form
      // (`mcp__keelson__osdu_list_partitions`). Normalize to bare names
      // before the set membership check so workflow authors can use
      // either form and our MCP catalog filter still matches.
      const nodeAllowedBare =
        nodeAllowed === undefined ? undefined : nodeAllowed.map(stripMcpPrefix);
      const nodeDeniedBare = nodeDenied === undefined ? undefined : nodeDenied.map(stripMcpPrefix);
      let filteredTools: readonly { name: string; [k: string]: unknown }[];
      if (nodeAllowedBare !== undefined) {
        const allowSet = new Set(nodeAllowedBare);
        filteredTools = allTools.filter((t) => allowSet.has(t.name) && !denySet.has(t.name));
      } else {
        const effectiveDeny =
          nodeDeniedBare === undefined ? denySet : new Set([...denySet, ...nodeDeniedBare]);
        // Default-off (rib) tools require an explicit allowed_tools opt-in, which
        // this branch (no allow-list) is not — so exclude them here too.
        filteredTools = allTools.filter(
          (t) => !effectiveDeny.has(t.name) && !defaultOffSet.has(t.name),
        );
      }

      let assistantText = "";
      let providerError: string | null = null;
      // Set when any tool the turn invoked returned an error result; consulted
      // after the stream when the node opts into `fail_on_tool_error`.
      let toolErrored = false;

      let iterator: AsyncIterator<unknown> | undefined;
      let iteratorReturned = false;
      // Fire iterator.return() when handlerExit aborts. This is the only
      // thing that unsticks a `next()` parked inside a provider that
      // ignores its abortSignal — without it, consume's await never
      // resolves and the finally below would never run. Listener attached
      // here (not inside consume) so it fires even if handlerExit was
      // already aborted before consume started.
      //
      // `iteratorReturned` dedupes between the abort-listener call and
      // consume's finally — calling return() twice on the same generator
      // is benign per spec but cleaner to skip the second.
      const returnIterator = (): void => {
        if (iteratorReturned) return;
        if (!iterator?.return) return;
        iteratorReturned = true;
        // iterator.return() can throw synchronously or reject async; catch
        // BOTH branches so the cleanup doesn't escape as an unhandled
        // rejection after handle() has returned.
        Promise.resolve()
          .then(() => iterator!.return!(undefined))
          .catch(() => undefined);
      };
      const onHandlerExit = (): void => returnIterator();

      const promptBody =
        nodeOutputFormat !== undefined
          ? ctx.resolvedBody + buildOutputFormatSuffix(nodeOutputFormat)
          : ctx.resolvedBody;

      // Project notebook (read) prepended to the factory seed — the prompt node
      // inherits the same project context chat sees. Best-effort: a throwing
      // adapter must not take the node down.
      let notebook: string | undefined;
      try {
        notebook = ctx.notebook?.read();
      } catch {
        notebook = undefined;
      }
      const effectiveSystemPrompt =
        [notebook, systemPrompt].filter((s) => s !== undefined && s.length > 0).join("\n\n") ||
        undefined;

      const consume = async (): Promise<void> => {
        try {
          const provider = opts.getProvider(effectiveProviderId);
          if (model === undefined) {
            const defaultModel = provider.getCapabilities?.().defaultModel;
            if (typeof defaultModel === "string" && defaultModel.length > 0) {
              model = defaultModel;
            }
          }
          const stream = provider.sendQuery(promptBody, ctx.cwd, undefined, {
            abortSignal: handlerExit.signal,
            ...(filteredTools.length > 0 ? { tools: filteredTools } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(effectiveSystemPrompt !== undefined ? { systemPrompt: effectiveSystemPrompt } : {}),
            ...(nodeAllowed !== undefined ? { allowedTools: nodeAllowed } : {}),
            ...(nodeDenied !== undefined ? { disallowedTools: nodeDenied } : {}),
            ...(nodeHooks !== undefined ? { hooks: nodeHooks } : {}),
            // Forward the UNFILTERED catalog so the claude provider
            // can detect MCP names even when one was filtered out
            // by the global denylist.
            registeredMcpToolNames: allTools.map((t) => t.name),
          });
          iterator = stream[Symbol.asyncIterator]();
          // Wire abort → iterator.return. If handlerExit already aborted
          // (e.g. ctx.abortSignal was pre-fired), kick the cleanup now so
          // the about-to-park next() resolves immediately.
          if (handlerExit.signal.aborted) {
            returnIterator();
          } else {
            handlerExit.signal.addEventListener("abort", onHandlerExit, {
              once: true,
            });
          }
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            if (handlerExit.signal.aborted) break;
            // Provider chunks are typed unknown at this boundary (see
            // file header). Inspect minimally so we can compute the text
            // return value; downstream consumers do their own typed
            // handling.
            const chunk = next.value;
            const t = chunkType(chunk);
            if (t === "done") continue;
            if (t === "text") {
              assistantText += (chunk as { content: string }).content;
            } else if (t === "error") {
              providerError = (chunk as { message: string }).message;
            } else if (t === "tool_result" && (chunk as { isError?: boolean }).isError === true) {
              toolErrored = true;
            }
            // Defensive: a timeout or cancel can fire after the chunk
            // resolves but before this branch runs. Skip the emit so
            // subscribers don't see a stray node_chunk after node_done
            // has been broadcast on the race-winner path.
            if (handlerExit.signal.aborted) break;
            ctx.emit({ type: "node_chunk", chunk });
          }
        } catch (err) {
          // AbortError from handlerExit.abort() is expected on cancel/
          // timeout — the surrounding flags decide the final NodeResult
          // shape. Any other throw is a real provider failure, but only
          // overwrite providerError if the stream didn't already emit a
          // normalized "error" chunk — the normalized message is the
          // user-friendly one we want to preserve.
          if (!cancelled && !timedOut && providerError === null) {
            providerError = err instanceof Error ? err.message : String(err);
          }
        } finally {
          handlerExit.signal.removeEventListener("abort", onHandlerExit);
          // Non-abort exit paths (e.g. ctx.emit throws synchronously,
          // stream exhausted normally) never fire the abort listener.
          // Still close the generator so the provider's session/network
          // resources don't leak — dedup guards against the abort-path
          // double-call.
          returnIterator();
        }
      };

      const consumePromise = consume();

      // The handler returns as soon as either consume finishes OR
      // handlerExit fires. If the provider parks deep in sendQuery without
      // honoring the abort signal, consumePromise stays pending but the
      // handler still returns — the workflow run terminates as documented.
      const exitPromise = new Promise<void>((resolve) => {
        if (handlerExit.signal.aborted) {
          resolve();
          return;
        }
        handlerExit.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      await Promise.race([consumePromise, exitPromise]);

      clearTimeout(timer);
      ctx.abortSignal.removeEventListener("abort", onUserCancel);
      // Detach: attach a noop catch so the pending promise (if any) can
      // settle quietly without an unhandled-rejection warning.
      consumePromise.then(undefined, () => undefined);

      let result: NodeResult;
      if (cancelled) {
        result = {
          status: "failed",
          output: { kind: "text", text: assistantText },
          error: "aborted",
        };
      } else if (timedOut) {
        result = {
          status: "failed",
          output: { kind: "text", text: assistantText },
          error: `prompt timeout after ${Math.round(timeoutMs / 1000)}s`,
        };
      } else if (providerError !== null) {
        result = {
          status: "failed",
          output: { kind: "text", text: assistantText },
          error: providerError,
        };
      } else if (failOnToolError && toolErrored) {
        // The node's real work happens inside a tool that failed closed; the
        // turn may still have completed with a normal text reply, but the node
        // must report failure rather than a successful no-op.
        result = {
          status: "failed",
          output: { kind: "text", text: assistantText },
          error: "a tool invoked by this node returned an error",
        };
      } else if (nodeOutputFormat !== undefined) {
        // output_format → structured output only when the reply parses to a JSON
        // object or array. A bare scalar (null/true/42/"x") or a non-JSON reply
        // stays raw text — the substitute layer's existing miss path, and the
        // shape the canvas/typed-view renderers expect.
        const value = extractJsonValue(assistantText);
        result =
          value !== null && typeof value === "object"
            ? { status: "succeeded", output: { kind: "structured", value } }
            : { status: "succeeded", output: { kind: "text", text: assistantText } };
      } else {
        result = {
          status: "succeeded",
          output: { kind: "text", text: assistantText },
        };
      }

      try {
        await lifecycle.afterNode?.({ runId: ctx.runId, nodeId: ctx.nodeId }, result);
      } catch {
        // swallow — hooks are best-effort
      }

      return result;
    },
  };
}

function chunkType(chunk: unknown): string | undefined {
  if (typeof chunk === "object" && chunk !== null && "type" in chunk) {
    const t = (chunk as { type: unknown }).type;
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

// Vendored-schema fields land on the DagNode union with a non-strict shape;
// pull them out defensively. Returns undefined when the field is absent OR
// not a string array — both paths fall back to the global denylist.
function readStringArray(
  node: unknown,
  key: "allowed_tools" | "denied_tools",
): readonly string[] | undefined {
  const value = (node as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((v): v is string => typeof v === "string") ? value : undefined;
}

// SDK convention: MCP tools are exposed to the model as
// `mcp__<serverName>__<toolName>`. Workflow authors may use either the bare
// registry name (`osdu_list_partitions`) or the SDK-qualified form
// (`mcp__keelson__osdu_list_partitions`) in allow / deny lists; this strips
// the wrapper so the MCP catalog filter matches against bare registry names.
// The server name part is consumed greedily up to the next `__` so this
// stays robust to any server name we (or a fork) might pick.
function stripMcpPrefix(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const serverEnd = name.indexOf("__", 5);
  if (serverEnd < 0) return name;
  return name.slice(serverEnd + 2);
}

// Pulls `node.hooks` defensively. The schema enforces the
// `Record<event, Array<{matcher?, response, timeout?}>>` shape at load time,
// so a passing zod parse is sufficient — this helper just narrows the union
// member back to the projection-friendly Partial shape.
function readHooksField(node: unknown): PromptHandlerSendOptions["hooks"] | undefined {
  const value = (node as Record<string, unknown>).hooks;
  if (!value || typeof value !== "object") return undefined;
  // Cast at the boundary: the loader has already validated the shape.
  return value as PromptHandlerSendOptions["hooks"];
}

function readOutputFormat(node: unknown): Record<string, unknown> | undefined {
  const value = (node as Record<string, unknown>).output_format;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
