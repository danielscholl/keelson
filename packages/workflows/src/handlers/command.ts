// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `command` NodeHandler. Reads a named command file via {@link resolveCommand}
 * and delegates to the prompt handler with a synthesized `PromptNode`.
 */

import { type NodeHandler, type NodeResult, resolveBody } from "../executor.ts";
import { isValidCommandName, resolveCommand } from "./discovery.ts";
import { failed, synthesizePromptNode } from "./helpers.ts";

export interface MakeCommandHandlerOptions {
  promptHandler: NodeHandler;
}

export function makeCommandHandler(opts: MakeCommandHandlerOptions): NodeHandler {
  const { promptHandler } = opts;
  return {
    type: "command",
    async handle(node, ctx): Promise<NodeResult> {
      const name = ((node as { command?: unknown }).command ?? "").toString().trim();
      if (!isValidCommandName(name)) {
        return failed(
          `Command node '${node.id}': invalid command name '${name}' (path traversal blocked)`,
        );
      }

      const resolved = await resolveCommand(name, ctx.cwd);
      if (!resolved) {
        return failed(
          `Command node '${node.id}': command '${name}.md' not found in .keelson/commands/`,
        );
      }

      // Apply the executor's substitution pipeline to the file body —
      // the executor only resolved the original `command` field (the
      // command name), so $ARGUMENTS / $inputs.* / $X.output inside the
      // file would otherwise reach the model literally. Forward
      // `memoryRecall` so `$memory.recall.items` inside the command file
      // substitutes against the executor's pre-run recall (otherwise the
      // declared memory.recall: block silently no-ops for command nodes).
      const resolvedPrompt = resolveBody(resolved.content, ctx.inputs, ctx.upstreamOutputs, {
        ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
        ...(ctx.memoryRecall !== undefined ? { memoryRecall: ctx.memoryRecall } : {}),
      });
      const synthesized = synthesizePromptNode(node, {
        id: node.id,
        prompt: resolvedPrompt,
      });

      const promptCtx = {
        ...ctx,
        resolvedBody: resolvedPrompt,
        rawBody: resolved.content,
      };

      return promptHandler.handle(synthesized, promptCtx);
    },
  };
}
