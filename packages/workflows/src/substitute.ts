/**
 * Variable + node-output substitution for prompts and bash scripts.
 *
 * Two passes:
 * 1. {@link substituteWorkflowVariables} — `$ARGUMENTS`, `$1..$9`, `\$` escape.
 *    Ported from Archon `packages/workflows/src/utils/variable-substitution.ts`.
 * 2. {@link substituteNodeOutputRefs} — `$nodeId.output` and `$nodeId.output.field`.
 *    Ported from Archon `packages/workflows/src/dag-executor.ts:substituteNodeOutputRefs`.
 * 3. {@link substituteDirectiveRefs} — `$DIRECTIVES.<name>` expands to the
 *    harness-owned directive text; `\$DIRECTIVES.<name>` stays literal.
 *
 * All helpers are pure and deterministic.
 */

import { DIRECTIVE_NAMES, resolveDirective } from "./directives.ts";
import type { NodeOutput } from "./schema/index.ts";

/**
 * Single-quote a string for safe inclusion in a bash `bash -c '...'` script.
 *
 * Replaces every embedded `'` with `'\''` (close-quote, escaped quote, re-open
 * quote) and wraps the result in single quotes. Idiomatic POSIX shell escaping;
 * matches Archon's behavior byte-for-byte.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Substitute workflow-level variables in command text.
 *
 * Supported variables:
 * - `$1, $2, ..., $9` — positional arguments
 * - `$ARGUMENTS`      — all arguments joined with spaces
 * - `\$`              — literal dollar sign (escape)
 *
 * Unmatched positional refs (`$5` when only 3 args given) are left untouched —
 * downstream substitution may fill them, or the user can spot the leak.
 */
export function substituteWorkflowVariables(text: string, args: string[]): string {
  let result = text;

  args.forEach((arg, index) => {
    result = result.replace(new RegExp(`\\$${String(index + 1)}`, "g"), arg);
  });

  result = result.replace(/\$ARGUMENTS/g, args.join(" "));
  result = result.replace(/\\\$/g, "$");

  return result;
}

/**
 * Substitute `$nodeId.output` and `$nodeId.output.field` references against
 * the captured outputs of upstream nodes.
 *
 * - `$nodeId.output` — full text output of the node
 * - `$nodeId.output.field` — value of `field` after JSON-parsing the output
 *
 * Behavior:
 * - Unknown node id → empty string (silent — substitution is best-effort)
 * - Empty/falsy output → empty string
 * - Field lookup on non-JSON or missing field → empty string
 * - Object/array/null values → JSON-encoded so a structured section passes
 *   through intact (matches the executor's resolveBody); strings/numbers/
 *   booleans render as their plain value
 *
 * @param escapedForBash — when true, substituted values are wrapped via
 *   {@link shellQuote} so they're safe inside `bash -c '...'`. Numbers and
 *   booleans are emitted unquoted (no shell-metacharacter risk). Use true only
 *   for bash node substitution; AI/prompt substitution should pass false.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash = false,
): string {
  return prompt.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g,
    (_match, nodeId: string, field: string | undefined) => {
      const nodeOutput = nodeOutputs.get(nodeId);
      if (!nodeOutput) return escapedForBash ? "''" : "";
      if (!field) {
        return escapedForBash ? shellQuote(nodeOutput.output) : nodeOutput.output;
      }
      try {
        const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
        // Own-property only: a prototype-named ref (`__proto__`, `constructor`)
        // is a missing field, not the inherited member bracket-access returns.
        if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, field)) {
          return escapedForBash ? "''" : "";
        }
        const value = parsed[field];
        if (typeof value === "string") {
          return escapedForBash ? shellQuote(value) : value;
        }
        // JSON disallows NaN/Infinity, so String(number) is shell-safe.
        // String(boolean) is 'true' or 'false' — also shell-safe.
        if (typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        // Object/array/null sections JSON-encode (own JSON values always stringify).
        const encoded = JSON.stringify(value);
        return escapedForBash ? shellQuote(encoded) : encoded;
      } catch {
        return escapedForBash ? "''" : "";
      }
    },
  );
}

const DIRECTIVE_REF_PATTERN = /(\\)?\$DIRECTIVES\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Substitute `$DIRECTIVES.<name>` with the named directive's text.
 *
 * - `\$DIRECTIVES.<name>` — the backslash is stripped and the marker stays
 *   literal, matching the `\$` escape of the other substitutions.
 * - An unknown name is left untouched; the loader rejects it at parse time,
 *   so a literal survivor here is a workflow that bypassed the loader.
 */
export function substituteDirectiveRefs(text: string): string {
  return text.replace(
    DIRECTIVE_REF_PATTERN,
    (match, backslash: string | undefined, name: string) => {
      if (backslash !== undefined) return match.slice(1);
      return resolveDirective(name) ?? match;
    },
  );
}

/** Unknown names behind unescaped `$DIRECTIVES.` refs, in order of appearance. */
export function findUnknownDirectiveRefs(text: string): string[] {
  const unknown: string[] = [];
  for (const m of text.matchAll(DIRECTIVE_REF_PATTERN)) {
    const name = m[2];
    if (m[1] !== undefined || name === undefined) continue;
    if (!DIRECTIVE_NAMES.includes(name)) unknown.push(name);
  }
  return unknown;
}
