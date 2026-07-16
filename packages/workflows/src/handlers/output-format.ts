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
 * the last JSON object/array embedded in the reply, else `undefined`. The scan
 * exists because the handler concatenates every text chunk of a turn, so a
 * tool-using model's between-call narration lands in front of its answer.
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

// Narration is not JSON: its brackets and quotes may be unmatched in any
// combination, so nothing outside a candidate may be read as structure.
function lastEmbeddedObject(text: string): unknown {
  let found: unknown;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }
    const end = jsonSpanEnd(text, i);
    if (end === undefined) {
      i++;
      continue;
    }
    const value = tryParse(text.slice(i, end + 1));
    if (value !== null && typeof value === "object") {
      // Anything nested inside this span ends before it does, so it can never
      // be the later answer; skipping keeps a deep payload from being reparsed
      // at every level.
      found = value;
      i = end + 1;
      continue;
    }
    i++;
  }
  return found;
}

// Index of the bracket closing the JSON object/array opened at `start`, or
// undefined when the text there can't be one. String state starts fresh at
// `start` — a stray quote in the narration says nothing about this candidate.
function jsonSpanEnd(text: string, start: number): number | undefined {
  if (!opensJsonValue(text, start)) return undefined;
  const closers: string[] = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const closed = stringEnd(text, i);
      if (closed === undefined) return undefined;
      i = closed;
    } else if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") {
      if (closers.pop() !== ch) return undefined;
      if (closers.length === 0) return i;
    }
  }
  return undefined;
}

const ARRAY_HEAD = /["{[\]\-0-9tfn]/;

// An object opens with a key or closes immediately; an array opens with a value
// or closes. Rejecting the rest here is what keeps a run of prose braces from
// costing a full scan apiece.
function opensJsonValue(text: string, start: number): boolean {
  const head = firstNonSpace(text, start + 1);
  if (head === undefined) return false;
  return text[start] === "{" ? head === '"' || head === "}" : ARRAY_HEAD.test(head);
}

// Index of the quote closing the string opened at `open`. A raw newline ends the
// search: no JSON string holds one, so the candidate is not JSON.
function stringEnd(text: string, open: number): number | undefined {
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === '"') return i;
    else if (ch === "\n") return undefined;
  }
  return undefined;
}

function firstNonSpace(text: string, from: number): string | undefined {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return ch;
  }
  return undefined;
}
