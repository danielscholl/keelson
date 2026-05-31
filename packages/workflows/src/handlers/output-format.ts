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
 * Three-branch extract: parse-as-is, strip ```json fences and retry, else
 * `undefined` — on that miss the handler keeps the raw text as `kind: "text"`,
 * preserving the substitute layer's existing JSON-parse failure mode.
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

  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
