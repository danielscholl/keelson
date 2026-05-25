// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";

import { parseWorkflow } from "@keelson/workflows";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURES = resolve(import.meta.dir, "fixtures");

describe("workflow validate (parseWorkflow fixture coverage)", () => {
  test("a valid fixture parses with no error", () => {
    const filename = `${FIXTURES}/smoke-bash.yaml`;
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    expect(result.error).toBeNull();
    expect(result.workflow?.name).toBe("smoke-bash");
    expect(result.workflow?.nodes).toHaveLength(1);
  });

  test("a broken fixture produces a schema error", () => {
    const filename = `${FIXTURES}/broken.yaml`;
    const content = readFileSync(filename, "utf-8");
    const result = parseWorkflow(content, filename);
    expect(result.workflow).toBeNull();
    expect(result.error).not.toBeNull();
  });
});
