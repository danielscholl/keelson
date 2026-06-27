// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { renderHuman } from "../src/output.ts";

describe("renderHuman", () => {
  test("renders scalars and flat objects inline", () => {
    expect(renderHuman("hi")).toBe("hi");
    expect(renderHuman(42)).toBe("42");
    expect(renderHuman({ name: "@keelson/cli", version: "0.21.0" })).toBe(
      "name: @keelson/cli\nversion: 0.21.0",
    );
  });

  test("keeps scalar array items inline after the dash", () => {
    expect(renderHuman(["a", "b"])).toBe("- a\n- b");
  });

  test("aligns an array of objects under the dash (no skewed indent)", () => {
    const out = renderHuman([{ id: "chamber", version: "0.10.1" }]);
    expect(out).toBe("- id: chamber\n  version: 0.10.1");
    // The old formatter prefixed the dash before the child indent, producing
    // `-   id:` and leaving later keys un-aligned; guard against the regression.
    expect(out).not.toContain("-   ");
  });

  test("indents nested arrays of objects as proper YAML", () => {
    const data = {
      categories: [{ category: "toolchain", checks: [{ name: "bun --version", status: "ok" }] }],
    };
    expect(renderHuman(data)).toBe(
      [
        "categories:",
        "  - category: toolchain",
        "    checks:",
        "      - name: bun --version",
        "        status: ok",
      ].join("\n"),
    );
  });
});
