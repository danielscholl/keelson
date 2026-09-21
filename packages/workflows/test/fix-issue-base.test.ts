// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseWorkflow } from "../src/loader.ts";

describe("fix-issue default branch", () => {
  test("derives the PR and diff base instead of assuming main", () => {
    const filePath = join(import.meta.dir, "../assets/workflows/fix-issue.yaml");
    const source = readFileSync(filePath, "utf8");
    const result = parseWorkflow(source, filePath);

    expect(result.error).toBeNull();
    expect(source).toContain("- id: detect-base");
    expect(source).toContain(".default-branch");
    expect(source).not.toContain("--base main");
    expect(source).not.toContain("main...HEAD");
  });

  test("reviewers declare fail-closed findings contracts", () => {
    const filePath = join(import.meta.dir, "../assets/workflows/fix-issue.yaml");
    const source = readFileSync(filePath, "utf8");
    const result = parseWorkflow(source, filePath);

    expect(result.error).toBeNull();
    for (const id of ["review-correctness", "review-conventions", "review-coverage"]) {
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

    expect(source).not.toContain("Output a numbered list");
    expect(source).not.toContain("No correctness issues found.");
    expect(source).not.toContain("No convention issues found.");
    expect(source).not.toContain("Coverage adequate.");
  });

  test("the correctness lens follows changed code to its other entry paths and its docs", () => {
    const filePath = join(import.meta.dir, "../assets/workflows/fix-issue.yaml");
    const result = parseWorkflow(readFileSync(filePath, "utf8"), filePath);
    const node = result.workflow?.nodes.find((candidate) => candidate.id === "review-correctness");
    const prompt = node?.prompt?.replace(/\s+/g, " ");

    expect(result.error).toBeNull();
    expect(prompt).toContain("list every entry path that reaches it");
    expect(prompt).toContain("data written before this change");
    expect(prompt).toContain("docs that must agree with the code");
    expect(node?.allowed_tools).toEqual(["Read", "Glob", "Grep"]);
  });

  test("the fix loop checks what else a fix touches", () => {
    const filePath = join(import.meta.dir, "../assets/workflows/fix-issue.yaml");
    const result = parseWorkflow(readFileSync(filePath, "utf8"), filePath);
    const promptOf = (id: string) =>
      result.workflow?.nodes.find((node) => node.id === id)?.prompt?.replace(/\s+/g, " ");

    expect(promptOf("apply-fixes")).toContain("Before committing a fix, name what else it touches");
    expect(promptOf("re-review")).toContain("Look past the line each fix touched");
  });

  test("triage requires a correctness verdict before declaring ship-ready", () => {
    const filePath = join(import.meta.dir, "../assets/workflows/fix-issue.yaml");
    const result = parseWorkflow(readFileSync(filePath, "utf8"), filePath);
    const prompt = result.workflow?.nodes.find((node) => node.id === "triage")?.prompt;
    const compactPrompt = prompt?.replace(/\s+/g, " ");

    expect(result.error).toBeNull();
    expect(compactPrompt).toContain(
      "An empty `findings` array means a reviewer ran and found nothing.",
    );
    expect(compactPrompt).toContain("Correctness section is not a findings object");
    expect(compactPrompt).toContain("set `ship_ready` to false");
    expect(compactPrompt).toContain("correctness reviewer produced no verdict");
    expect(compactPrompt).not.toContain("may be empty if that reviewer did not run");
  });
});
