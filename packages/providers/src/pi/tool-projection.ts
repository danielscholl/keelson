// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ToolContext } from "@keelson/shared";
import { checkToolCallGate } from "../tool-gate.ts";
import { deriveToolParametersJsonSchema } from "../tool-params.ts";
import type { MessageChunk, ToolCallGate, ToolDefinition } from "../types.ts";

// Structural slice of pi's extension ToolDefinition that the projection
// produces; the factory casts it at the SDK boundary. `parameters` is a plain
// JSON Schema object — pi's validateToolArguments handles raw JSON Schema, not
// only TypeBox-built schemas. pi passes more arguments to execute (onUpdate,
// extension ctx); a narrower signature is assignable, so they stay off this
// seam.
export interface PiProjectedTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<PiProjectedToolResult>;
}

export interface PiProjectedToolResult {
  content: { type: "text"; text: string }[];
  details: undefined;
}

export interface PiToolProjectionContext {
  cwd: string;
  // Live-stream sink for non-result chunks a tool emits mid-execution. The
  // tool_result itself is NOT pushed here — it returns to pi, which emits a
  // tool_execution_end event the bridge maps; pushing both would duplicate it.
  pushChunk: (chunk: MessageChunk) => void;
  abortSignal?: AbortSignal;
  // Per-call policy gate (server-wired). When present, each tool call is
  // evaluated WITH its validated args before execute and a deny throws (pi
  // converts that into an error tool result). pi's own built-ins are disabled,
  // so the projected keelson tools are the whole surface this gate governs.
  evaluateToolCall?: ToolCallGate;
}

// Projects our streaming ToolDefinitions into pi's "execute returns result"
// custom-tool shape. The handler validates with the tool's inputSchema, runs
// `execute()`, and captures the emitted tool_result as the returned content.
// Failures (invalid input, a throw, an isError result) THROW — pi converts a
// throwing execute into an error tool result, which is what marks
// tool_execution_end with isError for the bridge.
export function projectToolsForPi(
  tools: readonly ToolDefinition[],
  projection: PiToolProjectionContext,
): PiProjectedTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // pi requires a parameters schema; zero-arg tools get an empty object.
    parameters: deriveToolParametersJsonSchema(tool) ?? { type: "object", properties: {} },
    execute: async (_toolCallId, params, signal) => {
      let resultContent: string | null = null;
      let resultIsError = false;
      // pi always supplies its own loop signal, but keelson's Stop aborts the
      // turn signal, not pi's — combine them so either cancels the tool.
      const signals = [signal, projection.abortSignal].filter((s) => s !== undefined);
      const ctx: ToolContext = {
        cwd: projection.cwd,
        abortSignal:
          signals.length > 1
            ? AbortSignal.any(signals)
            : (signals[0] ?? new AbortController().signal),
        emit: (chunk) => {
          if (chunk.type === "tool_result") {
            resultContent = chunk.content;
            if (chunk.isError) resultIsError = true;
            return;
          }
          projection.pushChunk(chunk);
        },
      };

      const parsed = tool.inputSchema.safeParse(params);
      if (!parsed.success) {
        throw new Error(`Invalid input for tool '${tool.name}': ${parsed.error.message}`);
      }
      // Per-call policy gate, after validation so a policy sees normalized args.
      // A deny throws — pi turns the throw into an error tool result.
      const gateResult = await checkToolCallGate(
        projection.evaluateToolCall,
        tool.name,
        parsed.data,
      );
      if (gateResult.denied) {
        throw new Error(gateResult.message);
      }
      await tool.execute(parsed.data, ctx);
      if (resultIsError) {
        throw new Error(resultContent ?? `tool '${tool.name}' failed`);
      }
      return { content: [{ type: "text", text: resultContent ?? "" }], details: undefined };
    },
  }));
}
