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
import { buildOutputFormatSuffix, extractJsonValue } from "./output-format.ts";

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

describe("extractJsonValue", () => {
  test("parses a reply that is already a JSON object", () => {
    const raw = '  {"kind":"bug","title":"oops"}  ';
    expect(extractJsonValue(raw)).toEqual({ kind: "bug", title: "oops" });
  });

  test("strips ```json fences before parsing", () => {
    const raw = '```json\n{"kind": "feature"}\n```';
    expect(extractJsonValue(raw)).toEqual({ kind: "feature" });
  });

  test("strips bare ``` fences before parsing", () => {
    const raw = '```\n{"kind":"chore"}\n```';
    expect(extractJsonValue(raw)).toEqual({ kind: "chore" });
  });

  test("returns undefined when no JSON can be extracted", () => {
    const raw = "I think it is a bug.";
    expect(extractJsonValue(raw)).toBeUndefined();
  });

  test("returns undefined when fenced content is not valid JSON", () => {
    const raw = "```\nnot really json\n```";
    expect(extractJsonValue(raw)).toBeUndefined();
  });

  test("returns undefined for empty input", () => {
    expect(extractJsonValue("")).toBeUndefined();
  });

  test("parses nested objects and arrays", () => {
    const raw = '{ "items": [1, 2, 3], "meta": { "ok": true } }';
    expect(extractJsonValue(raw)).toEqual({ items: [1, 2, 3], meta: { ok: true } });
  });

  // A tool-using node's between-call narration is concatenated in front of its
  // final answer, so the reply as a whole never parses.
  test("recovers the answer from behind a tool-using model's narration", () => {
    const raw = [
      "I'll verify the candidates against the actual code.",
      "I'll use the view tool instead.",
      "",
      '{"verdict":"READY TO MERGE","summary":"All candidates refuted.","findings":[]}',
    ].join("\n");
    expect(extractJsonValue(raw)).toEqual({
      verdict: "READY TO MERGE",
      summary: "All candidates refuted.",
      findings: [],
    });
  });

  test("takes the final answer, not an object quoted in the narration", () => {
    const raw =
      'Earlier I considered {"verdict":"NEEDS FIXES"} but settled on:\n{"verdict":"READY TO MERGE"}';
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY TO MERGE" });
  });

  // Scanning backwards from the last brace would return the empty `findings`
  // array; the answer is the object enclosing it.
  test("does not mistake a nested array for the enclosing answer", () => {
    const raw = 'Done.\n{"verdict":"READY TO MERGE","findings":[]}';
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY TO MERGE", findings: [] });
  });

  test("recovers a fenced answer that follows narration", () => {
    const raw = 'Here is the result:\n```json\n{"kind":"feature"}\n```';
    expect(extractJsonValue(raw)).toEqual({ kind: "feature" });
  });

  test("ignores braces inside JSON strings when scanning", () => {
    const raw = 'Note:\n{"fix":"replace with `}` here","line":3}';
    expect(extractJsonValue(raw)).toEqual({ fix: "replace with `}` here", line: 3 });
  });

  test("returns undefined when narration contains no JSON at all", () => {
    expect(extractJsonValue("I think it is a bug { not json ]")).toBeUndefined();
  });

  // Narration quoting a code fragment leaves a bracket open; the answer after
  // it must still be found.
  test("an unclosed bracket in the narration does not bury the answer", () => {
    const raw = 'The guard reads `if (x) {` and drops the else.\n{"verdict":"NEEDS FIXES"}';
    expect(extractJsonValue(raw)).toEqual({ verdict: "NEEDS FIXES" });
  });

  // Prose quotes carry no structure, so an odd count of them must not invert
  // the parity of everything that follows.
  test("an unmatched quote in the narration does not hide the answer", () => {
    const raw = 'The token starts with "foo\n{"verdict":"READY"}';
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY" });
  });

  test("an unmatched quote on the answer's own line does not hide it", () => {
    const raw = 'He said "hi: {"verdict":"READY"}';
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY" });
  });

  test("a string left open in stray narration brackets does not hide the answer", () => {
    const raw = 'code: { "unterminated\n{"verdict":"READY"}';
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY" });
  });

  // Streamed chunks are concatenated without a separator, so an unmatched
  // opener and an unmatched quote can share the answer's line.
  test("an unmatched opener and quote on the answer's line do not hide it", () => {
    const raw = 'code: { "unfinished {"verdict":"READY"}';
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY" });
  });

  test("scans a large narration of unclosed braces without pathological slowdown", () => {
    const raw = `${"{".repeat(20000)}\n{"verdict":"READY TO MERGE"}`;
    const started = performance.now();
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY TO MERGE" });
    expect(performance.now() - started).toBeLessThan(200);
  });

  // An unclosed `[` opens a legal array, so unlike `{` it survives the head
  // check and must not rescan the suffix once per bracket.
  test("scans a large narration of unclosed brackets without pathological slowdown", () => {
    const raw = `${"[".repeat(20000)}\n{"verdict":"READY TO MERGE"}`;
    const started = performance.now();
    expect(extractJsonValue(raw)).toEqual({ verdict: "READY TO MERGE" });
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("returns undefined for unclosed brackets with no answer", () => {
    expect(extractJsonValue("[".repeat(20000))).toBeUndefined();
  });

  // An inner bracket can still close where an outer one never does.
  test("finds a closing inner span inside an unclosed outer bracket", () => {
    expect(extractJsonValue('Note: [["a"]')).toEqual(["a"]);
  });

  // A deeply nested payload must not be reparsed once per level.
  test("scans a narrated deeply nested payload without pathological slowdown", () => {
    const depth = 8000;
    const raw = `Done.\n${"[".repeat(depth)}0${"]".repeat(depth)}`;
    const started = performance.now();
    expect(extractJsonValue(raw)).not.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
  });
});
