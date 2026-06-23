// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { freshCursor, shouldApplyFrame } from "../src/lib/snapshotGuard.ts";

describe("shouldApplyFrame", () => {
  test("accepts the first frame, including version 0", () => {
    const cursor = freshCursor();
    expect(shouldApplyFrame(cursor, 0)).toBe(true);
  });

  test("accepts strictly newer versions and tracks the high-water mark", () => {
    const cursor = freshCursor();
    expect(shouldApplyFrame(cursor, 0)).toBe(true);
    expect(shouldApplyFrame(cursor, 1)).toBe(true);
    expect(shouldApplyFrame(cursor, 5)).toBe(true);
  });

  test("dedupes an equal version once a frame has been applied", () => {
    const cursor = freshCursor();
    shouldApplyFrame(cursor, 3);
    // A reconnect re-hydrate at the same version is a no-op, not a re-render.
    expect(shouldApplyFrame(cursor, 3)).toBe(false);
  });

  test("drops a stale lower version within one registration", () => {
    const cursor = freshCursor();
    shouldApplyFrame(cursor, 5);
    expect(shouldApplyFrame(cursor, 4)).toBe(false);
  });

  test("re-baselines on a version reset (re-registration restarts at 0)", () => {
    const cursor = freshCursor();
    shouldApplyFrame(cursor, 5);
    // The server deletes a key's version on unregister, so a re-registered key
    // restarts at 0 — that lower-but-newer frame must be accepted, then resume.
    expect(shouldApplyFrame(cursor, 0)).toBe(true);
    expect(shouldApplyFrame(cursor, 1)).toBe(true);
    expect(shouldApplyFrame(cursor, 0)).toBe(true);
  });
});
