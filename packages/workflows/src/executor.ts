/**
 * Pure DAG executor. Composes the loader-validated workflow, the topological
 * layering, the `when:` evaluator, the substitution helpers, and the trigger-
 * rule evaluator with a caller-supplied handler map.
 *
 * No IO. No SQLite. No provider calls. Side effects live in handlers (W2 bash,
 * W3 prompt) and in the `onEvent` consumer.
 *
 * Implements the W1 slice of docs/phase-4-prd.md.
 */

import { evaluateCondition } from "./conditions.ts";
import { buildTopologicalLayers, validateDagShape, type DagShapeError } from "./graph.ts";
import type { DagNode, NodeOutput, WorkflowDefinition } from "./schema/index.ts";
import { checkTriggerRule } from "./triggers.ts";

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
 * Memory layer seam (W5). Loosely typed to avoid pulling `@keelson/shared`
 * into this package's dep graph (same pattern as `PromptHandlerProvider` in
 * `handlers/prompt.ts`). The structural shape matches the `MemoryTools`
 * declaration exported from `@keelson/shared/memory.ts`; Phase 4.5 fills
 * the contract in. Consumers cast at the boundary.
 */
export interface MemoryTools {
	readonly __phase: "4.5-pending";
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
	/**
	 * Per-run scratch directory; absent when the run wasn't given one. Bash /
	 * script nodes see it as `$KEELSON_ARTIFACTS_DIR` in their env channel;
	 * prompt / command nodes get it via `$ARTIFACTS_DIR` text substitution.
	 */
	artifactsDir?: string;
	/** Phase 4.5 memory layer. Always undefined in v1; W5 seam only. */
	memory?: MemoryTools;
}

export interface NodeResult {
	status: "succeeded" | "failed" | "skipped";
	output: NodeOutputBody;
	/** Set when status === "failed". */
	error?: string;
}

export interface NodeHandler {
	/** Node-type string the handler claims (e.g. "prompt", "bash"). Widened from a strict union so future node types don't break the contract. */
	readonly type: string;
	handle(node: DagNode, ctx: NodeContext): Promise<NodeResult>;
}

/**
 * Per-node streaming event emitted by handlers via `ctx.emit`.
 *
 * `node_chunk.chunk` is intentionally `unknown`: the W3 prompt handler will
 * emit `MessageChunk` values (defined in `@keelson/shared`), but
 * `@keelson/workflows` has no upstream deps in the architecture graph
 * (docs/architecture.md §3). Consumers that need the chunk's shape cast it to
 * `MessageChunk` at the boundary.
 */
export type NodeStreamEvent =
	| { type: "node_chunk"; chunk: unknown }
	| { type: "node_log"; line: string }
	// Slice 4 — handler-side warning that should surface to subscribers as a
	// run-scoped `run_warning` frame. The executor re-emits these on the
	// nodeCtx.emit boundary so handlers don't need a separate side channel.
	| { type: "node_warning"; message: string };

export interface RunOptions {
	workflow: WorkflowDefinition;
	runId: string;
	inputs: Record<string, string>;
	handlers: ReadonlyMap<string, NodeHandler>;
	cwd: string;
	abortSignal?: AbortSignal;
	onEvent?: (event: RunStreamEvent) => void;
	/**
	 * Pre-minted per-run scratch directory. The caller (workflows-handler.ts)
	 * owns lifecycle — create at run start, delete on terminal. The executor
	 * forwards it to NodeContext + buildSubprocessEnv + substituteWorkflowVariables.
	 */
	artifactsDir?: string;
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
const NODE_TYPE_FIELDS = ["prompt", "bash", "command", "loop", "approval", "cancel", "script"] as const;
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
	// loop/approval/cancel/script have non-string bodies; v1 doesn't dispatch
	// those — the missing-handler path fires before substitution. Return ""
	// for them so substitution helpers receive a safe input.
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
// `$1..$9` are NOT substituted — v1 has no real positional-args plumbing, and
// substituting them would corrupt bash idioms like `awk '{print $1}'`. If a
// future version adds real positional args, the digit branch can be re-added.
//
// All substitutions are RAW. Author owns quoting — for bash, wrap substitutions
// in single quotes in the YAML. Bash command-injection safety against hostile
// upstream output is a W2 concern: no in-string quoting is universally safe;
// the W2 bash handler will adopt out-of-band interpolation (env / argv).
// The boundary after the reserved tokens prevents `$ARGUMENTS2.output` /
// `$ARTIFACTS_DIR_FOO` / `$ARTIFACTS_DIR-cache.output` from greedily matching
// the reserved alt — without the boundary, the regex engine commits to the
// reserved alternative and leaves the suffix literal in the output. `\b`
// won't do: it treats `-` as a word boundary, so `$ARTIFACTS_DIR-cache`
// would still match. Since node ids allow `[a-zA-Z0-9_-]`, the boundary
// must exclude all of those — falling through to the node-output alt
// where the full id is captured (subject to the loader's reserved-id check).
const SUB_PATTERN =
	/(\\)?\$(?:(ARGUMENTS)(?![a-zA-Z0-9_-])|(ARTIFACTS_DIR)(?![a-zA-Z0-9_-])|inputs\.([a-zA-Z_][a-zA-Z0-9_]*)|([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?)?/g;

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
	options?: { artifactsDir?: string },
): string {
	return rawBody.replace(
		SUB_PATTERN,
		(
			match,
			backslash: string | undefined,
			argsMarker: string | undefined,
			artifactsMarker: string | undefined,
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
					const value = parsed[field];
					if (typeof value === "string") return value;
					if (typeof value === "number" || typeof value === "boolean") return String(value);
					return "";
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
			: JSON.stringify(result.output.value) ?? "";
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
	const { workflow, runId, inputs, handlers, cwd, abortSignal, onEvent, artifactsDir } = opts;
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
		await Promise.allSettled(
			layer.map((node) =>
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

	// 4. substitution (executor-owned, single-pass — data containing literal
	// markers like "$ARGUMENTS" is preserved as-is rather than re-interpreted).
	const rawBody = nodeBodyOf(node);
	const resolvedBody = resolveBody(rawBody, ctx.inputs, nodeOutputs, {
		...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
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
	};
	emit({ type: "node_started", nodeId: node.id });
	const startedAtMs = Date.now();
	try {
		let result = await handler.handle(node, nodeCtx);
		// Validate structured output is JSON-serializable. JSON.stringify returns
		// undefined for top-level undefined / functions / symbols — those would
		// leave NodeOutput.output non-string, violating the schema and breaking
		// downstream substitution. Treat as a handler bug: fail loudly.
		if (result.status === "succeeded" && result.output.kind === "structured") {
			if (typeof JSON.stringify(result.output.value) !== "string") {
				const error = `handler structured output is not JSON-serializable (typeof value: ${typeof result.output.value})`;
				emit({ type: "run_warning", nodeId: node.id, message: error });
				result = { status: "failed", output: { kind: "text", text: "" }, error };
			}
		}
		layerResults.set(node.id, bodyToSchemaOutput(result, startedAtMs, Date.now()));
		emit({ type: "node_done", nodeId: node.id, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		layerResults.set(node.id, {
			state: "failed",
			output: "",
			error: message,
			startedAt: nowIso(startedAtMs),
			completedAt: nowIso(Date.now()),
			durationMs: Date.now() - startedAtMs,
		});
		emit({ type: "node_done", nodeId: node.id, result: failedResult(message) });
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
	// A node failure makes the run fail UNLESS it has a downstream node that
	// completed under a rescuing trigger_rule. Encodes the PRD's "fail-fast
	// unless a downstream trigger_rule says otherwise."
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
