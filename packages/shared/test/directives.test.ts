// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  DIRECTIVE_NAMES,
  DIRECTIVES,
  directiveNameSchema,
  renderDirectives,
} from "../src/directives.ts";

describe("DIRECTIVES", () => {
  test("holds exactly the four named directives, frozen", () => {
    expect(Object.keys(DIRECTIVES)).toEqual(["verify", "continue", "confirm", "review"]);
    expect(Object.isFrozen(DIRECTIVES)).toBe(true);
    for (const text of Object.values(DIRECTIVES)) {
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("\n");
    }
  });

  test("directiveNameSchema accepts exactly the record's keys", () => {
    expect([...directiveNameSchema.options]).toEqual([...DIRECTIVE_NAMES]);
    expect(directiveNameSchema.safeParse("verify").success).toBe(true);
    expect(directiveNameSchema.safeParse("nope").success).toBe(false);
  });

  test("renderDirectives joins the selected texts with blank lines, in order", () => {
    expect(renderDirectives(["confirm", "verify"])).toBe(
      `${DIRECTIVES.confirm}\n\n${DIRECTIVES.verify}`,
    );
    expect(renderDirectives([])).toBe("");
  });
});
