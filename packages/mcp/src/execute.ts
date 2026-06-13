// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { errText, type ToolContext, type ToolDefinition } from "@keelson/shared";
import { getToolByName } from "@keelson/skills";

export interface ExecuteToolOptions {
  // Working directory handed to the tool. Server-resolved (the default
  // project root), never client-supplied — see createKeelsonMcpServer.
  cwd: string;
  abortSignal: AbortSignal;
}

export interface ExecuteToolResult {
  content: string;
  isError: boolean;
}

// Run one registered keelson tool by name, server-side, and collapse its
// emitted chunks into a single result. Provider-agnostic sibling of the pi
// tool projection: it NEVER throws — an unknown tool, invalid input, a thrown
// execute, or a tool_result flagged isError all surface as { isError: true } so
// an MCP CallToolResult carries the failure instead of breaking the transport.
export async function executeRegisteredTool(
  name: string,
  input: unknown,
  opts: ExecuteToolOptions,
): Promise<ExecuteToolResult> {
  let tool: ToolDefinition;
  try {
    tool = getToolByName(name);
  } catch (err) {
    return { content: errText(err), isError: true };
  }
  return executeToolDefinition(tool, input, opts);
}

// Core of the above, for callers that have already resolved the tool (e.g. the
// MCP server, whose tool universe is the registry plus injected extras).
export async function executeToolDefinition(
  tool: ToolDefinition,
  input: unknown,
  opts: ExecuteToolOptions,
): Promise<ExecuteToolResult> {
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      content: `Invalid input for tool '${tool.name}': ${parsed.error.message}`,
      isError: true,
    };
  }

  // The tool's outcome travels as a tool_result chunk; the last one wins
  // (mirrors the pi projection). Other chunk types have no MCP result slot.
  let resultContent: string | null = null;
  let resultIsError = false;
  const ctx: ToolContext = {
    cwd: opts.cwd,
    abortSignal: opts.abortSignal,
    emit: (chunk) => {
      if (chunk.type === "tool_result") {
        resultContent = chunk.content;
        resultIsError = chunk.isError === true;
      }
    },
  };

  try {
    await tool.execute(parsed.data, ctx);
  } catch (err) {
    return { content: errText(err), isError: true };
  }
  return { content: resultContent ?? "", isError: resultIsError };
}
