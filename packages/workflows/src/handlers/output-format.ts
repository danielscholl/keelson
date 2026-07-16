// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * `output_format` fallback path for the prompt handler.
 *
 * Keelson's providers don't (yet) have a native structured-output hook, so
 * the handler enforces the schema in two steps that happen entirely above
 * the provider boundary:
 *
 * 1. {@link buildOutputFormatSuffix} appends a deterministic instruction to
 *    the resolved prompt body asking the model for a single-line JSON object.
 *    The phrasing mirrors what bundled workflows already use by hand — the
 *    models behave with it.
 * 2. {@link extractJsonValue} parses the model's reply into the value the
 *    prompt handler emits as structured node output; the executor re-encodes
 *    it to a JSON string for downstream `$nodeId.output.field` substitution.
 *
 * Four-branch extract: parse-as-is, strip ```json fences and retry, scan for
 * the last balanced JSON object/array embedded in the reply, else `undefined`.
 * The scan is what makes `output_format` usable on a node with tools: the
 * handler concatenates every text chunk of the turn, so a tool-using model's
 * between-call narration lands in front of its final answer and the whole
 * blob never parses on its own.
 */

const SUFFIX_HEADER =
  "Respond with ONLY a single-line JSON object matching this schema. " +
  "No prose, no markdown fences.";

export function buildOutputFormatSuffix(schema: Readonly<Record<string, unknown>>): string {
  return `\n\n${SUFFIX_HEADER}\nSchema: ${JSON.stringify(schema)}`;
}

const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

export function extractJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = FENCED_JSON.exec(trimmed);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) return inner;
  }

  return lastEmbeddedObject(trimmed);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The last `{…}` / `[…]` in `text` that parses to an object or array — the
 * model's final answer, picked out from behind its narration.
 *
 * One pass, matching brackets on a stack and parsing each pair as it closes;
 * the last pair to close wins, so an enclosing object beats the arrays nested
 * in it and a later sibling beats an earlier one. Candidates are taken per
 * closed pair rather than per top-level pair because narration routinely
 * leaves a bracket open (a quoted `if (x) {`), which would otherwise bury
 * every answer that follows it.
 *
 * Quotes count only inside an open bracket, and a raw newline — which no JSON
 * string may contain — abandons the string. Prose is not JSON, so its quotes
 * carry no structure: reading them as delimiters lets one stray `"` in the
 * narration invert the parity of everything after it and swallow the answer.
 */
function lastEmbeddedObject(text: string): unknown {
  let found: unknown;
  const opens: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\n") {
        inString = false;
        escaped = false;
      } else if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (opens.length > 0) inString = true;
    } else if (ch === "{" || ch === "[") {
      opens.push(i);
    } else if (ch === "}" || ch === "]") {
      const open = opens.pop();
      if (open === undefined) continue;
      if (ch !== (text[open] === "{" ? "}" : "]")) {
        opens.length = 0;
        continue;
      }
      const value = tryParse(text.slice(open, i + 1));
      if (value !== null && typeof value === "object") found = value;
    }
  }
  return found;
}
