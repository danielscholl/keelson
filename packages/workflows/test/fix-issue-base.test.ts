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
});
