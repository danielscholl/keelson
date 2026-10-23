// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { capabilityToolName } from "../copilot/tool-names.ts";
import { applyToolResultGate, checkToolCallGate } from "../tool-gate.ts";
import type { ToolCallGate, ToolResultGate } from "../types.ts";
import { PI_TOOL_KIND } from "./tool-filter.ts";

export interface PiToolGates {
  evaluateToolCall?: ToolCallGate;
  evaluateToolResult?: ToolResultGate;
}

// Structural slice of pi's ExtensionAPI and tool events this extension uses.
interface PiContentPart {
  type: string;
  text?: string;
}
interface PiToolCallEventLike {
  toolCallId?: string;
  toolName: string;
  input: unknown;
}
interface PiToolResultEventLike {
  toolCallId?: string;
  toolName: string;
  input: unknown;
  content: readonly PiContentPart[];
  isError: boolean;
}
export interface PiGateExtensionApi {
  on(
    event: "tool_call",
    handler: (event: PiToolCallEventLike) => Promise<{ block: true; reason: string } | undefined>,
  ): unknown;
  on(
    event: "tool_result",
    handler: (
      event: PiToolResultEventLike,
    ) => Promise<{ content: PiContentPart[]; isError: boolean } | undefined>,
  ): unknown;
}

export interface PiGateOptions {
  // Seconds applied to a bash call that sets no timeout, so a runaway command
  // (a `find /`) cannot stall the turn.
  bashTimeoutSec?: number;
  // Blocks a call once the identical call has returned the identical result
  // this many times in the session; unset or 0 disables. Local models can
  // cycle through the same few lookups indefinitely.
  repeatCallLimit?: number;
}

function resultText(content: readonly PiContentPart[]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

// One policy gate for every tool a pi session can call — pi's built-ins,
// extension tools, MCP tools — via pi's own tool_call / tool_result hooks.
// Projected keelson tools gate inside their own execute (after schema
// validation), so they are skipped here rather than gated twice.
export function createPiGateExtension(
  gates: PiToolGates,
  selfGated: ReadonlySet<string>,
  options: PiGateOptions = {},
): (pi: PiGateExtensionApi) => void {
  return (pi) => {
    const repeats = new Map<string, { result: string; count: number }>();
    const repeatBlocked = new Set<string>();
    const callKey = (toolName: string, input: unknown) => `${toolName}\0${JSON.stringify(input)}`;
    pi.on("tool_call", async (event) => {
      // pi applies tool_call input mutations before the tool runs.
      if (event.toolName === "bash" && options.bashTimeoutSec !== undefined) {
        const input = event.input as { timeout?: unknown } | null;
        if (input !== null && typeof input === "object" && input.timeout === undefined) {
          input.timeout = options.bashTimeoutSec;
        }
      }
      const limit = options.repeatCallLimit ?? 0;
      const seen = limit > 0 ? repeats.get(callKey(event.toolName, event.input)) : undefined;
      if (seen !== undefined && seen.count >= limit) {
        if (event.toolCallId !== undefined) repeatBlocked.add(event.toolCallId);
        return {
          block: true,
          reason: `This exact ${event.toolName} call already returned the same result ${seen.count} times. Use that result and move on to a different step.`,
        };
      }
      if (selfGated.has(event.toolName)) return undefined;
      // Operator policy names built-ins canonically (Bash, Write, …), as copilot
      // reports them; policies written for pi's own name still get their turn.
      const kind = PI_TOOL_KIND[event.toolName];
      const canonical = kind !== undefined ? capabilityToolName(kind) : undefined;
      if (canonical !== undefined && canonical !== event.toolName) {
        const result = await checkToolCallGate(gates.evaluateToolCall, canonical, event.input);
        if (result.denied) return { block: true, reason: result.message };
      }
      const result = await checkToolCallGate(gates.evaluateToolCall, event.toolName, event.input);
      return result.denied ? { block: true, reason: result.message } : undefined;
    });
    pi.on("tool_result", async (event) => {
      const text = resultText(event.content);
      const wasRepeatBlocked =
        event.toolCallId !== undefined && repeatBlocked.delete(event.toolCallId);
      if ((options.repeatCallLimit ?? 0) > 0 && !wasRepeatBlocked) {
        const key = callKey(event.toolName, event.input);
        const seen = repeats.get(key);
        repeats.set(key, {
          result: text,
          count: seen !== undefined && seen.result === text ? seen.count + 1 : 1,
        });
      }
      if (gates.evaluateToolResult === undefined || selfGated.has(event.toolName)) return undefined;
      const gated = await applyToolResultGate(
        gates.evaluateToolResult,
        event.toolName,
        text,
        event.isError,
      );
      if (gated.content === text && gated.isError === event.isError) return undefined;
      // Replacing content without structuredContent drops it, so a redacted
      // result can't leak through the structured channel.
      return {
        content: [
          { type: "text", text: gated.content },
          ...(gated.isError ? [] : event.content.filter((part) => part.type !== "text")),
        ],
        isError: gated.isError,
      };
    });
  };
}
