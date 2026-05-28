// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { buildOutputFormatSuffix, extractJsonOutput } from "./output-format.ts";

describe("buildOutputFormatSuffix", () => {
  test("emits a single-line instruction with the stringified schema", () => {
    const suffix = buildOutputFormatSuffix({
      type: "object",
      properties: { kind: { type: "string" } },
    });
    expect(suffix.startsWith("\n\n")).toBe(true);
    expect(suffix).toContain("ONLY a single-line JSON object");
    expect(suffix).toContain("No prose, no markdown fences");
    expect(suffix).toContain('"type":"object"');
    expect(suffix).toContain('"kind":{"type":"string"}');
  });
});

describe("extractJsonOutput", () => {
  test("returns the normalized JSON when the reply is already a JSON object", () => {
    const raw = '  {"kind":"bug","title":"oops"}  ';
    expect(extractJsonOutput(raw)).toBe('{"kind":"bug","title":"oops"}');
  });

  test("strips ```json fences before parsing", () => {
    const raw = '```json\n{"kind": "feature"}\n```';
    expect(extractJsonOutput(raw)).toBe('{"kind":"feature"}');
  });

  test("strips bare ``` fences before parsing", () => {
    const raw = '```\n{"kind":"chore"}\n```';
    expect(extractJsonOutput(raw)).toBe('{"kind":"chore"}');
  });

  test("returns raw text unchanged when no JSON can be extracted", () => {
    const raw = "I think it is a bug.";
    expect(extractJsonOutput(raw)).toBe(raw);
  });

  test("returns raw text when fenced content is not valid JSON", () => {
    const raw = "```\nnot really json\n```";
    expect(extractJsonOutput(raw)).toBe(raw);
  });

  test("preserves an empty input verbatim", () => {
    expect(extractJsonOutput("")).toBe("");
  });

  test("normalizes nested objects and arrays", () => {
    const raw = '{ "items": [1, 2, 3], "meta": { "ok": true } }';
    expect(extractJsonOutput(raw)).toBe('{"items":[1,2,3],"meta":{"ok":true}}');
  });
});
