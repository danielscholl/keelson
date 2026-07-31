// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseWorkflow } from "../src/loader.ts";

describe("pr-review verdict contracts", () => {
  test("review lanes declare fail-closed findings contracts", () => {
    const filePath = join(import.meta.dir, "../assets/workflows/pr-review.yaml");
    const source = readFileSync(filePath, "utf8");
    const result = parseWorkflow(source, filePath);

    expect(result.error).toBeNull();
    for (const id of ["code-review", "error-handling", "test-coverage", "docs-impact"]) {
      const node = result.workflow?.nodes.find((candidate) => candidate.id === id);
      expect(node?.output_format).toMatchObject({
        type: "object",
        required: ["findings"],
        properties: { findings: { type: "array" } },
      });
      expect(node?.output_schema).toMatchObject({
        type: "object",
        required: ["findings"],
        properties: { findings: { type: "array" } },
      });
      expect(node?.prompt).toContain('`{"findings":[]}`');
    }

    expect(source).not.toContain("Markdown list. Each finding");
    expect(source).not.toContain("say so in one line");
    expect(source).not.toContain("Same finding shape");
  });

  test("triage rejects a missing required verdict but allows skipped lanes", () => {
    const filePath = join(import.meta.dir, "../assets/workflows/pr-review.yaml");
    const result = parseWorkflow(readFileSync(filePath, "utf8"), filePath);
    const prompt = result.workflow?.nodes.find((node) => node.id === "triage")?.prompt;
    const compactPrompt = prompt?.replace(/\s+/g, " ");

    expect(result.error).toBeNull();
    expect(compactPrompt).toContain("When `run_code_review` is true, Code review is load-bearing");
    expect(compactPrompt).toContain('set `verdict` to "NEEDS FIXES"');
    expect(compactPrompt).toContain("code review produced no verdict");
    expect(compactPrompt).toContain(
      "When `run_code_review` is false, its empty section is a legitimate skip",
    );
    expect(compactPrompt).toContain(
      "Error handling, test coverage, and docs impact may also be legitimately skipped",
    );
    expect(compactPrompt).not.toContain("a section may be empty if that lane was skipped");
  });
});
