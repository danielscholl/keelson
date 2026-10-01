// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `approval` NodeHandler. Pauses the workflow until the route layer resolves
 * the approval — the user's reply (or the "Approve & continue" quick action)
 * becomes the node's `output.text` and the downstream nodes decide flow via
 * `when:` rules.
 *
 * A node may declare a `reviewer`: one agent turn, run through the same
 * prompt handler as a `prompt` node, that answers the gate for the operator
 * when it approves at or above `min_confidence`. Every other outcome (a
 * `changes` or `escalate` decision, low confidence, a reply that is not the
 * fixed verdict shape, a failed turn) falls through to the human gate with
 * the reviewer's verdict attached.
 *
 * The handler does no IO of its own. The route layer's `awaitApproval`
 * callback is what writes `paused` to SQLite, registers the pending promise,
 * and resolves it when POST /api/workflows/runs/:runId/resume arrives. The
 * schema's `on_reject` re-prompt loop is not yet wired up.
 */

import { evaluateCondition } from "../conditions.ts";
import type { NodeContext, NodeHandler, NodeResult } from "../executor.ts";
import { resolveBody } from "../executor.ts";
import {
  APPROVAL_REVIEWER_DEFAULT_MIN_CONFIDENCE,
  type ApprovalReviewer,
  type DagNode,
  isApprovalNode,
  type NodeOutput,
  type OutputSchema,
  validateOutput,
} from "../schema/index.ts";

export const APPROVAL_REVIEWER_DECISIONS = ["approve", "changes", "escalate"] as const;
export type ApprovalReviewerDecision = (typeof APPROVAL_REVIEWER_DECISIONS)[number];

/** Structural mirror of `@keelson/shared`'s ApprovalReviewerVerdict (this package has no upstream deps). */
export interface ApprovalReviewerVerdict {
  decision: ApprovalReviewerDecision;
  confidence: number;
  reason: string;
  changes?: string;
}

/** What a reviewer left behind when the gate still goes to the operator. */
export interface ApprovalReview {
  reviewerVerdict?: ApprovalReviewerVerdict;
  reviewerError?: string;
}

/** The fixed verdict shape every reviewer turn is pinned to. */
export const APPROVAL_REVIEWER_OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  required: ["decision", "confidence", "reason"],
  properties: {
    decision: { type: "string" },
    confidence: { type: "integer" },
    reason: { type: "string" },
    changes: { type: "string" },
  },
};

/** The `output_format` instruction appended to the reviewer prompt. */
export const APPROVAL_REVIEWER_OUTPUT_FORMAT: Readonly<Record<string, unknown>> = {
  decision: "approve | changes | escalate",
  confidence: "integer 0-100: how sure you are of the decision",
  reason: "one or two sentences: the evidence behind the decision",
  changes: "only with decision=changes: the exact changes required",
};

export type AwaitApproval = (
  runId: string,
  nodeId: string,
  message: string,
  abortSignal: AbortSignal,
  // Present when a declared reviewer ran and did not answer the gate.
  review?: ApprovalReview,
) => Promise<string>;

// Interactive-loop sibling of AwaitApproval. Same Promise<string> / abort
// semantics, plus the per-iteration metadata the route needs to populate the
// half-wired ApprovalContext fields (type / iteration / sessionId) and any
// future UI that wants to render "iteration N of M" alongside the gate.
export type AwaitInteraction = (
  runId: string,
  nodeId: string,
  message: string,
  iteration: number,
  sessionId: string | undefined,
  abortSignal: AbortSignal,
) => Promise<string>;

export interface ApprovalReviewerOptions {
  // The `prompt` handler the reviewer turn runs through.
  promptHandler: NodeHandler;
  // Operator floor: false disables every reviewer (KEELSON_APPROVAL_REVIEWER=off).
  enabled?: boolean;
  // Fired when the reviewer answers the gate, before the node resolves, so the
  // route layer can record who answered.
  onAnswer?: (runId: string, nodeId: string, verdict: ApprovalReviewerVerdict) => void;
}

export interface MakeApprovalHandlerOptions {
  awaitApproval: AwaitApproval;
  reviewer?: ApprovalReviewerOptions;
}

export type ParsedReviewerVerdict =
  | { ok: true; verdict: ApprovalReviewerVerdict }
  | { ok: false; error: string };

/**
 * Fail-closed read of a reviewer reply. Anything that is not exactly the
 * verdict shape (unknown decision, non-integer or out-of-range confidence,
 * blank reason) is an error, never an approval.
 */
export function parseReviewerVerdict(value: unknown): ParsedReviewerVerdict {
  const validation = validateOutput(value, APPROVAL_REVIEWER_OUTPUT_SCHEMA);
  if (!validation.ok) return { ok: false, error: validation.error };
  const obj = value as Record<string, unknown>;
  const decision = obj.decision;
  if (
    typeof decision !== "string" ||
    !(APPROVAL_REVIEWER_DECISIONS as readonly string[]).includes(decision)
  ) {
    return {
      ok: false,
      error: `decision must be one of ${APPROVAL_REVIEWER_DECISIONS.join(", ")}`,
    };
  }
  const confidence = obj.confidence as number;
  if (confidence < 0 || confidence > 100) {
    return { ok: false, error: "confidence must be an integer between 0 and 100" };
  }
  const reason = (obj.reason as string).trim();
  if (reason.length === 0) return { ok: false, error: "reason must not be empty" };
  const changes = typeof obj.changes === "string" ? obj.changes.trim() : "";
  return {
    ok: true,
    verdict: {
      decision: decision as ApprovalReviewerDecision,
      confidence,
      reason,
      ...(changes.length > 0 ? { changes } : {}),
    },
  };
}

function reviewerOf(node: DagNode): ApprovalReviewer | undefined {
  return isApprovalNode(node) ? node.approval.reviewer : undefined;
}

// Provenance the reviewer turn produced, carried onto the gate's own result so
// the usage ledger and the trace see the spend even when the gate then pauses.
function reviewerProvenance(result: NodeResult): Partial<NodeResult> {
  return {
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.provider !== undefined ? { provider: result.provider } : {}),
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.effort !== undefined ? { effort: result.effort } : {}),
  };
}

interface ReviewerOutcome {
  review: ApprovalReview;
  provenance: Partial<NodeResult>;
}

async function runReviewer(
  node: DagNode,
  reviewer: ApprovalReviewer,
  message: string,
  ctx: NodeContext,
  promptHandler: NodeHandler,
): Promise<ReviewerOutcome> {
  const resolveOptions = {
    ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
    ...(ctx.memoryRecall !== undefined ? { memoryRecall: ctx.memoryRecall } : {}),
    ...(ctx.convergeRound !== undefined ? { convergeRound: ctx.convergeRound } : {}),
  };
  const gateText = resolveBody(message, ctx.inputs, ctx.upstreamOutputs, resolveOptions);
  const rubric = resolveBody(reviewer.prompt, ctx.inputs, ctx.upstreamOutputs, resolveOptions);
  const body = [
    "You are the reviewer for an approval gate in a workflow run. Answer it as a careful reviewer acting for the operator would.",
    "",
    "## The gate",
    "",
    gateText,
    "",
    "## Your instructions",
    "",
    rubric,
    "",
    "Decide `approve` only when the evidence supports it; `changes` when specific, nameable changes are needed; `escalate` when the work shows the task was misread or you cannot read what you need to.",
  ].join("\n");

  const reviewerNode = {
    id: node.id,
    prompt: body,
    ...(reviewer.model !== undefined ? { model: reviewer.model } : {}),
    ...(reviewer.model_by_provider !== undefined
      ? { model_by_provider: reviewer.model_by_provider }
      : {}),
    ...(reviewer.effort !== undefined ? { effort: reviewer.effort } : {}),
    ...(reviewer.allowed_tools !== undefined ? { allowed_tools: reviewer.allowed_tools } : {}),
    output_format: APPROVAL_REVIEWER_OUTPUT_FORMAT,
  } as unknown as DagNode;

  let result: NodeResult;
  try {
    result = await promptHandler.handle(reviewerNode, {
      ...ctx,
      resolvedBody: body,
      rawBody: body,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { review: { reviewerError: `reviewer turn threw: ${reason}` }, provenance: {} };
  }
  const provenance = reviewerProvenance(result);
  if (result.status !== "succeeded") {
    return {
      review: { reviewerError: result.error ?? `reviewer turn ${result.status}` },
      provenance,
    };
  }
  let value: unknown;
  if (result.output.kind === "structured") {
    value = result.output.value;
  } else {
    try {
      value = JSON.parse(result.output.text);
    } catch {
      return { review: { reviewerError: "reviewer reply was not a JSON verdict" }, provenance };
    }
  }
  const parsed = parseReviewerVerdict(value);
  if (!parsed.ok) {
    return { review: { reviewerError: `reviewer verdict rejected: ${parsed.error}` }, provenance };
  }
  return { review: { reviewerVerdict: parsed.verdict }, provenance };
}

export function makeApprovalHandler(opts: MakeApprovalHandlerOptions): NodeHandler {
  return {
    type: "approval",
    async handle(node, ctx): Promise<NodeResult> {
      // approvalNodeSchema validates `approval.message` as required + non-empty
      // at load time. `isApprovalNode` narrows to the typed shape; the
      // fallback to resolvedBody keeps tests that pass a stub DagNode working
      // without forcing them to construct a full approval node.
      const message = isApprovalNode(node) ? node.approval.message : (ctx.resolvedBody ?? "");

      // Honour an already-aborted signal — the run was cancelled between
      // dispatch and entry to the handler; don't open a pause that nobody
      // will resolve.
      if (ctx.abortSignal.aborted) {
        return {
          status: "failed",
          output: { kind: "text", text: "" },
          error: "aborted",
        };
      }

      let review: ApprovalReview | undefined;
      let provenance: Partial<NodeResult> = {};
      const reviewer = reviewerOf(node);
      if (
        reviewer !== undefined &&
        opts.reviewer !== undefined &&
        opts.reviewer.enabled !== false
      ) {
        let wanted = true;
        if (reviewer.when !== undefined) {
          const { result, parsed } = evaluateCondition(
            reviewer.when,
            ctx.upstreamOutputs as Map<string, NodeOutput>,
          );
          if (!parsed) {
            ctx.emit({
              type: "node_warning",
              message: `malformed reviewer.when: ${reviewer.when}; the gate goes to the operator`,
            });
          }
          wanted = parsed && result;
        }
        if (wanted) {
          const outcome = await runReviewer(
            node,
            reviewer,
            message,
            ctx,
            opts.reviewer.promptHandler,
          );
          review = outcome.review;
          provenance = outcome.provenance;
          if (ctx.abortSignal.aborted) {
            return { status: "failed", output: { kind: "text", text: "" }, error: "aborted" };
          }
          const verdict = review.reviewerVerdict;
          const floor = reviewer.min_confidence ?? APPROVAL_REVIEWER_DEFAULT_MIN_CONFIDENCE;
          if (
            verdict !== undefined &&
            verdict.decision === "approve" &&
            verdict.confidence >= floor
          ) {
            opts.reviewer.onAnswer?.(ctx.runId, ctx.nodeId, verdict);
            return {
              status: "succeeded",
              output: { kind: "text", text: verdict.reason },
              ...provenance,
            };
          }
          if (review.reviewerError !== undefined) {
            ctx.emit({
              type: "node_warning",
              message: `approval reviewer: ${review.reviewerError}; the gate goes to the operator`,
            });
          }
        }
      }

      try {
        const reply = await opts.awaitApproval(
          ctx.runId,
          ctx.nodeId,
          message,
          ctx.abortSignal,
          review,
        );
        return {
          status: "succeeded",
          output: { kind: "text", text: reply },
          ...provenance,
        };
      } catch (err) {
        // The route's awaitApproval rejects on cancellation (DELETE /runs/:id
        // during pause). Distinguish abort from other errors so the run-level
        // status compute still sees a failure that doesn't get rescued.
        const reason = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          output: { kind: "text", text: "" },
          error: ctx.abortSignal.aborted ? "aborted" : reason,
          ...provenance,
        };
      }
    },
  };
}
