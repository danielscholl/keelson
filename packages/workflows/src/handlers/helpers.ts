// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { NodeResult } from "../executor.ts";
import type { DagNode, PromptNode } from "../schema/index.ts";
import { BASH_NODE_AI_FIELDS } from "../schema/index.ts";

const SUBPROCESS_ERROR_MAX_CHARS = 2_000;

/** Build a `failed` NodeResult with the given error and optional captured text. */
export function failed(error: string, text = ""): NodeResult {
  return { status: "failed", output: { kind: "text", text }, error };
}

/**
 * Canonical set of AI-side fields carried verbatim when synthesizing a
 * PromptNode for command/loop iteration. Derived from the schema's
 * `BASH_NODE_AI_FIELDS` so any new SDK field added there automatically
 * propagates — no second list to keep in sync.
 *
 * `idle_timeout`/`timeout` are appended rather than added to
 * `BASH_NODE_AI_FIELDS`: that list also drives the loader's "meaningless on
 * bash" warning, where `idle_timeout` legitimately belongs. The prompt handler
 * does read them, so a synthesized prompt node must still inherit them.
 */
export const AI_PASSTHROUGH_KEYS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS,
  "idle_timeout",
  "timeout",
];

/**
 * Synthesize a `PromptNode` from a source DagNode (typically a `CommandNode`
 * or `LoopNode`). Carries every AI passthrough field present on the source so
 * per-node overrides (`model`, `provider`, `allowed_tools`, …) still apply.
 */
export function synthesizePromptNode(
  source: DagNode,
  overrides: { id: string; prompt: string },
): PromptNode {
  const src = source as Record<string, unknown>;
  const out: Record<string, unknown> = { id: overrides.id, prompt: overrides.prompt };
  for (const key of AI_PASSTHROUGH_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out as PromptNode;
}

/** True when the script body is inline code (newlines or shell metacharacters); false for a bare identifier reference. */
export function isInlineScript(script: string): boolean {
  return script.includes("\n") || /[;(){}&|<>$`"' ]/.test(script);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `output` contains the loop's completion signal.
 *
 * Plain-text branches are restrictive on purpose so "not DONE yet" doesn't
 * trip detection. Authors who want bulletproof matching wrap the signal in
 * a tag (`<promise>DONE</promise>`) — the recommended form.
 */
export function detectCompletionSignal(output: string, signal: string): boolean {
  const wrapped = new RegExp(`<([a-zA-Z][\\w-]*)[^>]*>\\s*${escapeRegExp(signal)}\\s*</\\1>`, "i");
  if (wrapped.test(output)) return true;
  const endPattern = new RegExp(`${escapeRegExp(signal)}[\\s.,;:!?]*$`);
  const ownLine = new RegExp(`^\\s*${escapeRegExp(signal)}\\s*$`, "m");
  return endPattern.test(output) || ownLine.test(output);
}

/**
 * Strip completion-signal tags from iteration output. Always strips
 * `<promise>…</promise>`. When `until` is provided, also strips matching
 * `<tag>SIGNAL</tag>`; mismatched tag names are left intact.
 */
export function stripCompletionTags(content: string, until?: string): string {
  let result = content.replace(/<promise>[\s\S]*?<\/promise>/gi, "");
  if (until !== undefined && until.length > 0) {
    const escaped = escapeRegExp(until);
    result = result.replace(
      new RegExp(`<([a-zA-Z][\\w-]*)[^>]*>\\s*${escaped}\\s*</\\1>`, "gi"),
      "",
    );
  }
  return result.trim();
}

export interface SubprocessFailureFields {
  cmd: string;
  args?: readonly string[];
  exitCode?: number | string | null;
  stderrTail?: string;
  signal?: string | null;
}

export function formatSubprocessFailure(label: string, fields: SubprocessFailureFields): string {
  const stderr = (fields.stderrTail ?? "").trim();
  const diagnostic =
    stderr.length > SUBPROCESS_ERROR_MAX_CHARS
      ? `${stderr.slice(-SUBPROCESS_ERROR_MAX_CHARS)}\n…[truncated]`
      : stderr.length > 0
        ? stderr
        : "no diagnostic output";

  const exitSuffix =
    fields.exitCode !== undefined && fields.exitCode !== null
      ? ` [exit ${String(fields.exitCode)}]`
      : fields.signal
        ? ` [signal ${fields.signal}]`
        : "";
  return `${label} failed${exitSuffix}: ${diagnostic}`;
}
