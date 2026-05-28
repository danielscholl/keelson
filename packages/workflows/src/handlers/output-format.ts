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
 * 2. {@link extractJsonOutput} normalizes the model's reply so downstream
 *    `$nodeId.output.field` substitution
 *    (`packages/workflows/src/substitute.ts`) sees clean JSON.
 *
 * Three-branch extract: parse-as-is, strip ```json fences and retry, raw
 * passthrough. The substitute helper already swallows `JSON.parse` failures
 * silently, so the raw fallback preserves the existing failure mode.
 */

const SUFFIX_HEADER =
  "Respond with ONLY a single-line JSON object matching this schema. " +
  "No prose, no markdown fences.";

export function buildOutputFormatSuffix(schema: Readonly<Record<string, unknown>>): string {
  return `\n\n${SUFFIX_HEADER}\nSchema: ${JSON.stringify(schema)}`;
}

const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

export function extractJsonOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return JSON.stringify(direct);

  const fenced = FENCED_JSON.exec(trimmed);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) return JSON.stringify(inner);
  }

  return raw;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
