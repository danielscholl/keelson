// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `loop` NodeHandler (non-interactive only). Synthesizes a `PromptNode` per
 * iteration, dispatches to the injected prompt handler, and stops on `until`
 * signal, on `max_iterations`, or on a failed iteration.
 *
 * Interactive loops (`loop.interactive === true`) are rejected — pause-between-
 * iterations needs the W4.6 metadata-approval pipeline and is its own slice.
 */

import { type NodeHandler, type NodeResult, resolveBody } from "../executor.ts";
import { isLoopNode } from "../schema/index.ts";
import {
  detectCompletionSignal,
  failed,
  stripCompletionTags,
  synthesizePromptNode,
} from "./helpers.ts";

export interface MakeLoopHandlerOptions {
  promptHandler: NodeHandler;
}

export function makeLoopHandler(opts: MakeLoopHandlerOptions): NodeHandler {
  const { promptHandler } = opts;
  return {
    type: "loop",
    async handle(node, ctx): Promise<NodeResult> {
      if (!isLoopNode(node)) {
        return failed(`Loop node '${node.id}': missing 'loop' config`);
      }
      const loop = node.loop;
      if (loop.interactive === true) {
        return failed(
          `Loop node '${node.id}': interactive loops are not yet supported in this engine — open an issue or use a non-interactive loop`,
        );
      }
      if (typeof loop.until_bash === "string") {
        return failed(
          `Loop node '${node.id}': 'loop.until_bash' (shell completion probe) is not yet supported in this engine — rely on the text 'until' signal or open an issue`,
        );
      }

      let prevOutput = "";
      let lastStripped = "";

      for (let i = 1; i <= loop.max_iterations; i++) {
        if (ctx.abortSignal.aborted) {
          return failed(`Loop node '${node.id}': aborted`, prevOutput);
        }

        ctx.emit({
          type: "node_log",
          line: `iteration ${i} of ${loop.max_iterations}`,
        });

        // Substitution pipeline matches what the executor applies to
        // top-level string bodies; $LOOP_PREV_OUTPUT (previous stripped
        // output, empty on iteration 1) is a loop-only extension layered
        // on top.
        const substituted = resolveBody(loop.prompt, ctx.inputs, ctx.upstreamOutputs, {
          ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
        });
        const iterationPrompt = substituted.replace(/\$LOOP_PREV_OUTPUT/g, prevOutput);

        const synthesized = synthesizePromptNode(node, {
          id: `${node.id}#${String(i)}`,
          prompt: iterationPrompt,
        });

        const iterCtx = {
          ...ctx,
          resolvedBody: iterationPrompt,
          rawBody: iterationPrompt,
        };

        const result = await promptHandler.handle(synthesized, iterCtx);
        if (result.status !== "succeeded") return result;

        const text =
          result.output.kind === "text" ? result.output.text : JSON.stringify(result.output.value);

        const stripped = stripCompletionTags(text, loop.until);
        lastStripped = stripped;

        if (detectCompletionSignal(text, loop.until)) {
          return { status: "succeeded", output: { kind: "text", text: stripped } };
        }
        prevOutput = stripped;
      }

      // Hit max_iterations without seeing `until` — SUCCESS with the last
      // iteration's stripped output (matches Archon's behavior).
      return { status: "succeeded", output: { kind: "text", text: lastStripped } };
    },
  };
}
