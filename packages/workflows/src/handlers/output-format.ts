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
  const doomed = new Set<number>();
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if ((ch !== "{" && ch !== "[") || doomed.has(i)) {
      i++;
      continue;
    }
    const end = jsonSpanEnd(text, i, doomed);
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

type Expect = "value" | "value-or-close" | "key" | "key-or-close" | "colon" | "comma-or-close";

/**
 * Index of the bracket closing the JSON value opened at `start`, or undefined
 * when the text there isn't one. Recognizes the grammar rather than counting
 * brackets, so garbage is rejected where it stands instead of by a later parse
 * of the whole span. String state starts fresh at `start` — a stray quote in
 * the narration says nothing about this candidate.
 *
 * Brackets still open when a scan gives up are added to `doomed`. Each would
 * read the same text from the same state, so each is beyond saving too, and
 * without that the reply's suffix is rescanned once per bracket.
 */
function jsonSpanEnd(text: string, start: number, doomed: Set<number>): number | undefined {
  const stack: string[] = [];
  const opens: number[] = [];
  let expect: Expect = "value";
  let i = start;

  const abandon = (): undefined => {
    for (const open of opens) doomed.add(open);
    return undefined;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    const top = stack[stack.length - 1];

    if (expect === "colon") {
      if (ch !== ":") return abandon();
      i++;
      expect = "value";
    } else if (expect === "key" || expect === "key-or-close") {
      if (ch === "}" && expect === "key-or-close" && top === "{") {
        stack.pop();
        opens.pop();
        if (stack.length === 0) return i;
        i++;
        expect = "comma-or-close";
        continue;
      }
      if (ch !== '"') return abandon();
      const closed = stringEnd(text, i);
      if (closed === undefined) return abandon();
      i = closed + 1;
      expect = "colon";
    } else if (expect === "comma-or-close") {
      if (ch === ",") {
        i++;
        expect = top === "{" ? "key" : "value";
      } else if ((ch === "}" && top === "{") || (ch === "]" && top === "[")) {
        stack.pop();
        opens.pop();
        if (stack.length === 0) return i;
        i++;
      } else return abandon();
    } else {
      if (ch === "]" && expect === "value-or-close" && top === "[") {
        stack.pop();
        opens.pop();
        if (stack.length === 0) return i;
        i++;
        expect = "comma-or-close";
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push(ch);
        opens.push(i);
        i++;
        expect = ch === "{" ? "key-or-close" : "value-or-close";
        continue;
      }
      const closed = scalarEnd(text, i);
      if (closed === undefined) return abandon();
      i = closed + 1;
      expect = "comma-or-close";
    }
  }
  return abandon();
}

function scalarEnd(text: string, start: number): number | undefined {
  if (text[start] === '"') return stringEnd(text, start);
  if (text.startsWith("true", start)) return start + 3;
  if (text.startsWith("false", start)) return start + 4;
  if (text.startsWith("null", start)) return start + 3;
  return numberEnd(text, start);
}

function numberEnd(text: string, start: number): number | undefined {
  let i = start;
  if (text[i] === "-") i++;
  const whole = digitsEnd(text, i);
  if (whole === i) return undefined;
  i = whole;
  if (text[i] === ".") {
    const frac = digitsEnd(text, i + 1);
    if (frac === i + 1) return undefined;
    i = frac;
  }
  if (text[i] === "e" || text[i] === "E") {
    let exp = i + 1;
    if (text[exp] === "+" || text[exp] === "-") exp++;
    const digits = digitsEnd(text, exp);
    if (digits === exp) return undefined;
    i = digits;
  }
  return i - 1;
}

function digitsEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined || ch < "0" || ch > "9") break;
    i++;
  }
  return i;
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
