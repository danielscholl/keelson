// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// @keelson/workflows mirrors a handful of values from @keelson/shared verbatim
// to keep its dep graph free. These assertions guard against silent drift —
// any v2 bump of the memory schema must update both packages atomically.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  memoryTypeSchema,
  RECALL_REQUEST_SCHEMA_VERSION,
  WRITEBACK_REQUEST_SCHEMA_VERSION,
} from "../src/memory.ts";

const WORKFLOWS_ROOT = join(import.meta.dir, "..", "..", "workflows", "src");

function readWorkflowsSource(relPath: string): string {
  return readFileSync(join(WORKFLOWS_ROOT, relPath), "utf8");
}

describe("@keelson/workflows mirrors of shared wire constants", () => {
  test("RECALL_REQUEST_SCHEMA_VERSION literal matches", () => {
    const source = readWorkflowsSource("executor.ts");
    const match = source.match(/RECALL_REQUEST_SCHEMA_VERSION\s*=\s*"([^"]+)"/);
    expect(match?.[1]).toBe(RECALL_REQUEST_SCHEMA_VERSION);
  });

  test("WRITEBACK_REQUEST_SCHEMA_VERSION literal matches", () => {
    const source = readWorkflowsSource("executor.ts");
    const match = source.match(/WRITEBACK_REQUEST_SCHEMA_VERSION\s*=\s*"([^"]+)"/);
    expect(match?.[1]).toBe(WRITEBACK_REQUEST_SCHEMA_VERSION);
  });

  test("memoryType enum entries match", () => {
    const source = readWorkflowsSource("schema/memory-block.ts");
    const block = source.match(/const memoryTypeSchema = z\.enum\(\[([\s\S]*?)\]\)/);
    const body = block?.[1] ?? "";
    expect(body.length).toBeGreaterThan(0);
    const mirrored = Array.from(body.matchAll(/"([^"]+)"/g), (m) => m[1] ?? "");
    expect(mirrored).toEqual([...memoryTypeSchema.options]);
  });
});
