/**
 * Pure DAG executor. Composes the loader-validated workflow, the topological
 * layering, the `when:` evaluator, the substitution helpers, and the trigger-
 * rule evaluator with a caller-supplied handler map.
 *
 * No IO. No SQLite. No provider calls. Side effects live in handlers (bash,
 * prompt, etc.) and in the `onEvent` consumer.
 */

import { createHash } from "node:crypto";
import { evaluateCondition } from "./conditions.ts";
import { buildTopologicalLayers, type DagShapeError, validateDagShape } from "./graph.ts";
import type {
  DagNode,
  NodeMemoryBlock,
  NodeNotebookBlock,
  NodeOutput,
  OutputSchema,
  StepRetryConfig,
  WorkflowDefinition,
} from "./schema/index.ts";
import { validateOutput } from "./schema/index.ts";
import { checkTriggerRule } from "./triggers.ts";

// Wire-protocol constants. Mirror the canonical values exported from
// `@keelson/shared/memory.ts`; intentionally duplicated rather than imported
// to keep this package's dep graph free (same discipline as the local
// `MemoryTools` declaration above). The strings are stable v1 — any change
// breaks the wire and must update both packages atomically.
const RECALL_REQUEST_SCHEMA_VERSION = "keelson.memory.recall.v1";
const WRITEBACK_REQUEST_SCHEMA_VERSION = "keelson.memory.writeback.v1";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The body a handler emits. Named `NodeOutputBody` (not `NodeOutput`) because
 * the schema already exports a `NodeOutput` discriminated on `state` — that
 * one is the captured run-state shape, this one is the handler's return value.
 */
export type NodeOutputBody =
  | { kind: "text"; text: string }
  | { kind: "structured"; value: unknown };

/**
 * Memory layer seam. Loosely typed to avoid pulling `@keelson/shared` into
 * this package's dep graph (same pattern as `PromptHandlerProvider` in
 * `handlers/prompt.ts`). The structural shape matches the `MemoryTools`
 * declaration exported from `@keelson/shared/memory.ts`. Consumers cast at
 * the boundary.
 *
 * `RecallRequestLike` / `WritebackRequestLike` are intentionally `unknown`-
 * leaning — the executor never inspects the request body, it just forwards
 * what the binding adapter produces. Same for the responses, except for
 * `items` and `trace.traceId` which the substitution layer reads.
 */
export interface RecallResponseLike {
  readonly items: readonly unknown[];
  readonly trace: { readonly traceId: string; readonly returned: number };
}
export interface WritebackResponseLike {
  readonly written: readonly { readonly memoryId: string }[];
  readonly blocked: readonly { readonly reason: string; readonly summary: string }[];
}
export interface MemoryTools {
  recall(req: unknown): Promise<RecallResponseLike>;
  writeback(req: unknown): Promise<WritebackResponseLike>;
}

// Project-notebook handle, pre-bound to the run's project by the composition
// root (which also gates it on the working dir resolving inside that project).
// Loosely typed so this package stays free of apps/server. `read` returns the
// formatted notebook section for prompt injection; `append` reports `ok: false`
// when the notebook is full or the write was rejected.
export interface NotebookAdapter {
  read(): string | undefined;
  append(entry: string, section?: string): { ok: boolean };
}

export interface NodeContext {
  runId: string;
  nodeId: string;
  inputs: Readonly<Record<string, string>>;
  upstreamOutputs: ReadonlyMap<string, NodeOutput>;
  cwd: string;
  abortSignal: AbortSignal;
  emit(event: NodeStreamEvent): void;
  /** Final body after $inputs.* / $1..$9 / $nodeId.output / $ARTIFACTS_DIR substitution. */
  resolvedBody: string;
  /** Pre-substitution body. Forward-compat for handlers that re-resolve per-iteration (loop). */
  rawBody: string;
  /** Workflow-level config (model/provider defaults, etc.) — forward-compat for handler factories. */
  workflow: WorkflowDefinition;
  // Project-notebook handle for this run. Present only when the run resolves to
  // a project whose tree the working dir sits inside; the prompt handler injects
  // `read()` and the `notebook:` contribute hook calls `append()`.
  notebook?: NotebookAdapter;
  /**
   * Per-run scratch directory; absent when the run wasn't given one. Bash /
   * script nodes see it as `$KEELSON_ARTIFACTS_DIR` in their env channel;
   * prompt / command nodes get it via `$ARTIFACTS_DIR` text substitution.
   */
  artifactsDir?: string;
  // Memory handle for handlers needing imperative recall/writeback beyond the declarative `memory:` block.
  // Undefined when no adapter was wired — handler is responsible for the guard.
  memory?: MemoryTools;
  // Pre-run recall results. Present only when the node declared `memory.recall:` AND an adapter was wired.
  // Handlers that re-resolve nested bodies must forward this to `resolveBody` so $memory.recall.* substitutes
  // against the recalled values rather than defaults.
  memoryRecall?: MemoryRecallContext;
}

/**
 * Structural mirror of `@keelson/shared`'s TokenUsage — duplicated rather
 * than imported to keep this package's dep graph free (same discipline as
 * `MemoryTools` above). Consumers cast at the boundary.
 */
export interface NodeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface NodeResult {
  status: "succeeded" | "failed" | "skipped";
  output: NodeOutputBody;
  /** Set when status === "failed". */
  error?: string;
  /** Provider-reported token usage for LLM-backed nodes; absent otherwise. */
  usage?: NodeTokenUsage;
  /** Effective provider id the node resolved to (e.g. "copilot", a gateway id) for LLM-backed nodes; absent otherwise. */
  provider?: string;
  /** Effective model the node ran on — the provider's resolved model when it reports one, else the requested node/workflow/default model. Absent for non-LLM nodes. */
  model?: string;
}

export interface NodeHandler {
  /** Node-type string the handler claims (e.g. "prompt", "bash"). Widened from a strict union so future node types don't break the contract. */
  readonly type: string;
  handle(node: DagNode, ctx: NodeContext): Promise<NodeResult>;
}

/**
 * Per-node streaming event emitted by handlers via `ctx.emit`.
 *
 * `node_chunk.chunk` is intentionally `unknown`: the prompt handler emits
 * `MessageChunk` values (defined in `@keelson/shared`), but
 * `@keelson/workflows` has no upstream deps in the architecture graph.
 * Consumers that need the chunk's shape cast it to `MessageChunk` at the
 * boundary.
 */
export type NodeStreamEvent =
  | { type: "node_chunk"; chunk: unknown }
  | { type: "node_log"; line: string }
  // Handler-side warning re-emitted on the nodeCtx.emit boundary so handlers don't need a side channel.
  | { type: "node_warning"; message: string }
  // Memory observability — emitted by the executor (not handlers) at pre-run / post-run hook boundaries.
  | { type: "memory_recalled"; traceId: string | null; returned: number }
  | { type: "memory_written"; memoryId: string }
  // Notebook contribute — emitted by the executor's post-run hook on append.
  | { type: "notebook_written"; section: string };

export interface RunOptions {
  workflow: WorkflowDefinition;
  runId: string;
  inputs: Record<string, string>;
  handlers: ReadonlyMap<string, NodeHandler>;
  cwd: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: RunStreamEvent) => void;
  // Per-run scratch directory. Caller owns lifecycle (create at run start, delete on terminal).
  artifactsDir?: string;
  // Memory adapter for pre-run recall / post-run writeback. Undefined → both hooks are no-ops.
  memoryTools?: MemoryTools;
  // Populates scope.projectId on every memory envelope this run produces.
  projectId?: string;
  // Project-notebook handle (read + contribute). Undefined → prompt nodes inject
  // no notebook and the `notebook:` hook is a no-op.
  notebook?: NotebookAdapter;
  // Pre-completed node outputs to seed re-entry; their handlers are skipped.
  completedNodeOutputs?: ReadonlyMap<string, NodeOutput>;
}

export type RunStreamEvent =
  | { type: "run_started"; runId: string; workflowName: string }
  | { type: "node_started"; nodeId: string }
  | { type: "node_event"; nodeId: string; event: NodeStreamEvent }
  | { type: "node_done"; nodeId: string; result: NodeResult }
  | { type: "run_warning"; nodeId?: string; message: string }
  | { type: "run_done"; status: RunStatus; summary: RunSummary };

export type RunStatus = "succeeded" | "failed" | "cancelled";

export interface RunSummary {
  runId: string;
  workflowName: string;
  status: RunStatus;
  nodes: Record<string, NodeOutput>;
  startedAtMs: number;
  completedAtMs: number;
}

export class ExecutorValidationError extends Error {
  readonly shapeErrors: readonly DagShapeError[];
  constructor(shapeErrors: readonly DagShapeError[]) {
    super(`workflow failed DAG validation: ${shapeErrors.length} error(s)`);
    this.name = "ExecutorValidationError";
    this.shapeErrors = shapeErrors;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** All node-type strings the schema declares. Keep in sync with dag-node.ts. */
const NODE_TYPE_FIELDS = [
  "prompt",
  "bash",
  "command",
  "loop",
  "approval",
  "cancel",
  "script",
] as const;
type NodeTypeField = (typeof NODE_TYPE_FIELDS)[number];

function nodeTypeOf(node: DagNode): NodeTypeField {
  for (const field of NODE_TYPE_FIELDS) {
    if (field in node) return field;
  }
  // Unreachable: loader.parseWorkflow rejects nodes that don't match any type.
  throw new Error(`node '${node.id}' has no recognized type discriminator`);
}

function nodeBodyOf(node: DagNode): string {
  const t = nodeTypeOf(node);
  const body = (node as Record<string, unknown>)[t];
  // loop/approval/cancel/script have non-string bodies and don't go through
  // substitution — the missing-handler path fires before this. Return "" for
  // them so substitution helpers receive a safe input.
  return typeof body === "string" ? body : "";
}

// Combined substitution. Single-pass over rawBody — substituted values are
// NEVER rescanned (so a node output / user input containing literal
// "$ARGUMENTS" / "\$5" / "$X.output" stays intact). The leading optional `(\\)?`
// folds the documented `\$` escape into the same pass: matching `\$X` strips
// the backslash and returns the literal form; matching `$X` substitutes.
//
// Alternatives (first match wins) for the marker after `$`:
//   ARGUMENTS                 — workflow ARGUMENTS input (raw)
//   ARTIFACTS_DIR             — per-run scratch dir (raw). Bash / script
//                                bodies are NOT substituted here (those
//                                handlers run ctx.rawBody for injection
//                                safety); they receive `$ARTIFACTS_DIR`
//                                and `$KEELSON_ARTIFACTS_DIR` as env vars
//                                via buildSubprocessEnv instead.
//   inputs.<key>              — workflow input by key (raw) — matched BEFORE
//                                node-output refs so $inputs.output resolves
//                                to the input named "output" rather than a
//                                node literally named "inputs". "inputs" is
//                                effectively a reserved node name at the
//                                substitution layer.
//   <id>.output[.field]       — upstream node output (raw)
//   (none — bare `$` or `\$`) — preserves existing pure-module unescape semantics
//
// `$1..$9` are NOT substituted — there's no positional-args plumbing today,
// and substituting them would corrupt bash idioms like `awk '{print $1}'`.
// If a future version adds real positional args, the digit branch can be
// re-added.
//
// All substitutions are RAW. Author owns quoting — for bash, wrap substitutions
// in single quotes in the YAML. Bash command-injection safety against hostile
// upstream output is not solved here: no in-string quoting is universally safe;
// a bash handler would need out-of-band interpolation (env / argv).
// The boundary after the reserved tokens prevents `$ARGUMENTS2.output` /
// `$ARTIFACTS_DIR_FOO` / `$ARTIFACTS_DIR-cache.output` from greedily matching
// the reserved alt — without the boundary, the regex engine commits to the
// reserved alternative and leaves the suffix literal in the output. `\b`
// won't do: it treats `-` as a word boundary, so `$ARTIFACTS_DIR-cache`
// would still match. Since node ids allow `[a-zA-Z0-9_-]`, the boundary
// must exclude all of those — falling through to the node-output alt
// where the full id is captured (subject to the loader's reserved-id check).
const SUB_PATTERN =
  /(\\)?\$(?:(ARGUMENTS)(?![a-zA-Z0-9_-])|(ARTIFACTS_DIR)(?![a-zA-Z0-9_-])|memory\.recall\.(items|trace)(?![a-zA-Z0-9_-])|inputs\.([a-zA-Z_][a-zA-Z0-9_]*)|([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?)?/g;

/**
 * Per-node memory recall context — populated by the executor before
 * `resolveBody()` when the node has a `memory.recall:` block, and consumed
 * by the `$memory.recall.items` / `$memory.recall.trace` substitutions.
 *
 * `items` is JSON-stringified at substitution time (matches how
 * `$nodeId.output` returns the raw string for downstream JSON access).
 * `traceId` is null when recall ran but the adapter didn't return a trace;
 * the entire object is undefined when recall didn't run (no block, failure,
 * or no adapter). Both undefined and null path resolve `$memory.recall.*`
 * to defensive defaults (`[]` and `""`) so workflows can reference the
 * namespace without conditional guards.
 */
export interface MemoryRecallContext {
  readonly items: readonly unknown[];
  readonly traceId: string | null;
}

/**
 * Apply the executor's single-pass substitution to an arbitrary string.
 * Handlers that synthesize prompts from nested-config bodies (command files,
 * `loop.prompt`) call this so the substitution semantics match what the
 * executor applies to top-level string bodies.
 */
export function resolveBody(
  rawBody: string,
  inputs: Readonly<Record<string, string>>,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  options?: { artifactsDir?: string; memoryRecall?: MemoryRecallContext },
): string {
  return rawBody.replace(
    SUB_PATTERN,
    (
      match,
      backslash: string | undefined,
      argsMarker: string | undefined,
      artifactsMarker: string | undefined,
      memoryField: string | undefined,
      inputKey: string | undefined,
      nodeId: string | undefined,
      field: string | undefined,
    ) => {
      // Escape: \$X → $X (strip backslash, keep marker literal). Also \$ → $
      // when no marker follows. Operates on the original body only — never
      // runs again on substituted values.
      if (backslash !== undefined) return match.slice(1);
      if (argsMarker !== undefined) return inputs.ARGUMENTS ?? "";
      // Absent artifactsDir resolves to "" — same convention as missing
      // input. Authors who require an artifacts dir should check inside
      // the script body (`if [ -z "$KEELSON_ARTIFACTS_DIR" ] ...`).
      if (artifactsMarker !== undefined) return options?.artifactsDir ?? "";
      if (memoryField !== undefined) {
        const recall = options?.memoryRecall;
        if (memoryField === "items") return recall ? JSON.stringify(recall.items) : "[]";
        // memoryField === "trace" — undefined recall and null traceId both
        // resolve to "" so workflow bodies can interpolate without guards.
        return recall?.traceId ?? "";
      }
      if (inputKey !== undefined) {
        // Defensive: bracket-access can return inherited prototype values
        // for keys like `constructor` / `toString`. Restrict to string
        // own-values; anything else (missing, prototype, non-string)
        // resolves to "" per the documented "missing input" semantics.
        const v = inputs[inputKey];
        return typeof v === "string" ? v : "";
      }
      if (nodeId !== undefined) {
        const out = nodeOutputs.get(nodeId);
        if (!out) return "";
        if (!field) return out.output;
        try {
          const parsed = JSON.parse(out.output) as Record<string, unknown>;
          // Own-property only: a prototype-named ref (`__proto__`, `constructor`)
          // is a missing field, not the inherited member bracket-access returns.
          if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, field)) {
            return "";
          }
          const value = parsed[field];
          if (typeof value === "string") return value;
          if (typeof value === "number" || typeof value === "boolean") return String(value);
          // Object/array/null sections JSON-encode so a downstream body receives
          // the structured value intact (own JSON values always stringify).
          return JSON.stringify(value);
        } catch {
          return "";
        }
      }
      // Bare `$` with no marker (e.g. `unit $`, or `$1`/`$5.00`): leave as-is.
      return match;
    },
  );
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function bodyToSchemaOutput(
  result: NodeResult,
  startedAtMs: number,
  completedAtMs: number,
): NodeOutput {
  const startedAt = nowIso(startedAtMs);
  const completedAt = nowIso(completedAtMs);
  const durationMs = completedAtMs - startedAtMs;
  // Structured bodies → JSON-encoded so $nodeId.output.field reads work.
  // `JSON.stringify` returns undefined for top-level undefined / function /
  // symbol — coerce to "" so the schema's `output: string` invariant holds
  // regardless of the result status. The succeeded path also gets a loud
  // failure in runNodeOnce before reaching here; this coercion is the safety
  // net for the failed/skipped branches.
  const text =
    result.output.kind === "text"
      ? result.output.text
      : (JSON.stringify(result.output.value) ?? "");
  switch (result.status) {
    case "succeeded":
      return { state: "completed", output: text, startedAt, completedAt, durationMs };
    case "failed":
      return {
        state: "failed",
        output: text,
        error: result.error ?? "unknown",
        startedAt,
        completedAt,
        durationMs,
      };
    case "skipped":
      return { state: "skipped", output: "" };
  }
}

function skippedOutput(): NodeOutput {
  return { state: "skipped", output: "" };
}

function skippedResult(): NodeResult {
  return { status: "skipped", output: { kind: "text", text: "" } };
}

function failedResult(error: string): NodeResult {
  return { status: "failed", output: { kind: "text", text: "" }, error };
}

// ---------------------------------------------------------------------------
// runWorkflow
// ---------------------------------------------------------------------------

export async function runWorkflow(opts: RunOptions): Promise<RunSummary> {
  const {
    workflow,
    runId,
    inputs,
    handlers,
    cwd,
    abortSignal,
    onEvent,
    artifactsDir,
    memoryTools,
    projectId,
    notebook,
    completedNodeOutputs,
  } = opts;
  // Absorb user callback throws so a misbehaving onEvent can't kill the run
  // or leave a node without recorded state. Handles both sync throws and
  // async rejections (an `async` onEvent that throws after an `await` returns
  // a rejected Promise; this guard catches that too).
  const emit = (event: RunStreamEvent) => {
    if (!onEvent) return;
    try {
      const maybePromise = onEvent(event) as unknown;
      if (maybePromise instanceof Promise) {
        maybePromise.catch(() => {
          /* swallow async rejection */
        });
      }
    } catch {
      /* swallow sync throw */
    }
  };
  const startedAtMs = Date.now();

  const shapeErrors = validateDagShape(workflow.nodes);
  if (shapeErrors.length > 0) throw new ExecutorValidationError(shapeErrors);

  const layers = buildTopologicalLayers(workflow.nodes);
  const nodeOutputs = new Map<string, NodeOutput>();
  const allNodeIds = workflow.nodes.map((n) => n.id);

  if (completedNodeOutputs) {
    for (const [id, out] of completedNodeOutputs) {
      // Only terminal-success states are valid seeds; a failed/running/awaiting
      // seed would wrongly suppress that node's re-run on re-entry.
      if (out.state === "completed" || out.state === "skipped") nodeOutputs.set(id, out);
    }
  }

  emit({ type: "run_started", runId, workflowName: workflow.name });

  let cancelled = false;

  for (const layer of layers) {
    if (abortSignal?.aborted) {
      cancelled = true;
      break;
    }
    // Per-layer write buffer keeps siblings from observing each other through
    // the shared nodeOutputs map mid-layer (would make handler behavior race-
    // sensitive). Merged into nodeOutputs after the layer settles.
    const layerResults = new Map<string, NodeOutput>();
    const pending = layer.filter((node) => !nodeOutputs.has(node.id));
    await Promise.allSettled(
      pending.map((node) =>
        runNodeOnce(node, {
          workflow,
          runId,
          inputs,
          cwd,
          abortSignal: abortSignal ?? new AbortController().signal,
          nodeOutputs,
          layerResults,
          emit,
          handlers,
          ...(artifactsDir !== undefined ? { artifactsDir } : {}),
          ...(memoryTools !== undefined ? { memoryTools } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(notebook !== undefined ? { notebook } : {}),
        }),
      ),
    );
    for (const [id, out] of layerResults) nodeOutputs.set(id, out);
  }
  // Catches the case where the signal fires mid-last-layer: handlers settle
  // but no further iteration of the loop happens to see aborted=true.
  if (!cancelled && abortSignal?.aborted) cancelled = true;

  if (cancelled) {
    for (const id of allNodeIds) {
      if (!nodeOutputs.has(id)) {
        nodeOutputs.set(id, skippedOutput());
        emit({ type: "node_done", nodeId: id, result: skippedResult() });
      }
    }
  }

  const status: RunStatus = computeRunStatus(workflow, nodeOutputs, cancelled);
  const completedAtMs = Date.now();
  const summary: RunSummary = {
    runId,
    workflowName: workflow.name,
    status,
    nodes: Object.fromEntries(nodeOutputs.entries()),
    startedAtMs,
    completedAtMs,
  };
  emit({ type: "run_done", status, summary });
  return summary;
}

// ---------------------------------------------------------------------------
// Per-node dispatch
// ---------------------------------------------------------------------------

interface RunCtx {
  workflow: WorkflowDefinition;
  runId: string;
  inputs: Record<string, string>;
  cwd: string;
  abortSignal: AbortSignal;
  /** Read-only view of upstream layers; stays stable during the current layer. */
  nodeOutputs: Map<string, NodeOutput>;
  /** Per-layer write buffer. Merged into nodeOutputs after Promise.allSettled. */
  layerResults: Map<string, NodeOutput>;
  emit: (event: RunStreamEvent) => void;
  handlers: ReadonlyMap<string, NodeHandler>;
  /** Optional per-run scratch dir; forwarded into NodeContext and resolveBody. */
  artifactsDir?: string;
  /** Memory adapter — see RunOptions.memoryTools. */
  memoryTools?: MemoryTools;
  /** Optional scope.projectId for memory envelopes — see RunOptions.projectId. */
  projectId?: string;
  /** Project-notebook handle (read + contribute) — see RunOptions.notebook. */
  notebook?: NotebookAdapter;
}

// ---------------------------------------------------------------------------
// Node retry — honors a node's `retry:` config (schema/retry.ts).
//
// A failed attempt re-runs the handler up to `max_attempts` extra times with
// exponential backoff (`delay_ms` doubled each attempt), but only when the
// failure is retryable under `on_error`. A user cancel is never retried:
// abortSignal.aborted is authoritative, with a bare "aborted" error as backstop.
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_DELAY_MS = 3000;

// The base `retry` field the DagNode union surfaces as optional; mirrors
// nodeMemoryOf / outputSchemaOf below.
function retryConfigOf(node: DagNode): StepRetryConfig | undefined {
  return (node as { retry?: StepRetryConfig }).retry;
}

// Substrings marking a failure a retry could plausibly clear: transport blips,
// timeouts, and rate-limit / overload (backoff is exactly what those want).
// Matched against the friendly error string the handler already returned — no
// structured error kind reaches this seam. Drawn from the provider error buckets
// (packages/providers/*/errors.ts).
const TRANSIENT_ERROR_MARKERS: readonly string[] = [
  "econnreset",
  "etimedout",
  "econnrefused",
  "epipe",
  "socket hang up",
  "socket closed",
  "broken pipe",
  "not connected",
  "disconnect",
  "process exited",
  "worker exited",
  "fetch failed",
  "network",
  "timeout",
  "timed out",
  "rate limit",
  "rate-limit",
  "too many requests",
  "429",
  "overloaded",
  "temporarily unavailable",
  "503",
  "502",
  "504",
  "server error",
];

function isTransientError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return TRANSIENT_ERROR_MARKERS.some((marker) => lower.includes(marker));
}

function isAbortError(error: string | undefined): boolean {
  return error?.toLowerCase().includes("abort") ?? false;
}

function shouldRetryFailure(
  error: string | undefined,
  retry: StepRetryConfig,
  abortSignal: AbortSignal,
): boolean {
  if (abortSignal.aborted || isAbortError(error)) return false;
  return (retry.on_error ?? "transient") === "all" || isTransientError(error);
}

// Resolves after `ms`, or early if the signal aborts, so a cancel during the
// backoff wait doesn't block the run's teardown.
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Runs a node's handler, retrying a retryable failure per its `retry:` config.
// Returns the final NodeResult; rethrows if the final attempt threw, so the
// caller's writeback-on-throw path stays intact. A returned failure on the final
// attempt flows through unchanged. Each retry emits a run_warning.
async function runHandlerWithRetry(
  handler: NodeHandler,
  node: DagNode,
  nodeCtx: NodeContext,
  abortSignal: AbortSignal,
  emit: (event: RunStreamEvent) => void,
): Promise<NodeResult> {
  const retry = retryConfigOf(node);
  const maxRetries = retry?.max_attempts ?? 0;
  for (let attempt = 0; ; attempt++) {
    const backoff = async (reason: string): Promise<void> => {
      const delayMs = (retry?.delay_ms ?? DEFAULT_RETRY_DELAY_MS) * 2 ** attempt;
      emit({
        type: "run_warning",
        nodeId: node.id,
        message: `retry ${attempt + 1}/${maxRetries} in ${delayMs}ms after ${reason}`,
      });
      await abortableDelay(delayMs, abortSignal);
    };
    try {
      const result = await handler.handle(node, nodeCtx);
      if (
        result.status === "failed" &&
        retry !== undefined &&
        attempt < maxRetries &&
        shouldRetryFailure(result.error, retry, abortSignal)
      ) {
        await backoff(`failure: ${result.error ?? "unknown error"}`);
        // A cancel during the backoff wait is authoritative: surface the last
        // failure rather than invoking the handler once more.
        if (abortSignal.aborted) return result;
        continue;
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        retry !== undefined &&
        attempt < maxRetries &&
        shouldRetryFailure(message, retry, abortSignal)
      ) {
        await backoff(`error: ${message}`);
        if (abortSignal.aborted) throw err;
        continue;
      }
      throw err;
    }
  }
}

async function runNodeOnce(node: DagNode, ctx: RunCtx): Promise<void> {
  try {
    await runNodeOnceInner(node, ctx);
  } catch (err) {
    // Final safety net: any unexpected throw in the pre-handler path (e.g.
    // nodeTypeOf encountering a malformed node) is converted to a failed
    // outcome so Promise.allSettled doesn't drop the node silently.
    const message = err instanceof Error ? err.message : String(err);
    ctx.layerResults.set(node.id, {
      state: "failed",
      output: "",
      error: message,
    });
    ctx.emit({ type: "node_done", nodeId: node.id, result: failedResult(message) });
  }
}

async function runNodeOnceInner(node: DagNode, ctx: RunCtx): Promise<void> {
  const { nodeOutputs, layerResults, emit, handlers, abortSignal } = ctx;

  // 1. trigger_rule (reads upstream-layer outputs only — layerResults is private to this layer)
  if (checkTriggerRule(node, nodeOutputs) === "skip") {
    layerResults.set(node.id, skippedOutput());
    emit({ type: "node_done", nodeId: node.id, result: skippedResult() });
    return;
  }

  // 2. when:
  if (node.when) {
    const { result, parsed } = evaluateCondition(node.when, nodeOutputs);
    if (!parsed) {
      emit({
        type: "run_warning",
        nodeId: node.id,
        message: `malformed when:: ${node.when}`,
      });
      layerResults.set(node.id, skippedOutput());
      emit({ type: "node_done", nodeId: node.id, result: skippedResult() });
      return;
    }
    if (!result) {
      layerResults.set(node.id, skippedOutput());
      emit({ type: "node_done", nodeId: node.id, result: skippedResult() });
      return;
    }
  }

  // 3. handler resolution
  const nodeType = nodeTypeOf(node);
  const handler = handlers.get(nodeType);
  if (!handler) {
    const error = `no handler registered for node type '${nodeType}'`;
    emit({ type: "run_warning", nodeId: node.id, message: error });
    layerResults.set(node.id, {
      state: "failed",
      output: "",
      error,
    });
    emit({ type: "node_done", nodeId: node.id, result: failedResult(error) });
    return;
  }

  // 3a. Memory recall runs before substitution so the resolved query sees the same
  // $inputs.* / $nodeId.output values the prompt body does. Failures warn-and-continue
  // with an empty context; $memory.recall.* substitutions then fall back to [] / "".
  const memoryRecall = await runPreRecall(node, ctx, nodeOutputs, emit);

  // 4. substitution (executor-owned, single-pass — data containing literal
  // markers like "$ARGUMENTS" is preserved as-is rather than re-interpreted).
  const rawBody = nodeBodyOf(node);
  const resolvedBody = resolveBody(rawBody, ctx.inputs, nodeOutputs, {
    ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
    ...(memoryRecall !== undefined ? { memoryRecall } : {}),
  });

  // 5. dispatch
  const nodeCtx: NodeContext = {
    runId: ctx.runId,
    nodeId: node.id,
    inputs: ctx.inputs,
    upstreamOutputs: nodeOutputs as ReadonlyMap<string, NodeOutput>,
    cwd: ctx.cwd,
    abortSignal,
    emit: (event) => {
      // node_warning is the handler's way to bubble a warning all the
      // way up to the run-level `run_warning` frame without leaking the
      // emit-pump shape into the handler API.
      if (event.type === "node_warning") {
        emit({ type: "run_warning", nodeId: node.id, message: event.message });
        return;
      }
      emit({ type: "node_event", nodeId: node.id, event });
    },
    resolvedBody,
    ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
    rawBody,
    workflow: ctx.workflow,
    ...(ctx.notebook !== undefined ? { notebook: ctx.notebook } : {}),
    ...(memoryRecall !== undefined ? { memoryRecall } : {}),
    ...(ctx.memoryTools !== undefined ? { memory: ctx.memoryTools } : {}),
  };
  emit({ type: "node_started", nodeId: node.id });
  const startedAtMs = Date.now();
  try {
    let result = await runHandlerWithRetry(handler, node, nodeCtx, abortSignal, emit);
    // Validate structured output is JSON-serializable. JSON.stringify returns
    // undefined for top-level undefined / functions / symbols — those would
    // leave NodeOutput.output non-string, violating the schema and breaking
    // downstream substitution. Treat as a handler bug: fail loudly.
    // Rewrap sites below spread `...result` so handler-attached fields
    // (usage today, anything future) survive the rewrap — a rebuilt literal
    // here silently zeroed token accounting for the LLM-backed paths.
    if (result.status === "succeeded" && result.output.kind === "structured") {
      if (typeof JSON.stringify(result.output.value) !== "string") {
        const error = `handler structured output is not JSON-serializable (typeof value: ${typeof result.output.value})`;
        emit({ type: "run_warning", nodeId: node.id, message: error });
        result = { ...result, status: "failed", output: { kind: "text", text: "" }, error };
      }
    }
    // Fail-closed output_schema check: a node that declares a schema but emits
    // the wrong shape fails here rather than feeding a malformed $nodeId.output
    // downstream. Validates the same JSON view a consumer reads via substitution.
    if (result.status === "succeeded") {
      const schema = outputSchemaOf(node);
      if (schema !== undefined) {
        const captured = capturedValueForSchema(result.output);
        const validation = validateOutput(captured, schema);
        if (!validation.ok) {
          const error = `output_schema validation failed: ${validation.error}`;
          emit({ type: "run_warning", nodeId: node.id, message: error });
          result = { ...result, status: "failed", output: { kind: "text", text: "" }, error };
        } else if (
          result.output.kind === "text" &&
          typeof captured === "object" &&
          captured !== null
        ) {
          // A node that declares output_schema and emits JSON is a structured
          // producer: surface it as structured so $nodeId.output addressing and
          // the snapshot publish bridge see the value, not raw text.
          result = { ...result, output: { kind: "structured", value: captured } };
        }
      }
    }
    const recordedOutput = bodyToSchemaOutput(result, startedAtMs, Date.now());
    layerResults.set(node.id, recordedOutput);
    // 6. Memory writeback fires after the recorded output is captured but before `node_done`,
    // so subscribers see writeback events as node-scoped. Gated on `on === "always" || succeeded`.
    // provenance and idempotencyKey are hard-coded — author-uncontrollable — to keep evidence-default.
    await runPostWriteback(node, ctx, nodeOutputs, recordedOutput, result, emit, memoryRecall);
    await runNotebookContribute(node, ctx, nodeOutputs, recordedOutput, result, emit, memoryRecall);
    emit({ type: "node_done", nodeId: node.id, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const recordedOutput: NodeOutput = {
      state: "failed",
      output: "",
      error: message,
      startedAt: nowIso(startedAtMs),
      completedAt: nowIso(Date.now()),
      durationMs: Date.now() - startedAtMs,
    };
    layerResults.set(node.id, recordedOutput);
    // `memory.writeback.on: always` must also fire on thrown handler errors, not just returned NodeResults.
    const failedNodeResult = failedResult(message);
    await runPostWriteback(
      node,
      ctx,
      nodeOutputs,
      recordedOutput,
      failedNodeResult,
      emit,
      memoryRecall,
    );
    await runNotebookContribute(
      node,
      ctx,
      nodeOutputs,
      recordedOutput,
      failedNodeResult,
      emit,
      memoryRecall,
    );
    emit({ type: "node_done", nodeId: node.id, result: failedNodeResult });
  }
}

// ---------------------------------------------------------------------------
// Memory hooks
// ---------------------------------------------------------------------------

function nodeMemoryOf(node: DagNode): NodeMemoryBlock | undefined {
  // `memory` lives on dagNodeBaseSchema so every variant inherits it, but the
  // discriminated DagNode union surfaces it as an optional field that may be
  // absent at the type level. Read defensively.
  return (node as { memory?: NodeMemoryBlock }).memory;
}

function outputSchemaOf(node: DagNode): OutputSchema | undefined {
  // `output_schema` lives on dagNodeBaseSchema; read defensively (see nodeMemoryOf).
  return (node as { output_schema?: OutputSchema }).output_schema;
}

function nodeNotebookOf(node: DagNode): NodeNotebookBlock | undefined {
  // `notebook` lives on dagNodeBaseSchema; read defensively (see nodeMemoryOf).
  return (node as { notebook?: NodeNotebookBlock }).notebook;
}

/**
 * The value a node's `output_schema` validates against — the same JSON view that
 * gets recorded and that a downstream `$nodeId.output` substitution reads.
 * Structured output round-trips through JSON so a nested non-JSON value (e.g.
 * `edges: undefined`, dropped by `bodyToSchemaOutput`'s stringify) is validated
 * as it will actually be stored, not as the live JS object. Text output
 * JSON-parses when it can (so a node emitting JSON stdout validates as
 * structured) and otherwise stays the raw string.
 */
function capturedValueForSchema(output: NodeOutputBody): unknown {
  if (output.kind === "structured") {
    try {
      return JSON.parse(JSON.stringify(output.value));
    } catch {
      return output.value;
    }
  }
  try {
    return JSON.parse(output.text);
  } catch {
    return output.text;
  }
}

function buildMemoryScope(
  projectId?: string,
): { visibility: "project" } | { visibility: "project"; projectId: string } {
  // Workflows can only recall/writeback at project scope; `personal` is operator-only via the review queue.
  return projectId !== undefined ? { visibility: "project", projectId } : { visibility: "project" };
}

function buildMemoryTask(
  workflowName: string,
  runId: string,
  nodeId: string,
): {
  runtime: "workflow";
  taskId: string;
  flowId: string;
} {
  // Per-row dedupe is `(task.runtime, task.taskId, type, contentHash)`. Without the workflow name
  // in taskId, two workflows sharing a node id + content would collide; `${workflowName}:${nodeId}`
  // keeps intra-workflow idempotency while preserving cross-workflow distinction.
  return { runtime: "workflow", taskId: `${workflowName}:${nodeId}`, flowId: runId };
}

async function runPreRecall(
  node: DagNode,
  ctx: RunCtx,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  emit: (event: RunStreamEvent) => void,
): Promise<MemoryRecallContext | undefined> {
  const memBlock = nodeMemoryOf(node);
  if (!memBlock?.recall || !ctx.memoryTools) return undefined;

  // Resolve substitutions in the query first — workflow authors expect
  // `${inputs.cve}` to be the actual CVE before FTS5 sees it. Same options
  // shape as the body resolution below, minus memoryRecall (which doesn't
  // exist yet at this hook).
  const resolvedQuery = resolveBody(memBlock.recall.query, ctx.inputs, nodeOutputs, {
    ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
  });

  const req = {
    schemaVersion: RECALL_REQUEST_SCHEMA_VERSION,
    scope: buildMemoryScope(ctx.projectId),
    task: buildMemoryTask(ctx.workflow.name, ctx.runId, node.id),
    query: resolvedQuery,
    ...(memBlock.recall.entities !== undefined ? { entities: memBlock.recall.entities } : {}),
    ...(memBlock.recall.limits !== undefined ? { limits: memBlock.recall.limits } : {}),
  };

  try {
    const res = await ctx.memoryTools.recall(req);
    emit({
      type: "node_event",
      nodeId: node.id,
      event: {
        type: "memory_recalled",
        traceId: res.trace.traceId,
        returned: res.trace.returned,
      },
    });
    return { items: res.items, traceId: res.trace.traceId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      type: "run_warning",
      nodeId: node.id,
      message: `memory recall failed (continuing with empty items): ${message}`,
    });
    // Returning an empty context rather than `undefined` keeps `$memory.recall.trace`
    // resolving to "" (consistent with "recall ran but produced nothing") rather
    // than the "no block" default — gives subscribers signal that recall was
    // attempted even though items is empty.
    return { items: [], traceId: null };
  }
}

async function runPostWriteback(
  node: DagNode,
  ctx: RunCtx,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  recordedOutput: NodeOutput,
  result: NodeResult,
  emit: (event: RunStreamEvent) => void,
  memoryRecall: MemoryRecallContext | undefined,
): Promise<void> {
  const memBlock = nodeMemoryOf(node);
  if (!memBlock?.writeback || !ctx.memoryTools) return;
  const wb = memBlock.writeback;

  const nodeSucceeded = result.status === "succeeded";
  const shouldWrite = wb.on === "always" || (wb.on === "success" && nodeSucceeded);
  if (!shouldWrite) return;

  // Writeback templates may reference the just-completed node's output; build
  // a temporary map that includes it so `$<thisNodeId>.output.field` resolves.
  // `memoryRecall` is forwarded so writeback templates that reference
  // `$memory.recall.items` / `$memory.recall.trace` substitute against the
  // pre-run recall instead of the empty default — without this, a node
  // declaring both recall and writeback loses the recall context when the
  // writeback body interpolates it (which is the natural way to persist
  // "what we did with the recalled items").
  const outputsWithSelf = new Map(nodeOutputs);
  outputsWithSelf.set(node.id, recordedOutput);
  const resolveOpts = {
    ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
    ...(memoryRecall !== undefined ? { memoryRecall } : {}),
  };

  const summary = resolveBody(wb.summary, ctx.inputs, outputsWithSelf, resolveOpts);
  const content = resolveBody(wb.content, ctx.inputs, outputsWithSelf, resolveOpts);
  const contentHash = createHash("sha256").update(content).digest("hex");
  const idempotencyKey = `workflow:${ctx.runId}:${node.id}:${wb.type}:${contentHash}`;

  const sourceRefs = wb.sourceRefs.map((ref) => ({
    ...ref,
    uri: resolveBody(ref.uri, ctx.inputs, outputsWithSelf, resolveOpts),
  }));

  const draft = {
    type: wb.type,
    summary,
    content,
    contentHash,
    // Hard-coded. Evidence-default invariant — workflow authors cannot
    // promote memory to instruction-grade by writing a different value here
    // (the field isn't on the schema; the executor owns it).
    provenance: "generated" as const,
    sourceRefs,
    // MemoryStore accepts already-parsed Zod input; empty array mirrors Zod's default so the wire shape stays whole.
    artifacts: [],
    ...(wb.confidence !== undefined ? { confidence: wb.confidence } : {}),
    ...(wb.staleAfterDays !== undefined ? { staleAfterDays: wb.staleAfterDays } : {}),
  };

  const req = {
    schemaVersion: WRITEBACK_REQUEST_SCHEMA_VERSION,
    idempotencyKey,
    scope: buildMemoryScope(ctx.projectId),
    task: buildMemoryTask(ctx.workflow.name, ctx.runId, node.id),
    memories: [draft],
  };

  try {
    const res = await ctx.memoryTools.writeback(req);
    for (const written of res.written) {
      emit({
        type: "node_event",
        nodeId: node.id,
        event: { type: "memory_written", memoryId: written.memoryId },
      });
    }
    for (const blocked of res.blocked) {
      emit({
        type: "run_warning",
        nodeId: node.id,
        message: `memory writeback blocked: ${blocked.reason} (${blocked.summary})`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      type: "run_warning",
      nodeId: node.id,
      message: `memory writeback failed: ${message}`,
    });
  }
}

// Deterministic project-notebook append. Gated like writeback (success | always)
// and resolves `append` against the same self-inclusive output map, so
// `$<thisNode>.output` works. A full notebook warns rather than failing the node.
async function runNotebookContribute(
  node: DagNode,
  ctx: RunCtx,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  recordedOutput: NodeOutput,
  result: NodeResult,
  emit: (event: RunStreamEvent) => void,
  memoryRecall: MemoryRecallContext | undefined,
): Promise<void> {
  const block = nodeNotebookOf(node);
  if (!block || !ctx.notebook) return;

  const nodeSucceeded = result.status === "succeeded";
  const shouldWrite = block.on === "always" || (block.on === "success" && nodeSucceeded);
  if (!shouldWrite) return;

  const outputsWithSelf = new Map(nodeOutputs);
  outputsWithSelf.set(node.id, recordedOutput);
  const entry = resolveBody(block.append, ctx.inputs, outputsWithSelf, {
    ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
    ...(memoryRecall !== undefined ? { memoryRecall } : {}),
  });

  // Contribution is best-effort: a thrown adapter (e.g. the project was deleted
  // mid-run and the FK rejects the upsert) warns rather than failing the node.
  let ok: boolean;
  try {
    ok = ctx.notebook.append(entry, block.section).ok;
  } catch (err) {
    emit({
      type: "run_warning",
      nodeId: node.id,
      message: `notebook append failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  if (ok) {
    emit({
      type: "node_event",
      nodeId: node.id,
      event: { type: "notebook_written", section: block.section ?? "" },
    });
  } else {
    emit({
      type: "run_warning",
      nodeId: node.id,
      message: "notebook append skipped: the project notebook is full (run Tidy)",
    });
  }
}

// ---------------------------------------------------------------------------
// RunStatus
// ---------------------------------------------------------------------------

/** Trigger rules whose downstream completion absorbs an upstream failure. */
const RESCUE_TRIGGER_RULES = new Set(["one_success", "none_failed_min_one_success", "all_done"]);

function computeRunStatus(
  workflow: WorkflowDefinition,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  cancelled: boolean,
): RunStatus {
  if (cancelled) return "cancelled";
  // A node failure fails the run UNLESS a downstream node completed under a
  // rescuing trigger_rule — fail-fast unless a downstream rule says otherwise.
  for (const node of workflow.nodes) {
    if (nodeOutputs.get(node.id)?.state !== "failed") continue;
    const rescued = workflow.nodes.some((d) => {
      if (!(d.depends_on ?? []).includes(node.id)) return false;
      if (nodeOutputs.get(d.id)?.state !== "completed") return false;
      return RESCUE_TRIGGER_RULES.has((d.trigger_rule ?? "all_success") as string);
    });
    if (!rescued) return "failed";
  }
  return "succeeded";
}
