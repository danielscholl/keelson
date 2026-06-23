// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `cancel` NodeHandler. Signals run-level cancel via `opts.requestCancel`
 * and returns `failed` so the executor's per-node accounting sees a terminal
 * state. The server wires `requestCancel` to write the run's `cancelled`
 * status row and trip its AbortController; downstream layers then skip via
 * the executor's between-layer abort check.
 */

import type { NodeHandler, NodeResult } from "../executor.ts";
import { isCancelNode, type NodeOutput } from "../schema/index.ts";
import { substituteNodeOutputRefs } from "../substitute.ts";

export type RequestCancel = (runId: string, reason: string) => void | Promise<void>;

export interface MakeCancelHandlerOptions {
  requestCancel: RequestCancel;
}

export function makeCancelHandler(opts: MakeCancelHandlerOptions): NodeHandler {
  return {
    type: "cancel",
    async handle(node, ctx): Promise<NodeResult> {
      // The executor's resolveBody already substituted $ARGUMENTS,
      // $inputs.*, and $node.output[.field] in the typed cancel body — so a
      // reason that legitimately resolves to empty must be honored as-is, not
      // re-substituted (the raw fallback only understands $node.output refs and
      // would leave other markers literal). The fallback is for stub tests that
      // bypass the executor and leave ctx.resolvedBody unset.
      const reason = (
        ctx.resolvedBody !== undefined
          ? ctx.resolvedBody
          : substituteNodeOutputRefs(
              isCancelNode(node) ? node.cancel : "",
              ctx.upstreamOutputs as Map<string, NodeOutput>,
              false,
            )
      ).trim();

      try {
        await opts.requestCancel(ctx.runId, reason);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          output: { kind: "text", text: reason },
          error: `cancel signalling failed: ${detail}`,
        };
      }

      return {
        status: "failed",
        output: { kind: "text", text: reason },
        error: `cancelled: ${reason}`,
      };
    },
  };
}
