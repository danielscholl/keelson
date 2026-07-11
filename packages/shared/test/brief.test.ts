// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import { briefSchema } from "../src/brief.ts";

describe("briefSchema", () => {
  it("accepts a minimal brief", () => {
    expect(briefSchema.parse({ criteria: [] })).toEqual({ criteria: [] });
  });

  it("defaults criteria to an empty list", () => {
    expect(briefSchema.parse({})).toEqual({ criteria: [] });
  });

  it("accepts optional sourceUrl and title", () => {
    expect(
      briefSchema.parse({
        sourceUrl: "https://github.com/danielscholl/keelson/issues/1",
        title: "Fix issue workflow",
        criteria: ["Plan approval names uncovered criteria"],
      }),
    ).toEqual({
      sourceUrl: "https://github.com/danielscholl/keelson/issues/1",
      title: "Fix issue workflow",
      criteria: ["Plan approval names uncovered criteria"],
    });
  });

  it("rejects non-string criteria", () => {
    expect(() => briefSchema.parse({ criteria: [123] })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => briefSchema.parse({ criteria: [], extra: true })).toThrow();
  });
});
