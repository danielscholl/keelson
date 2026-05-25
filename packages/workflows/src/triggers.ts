/**
 * Trigger-rule evaluation. Determines whether a node should run based on the
 * states of its upstream dependencies.
 *
 * Ported from Archon's `packages/workflows/src/dag-executor.ts:checkTriggerRule`.
 * Pure: depends only on schema types.
 */

import type { DagNode, NodeOutput, TriggerRule } from "./schema/index.ts";

/**
 * Decide whether `node` should run, given the outputs of its upstream
 * dependencies. Returns 'run' to execute, 'skip' to mark the node skipped.
 *
 * Default rule when omitted: `all_success`.
 *
 * Trigger rules:
 * - `all_success`               — every upstream completed successfully
 * - `one_success`               — at least one upstream completed
 * - `none_failed_min_one_success` — no upstream failed AND at least one succeeded
 * - `all_done`                  — every upstream is in a terminal state
 *                                 (completed, failed, or skipped) — i.e. not
 *                                 pending or running. Used for collector nodes
 *                                 that need every dep to settle regardless of
 *                                 outcome.
 *
 * Missing upstreams (e.g. a depends_on referencing an unknown id) are treated
 * as failed so the trigger rule fails closed.
 */
export function checkTriggerRule(
	node: DagNode,
	nodeOutputs: Map<string, NodeOutput>,
): "run" | "skip" {
	const nodeDeps = node.depends_on ?? [];
	if (nodeDeps.length === 0) return "run";

	const upstreams = nodeDeps.map(
		(id) =>
			nodeOutputs.get(id) ??
			({
				state: "failed",
				output: "",
				error: `upstream '${id}' missing from outputs`,
			} as NodeOutput),
	);
	const rule: TriggerRule = node.trigger_rule ?? "all_success";

	switch (rule) {
		case "all_success":
			return upstreams.every((u) => u.state === "completed") ? "run" : "skip";
		case "one_success":
			return upstreams.some((u) => u.state === "completed") ? "run" : "skip";
		case "none_failed_min_one_success": {
			const anyFailed = upstreams.some((u) => u.state === "failed");
			const anySucceeded = upstreams.some((u) => u.state === "completed");
			return !anyFailed && anySucceeded ? "run" : "skip";
		}
		case "all_done":
			return upstreams.every(
				(u) => u.state !== "pending" && u.state !== "running",
			)
				? "run"
				: "skip";
	}
}
