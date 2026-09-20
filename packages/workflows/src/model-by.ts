// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { DagNode, ModelBy, ModelCase, NodeOutput } from "./schema/index.ts";

// The two selector shapes `model_by.from` accepts. Node ids allow hyphens (the
// substitution grammar); input keys and JSON fields do not.
const INPUTS_SELECTOR = /^\$inputs\.([a-zA-Z_][a-zA-Z0-9_]*)$/;
const OUTPUT_SELECTOR = /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?$/;

// A substitution namespace is not a node, so `$inputs.output.tier` and
// `$ARTIFACTS_DIR.output` match the output grammar but can never resolve. They
// are rejected rather than left to read empty at runtime.
const RESERVED_SELECTOR_NAMESPACES = new Set([
  "inputs",
  "ARGUMENTS",
  "ARTIFACTS_DIR",
  "memory",
  "converge",
]);

export function isModelSelector(from: string): boolean {
  const expr = from.trim();
  if (INPUTS_SELECTOR.test(expr)) return true;
  const output = OUTPUT_SELECTOR.exec(expr);
  return output?.[1] !== undefined && !RESERVED_SELECTOR_NAMESPACES.has(output[1]);
}

/**
 * Resolve `model_by.from` to the string a case key is matched against. Returns
 * the empty string when the referenced input or output is absent, or when a
 * field lookup lands on non-JSON — the caller turns that into a failed node
 * rather than a silent default.
 */
export function resolveModelSelector(
  from: string,
  inputs: Readonly<Record<string, string>>,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
): string {
  const expr = from.trim();

  const inputMatch = INPUTS_SELECTOR.exec(expr);
  if (inputMatch?.[1] !== undefined) {
    // Own-property only: a prototype-named key (`constructor`, `toString`)
    // otherwise reads an inherited function and throws on `.trim()`.
    const key = inputMatch[1];
    const value = Object.hasOwn(inputs, key) ? inputs[key] : undefined;
    return typeof value === "string" ? value.trim() : "";
  }

  const outputMatch = OUTPUT_SELECTOR.exec(expr);
  if (outputMatch?.[1] === undefined || RESERVED_SELECTOR_NAMESPACES.has(outputMatch[1])) {
    return "";
  }
  const output = nodeOutputs.get(outputMatch[1])?.output;
  if (output === undefined || output.length === 0) return "";

  const field = outputMatch[2];
  if (field === undefined) return output.trim();
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, field)) return "";
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  } catch {
    return "";
  }
}

export type ModelCaseSelection =
  | { ok: true; caseKey: string; selected: ModelCase }
  | { ok: false; error: string };

/**
 * Pick the case a node runs under. An unmatched selector takes `default` when
 * the author declared one and fails otherwise: a node that quietly ran on a
 * model nobody chose is the failure this map exists to prevent, and the value
 * that missed is the one piece of information needed to fix it.
 */
export function selectModelCase(
  modelBy: ModelBy,
  inputs: Readonly<Record<string, string>>,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
): ModelCaseSelection {
  const value = resolveModelSelector(modelBy.from, inputs, nodeOutputs);
  // Own-property only, for the same reason the input lookup above is: a
  // selector yielding `constructor` would otherwise match an inherited member
  // and run the node on its static pin instead of failing or taking the default.
  const direct =
    value.length > 0 && Object.hasOwn(modelBy.cases, value) ? modelBy.cases[value] : undefined;
  if (direct !== undefined) return { ok: true, caseKey: value, selected: direct };

  if (modelBy.default !== undefined && Object.hasOwn(modelBy.cases, modelBy.default)) {
    const fallback = modelBy.cases[modelBy.default];
    // The schema already rejects a default that names no case; this keeps the
    // runtime total rather than trusting that across a hand-built definition.
    if (fallback !== undefined) return { ok: true, caseKey: modelBy.default, selected: fallback };
  }

  const known = Object.keys(modelBy.cases).sort().join(", ");
  const seen = value.length > 0 ? `'${value}'` : "an empty value";
  return {
    ok: false,
    error: `model_by.from (${modelBy.from}) resolved to ${seen}, which matches no case (${known}) and no default is declared`,
  };
}

/**
 * The node the handler should run: the selected case's `model`,
 * `model_by_provider` and `effort` replace the node's static ones. A case that
 * sets only `effort` leaves the node's model alone, and vice versa.
 */
export function applyModelCase(node: DagNode, selected: ModelCase): DagNode {
  return {
    ...node,
    ...(selected.model !== undefined ? { model: selected.model } : {}),
    ...(selected.model_by_provider !== undefined
      ? { model_by_provider: selected.model_by_provider }
      : {}),
    ...(selected.effort !== undefined ? { effort: selected.effort } : {}),
  } as DagNode;
}
