// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { formatDuration } from "../src/lib/formatDuration.ts";

describe("formatDuration", () => {
  test("renders nothing for absent or nonsensical input", () => {
    expect(formatDuration()).toBe("");
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
  });

  test("steps from milliseconds to seconds to minutes", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  test("carries a rounded-up remainder into the next unit", () => {
    // Rounding after the unit branch instead of before yields "1m 60s" here…
    expect(formatDuration(119_999)).toBe("2m 0s");
    // …and "60.0s" here.
    expect(formatDuration(59_999)).toBe("1m 0s");
    expect(formatDuration(59_400)).toBe("59.4s");
  });
});
