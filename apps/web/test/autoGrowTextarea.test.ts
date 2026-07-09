// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, test } from "bun:test";
import {
  CHAT_INPUT_MAX_HEIGHT,
  CHAT_INPUT_MIN_HEIGHT,
  clampTextareaHeight,
} from "../src/lib/autoGrowTextarea.ts";

describe("clampTextareaHeight", () => {
  test("floors content shorter than the minimum", () => {
    expect(clampTextareaHeight(10)).toBe(CHAT_INPUT_MIN_HEIGHT);
    expect(clampTextareaHeight(0)).toBe(CHAT_INPUT_MIN_HEIGHT);
  });

  test("passes content through when between the bounds", () => {
    expect(clampTextareaHeight(120)).toBe(120);
  });

  test("caps content taller than the maximum", () => {
    expect(clampTextareaHeight(999)).toBe(CHAT_INPUT_MAX_HEIGHT);
  });

  test("honors custom min/max overrides", () => {
    expect(clampTextareaHeight(10, 20, 200)).toBe(20);
    expect(clampTextareaHeight(500, 20, 200)).toBe(200);
    expect(clampTextareaHeight(80, 20, 200)).toBe(80);
  });
});
