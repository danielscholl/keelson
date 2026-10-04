// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";

import { addNodeUsage } from "./usage.ts";

describe("addNodeUsage", () => {
  test("a cache count reported as zero survives the sum across attempts", () => {
    const sum = addNodeUsage(
      { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0 },
      { inputTokens: 3, outputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    );
    expect(sum).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  test("a cache count neither attempt reported stays absent", () => {
    const sum = addNodeUsage(
      { inputTokens: 1, outputTokens: 2 },
      { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 5 },
    );
    expect(sum).toEqual({ inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 5 });
    expect(sum).not.toHaveProperty("cacheCreationInputTokens");
  });
});
