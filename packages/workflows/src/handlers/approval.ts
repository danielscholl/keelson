// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `approval` NodeHandler (W4.6). Pauses the workflow until the route layer
 * resolves the approval — the user's reply (or the "Approve & continue"
 * quick action) becomes the node's `output.text` and the downstream nodes
 * decide flow via `when:` rules.
 *
 * The handler does no IO of its own. The route layer's `awaitApproval`
 * callback is what writes `paused` to SQLite, registers the pending
 * promise, and resolves it when POST /api/workflows/runs/:runId/resume
 * arrives. v1 ignores the schema's `on_reject` re-prompt loop — that's a
 * follow-up slice.
 */

import type { NodeHandler, NodeResult } from "../executor.ts";
import { isApprovalNode } from "../schema/index.ts";

export type AwaitApproval = (
  runId: string,
  nodeId: string,
  message: string,
  abortSignal: AbortSignal,
) => Promise<string>;

export interface MakeApprovalHandlerOptions {
  awaitApproval: AwaitApproval;
}

export function makeApprovalHandler(
  opts: MakeApprovalHandlerOptions,
): NodeHandler {
  return {
    type: "approval",
    async handle(node, ctx): Promise<NodeResult> {
      // approvalNodeSchema validates `approval.message` as required + non-empty
      // at load time. `isApprovalNode` narrows to the typed shape; the
      // fallback to resolvedBody keeps tests that pass a stub DagNode working
      // without forcing them to construct a full approval node.
      const message = isApprovalNode(node)
        ? node.approval.message
        : (ctx.resolvedBody ?? "");

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

      try {
        const reply = await opts.awaitApproval(
          ctx.runId,
          ctx.nodeId,
          message,
          ctx.abortSignal,
        );
        return {
          status: "succeeded",
          output: { kind: "text", text: reply },
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
        };
      }
    },
  };
}
