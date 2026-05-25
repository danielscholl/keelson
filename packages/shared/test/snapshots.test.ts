// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import { snapshotFrameSchema } from "../src/snapshots.ts";

describe("snapshotFrameSchema", () => {
  it("round-trips a minimal fixture", () => {
    const fixture = {
      type: "snapshot_update" as const,
      key: "osdu",
      version: 0,
      composedAt: "2026-01-01T00:00:00.000Z",
      data: { partitions: [] },
    };
    const result = snapshotFrameSchema.parse(fixture);
    expect(result.type).toBe("snapshot_update");
    expect(result.key).toBe("osdu");
    expect(result.version).toBe(0);
  });

  it("accepts arbitrary `data` payloads (unknown)", () => {
    const result = snapshotFrameSchema.parse({
      type: "snapshot_update",
      key: "k",
      version: 7,
      composedAt: "2026-05-25T19:51:26.000Z",
      data: ["a", 1, { nested: true }, null],
    });
    expect(result.data).toEqual(["a", 1, { nested: true }, null]);
  });

  it("rejects empty key", () => {
    expect(() =>
      snapshotFrameSchema.parse({
        type: "snapshot_update",
        key: "",
        version: 1,
        composedAt: "2026-01-01T00:00:00.000Z",
        data: {},
      }),
    ).toThrow();
  });

  it("rejects negative version", () => {
    expect(() =>
      snapshotFrameSchema.parse({
        type: "snapshot_update",
        key: "k",
        version: -1,
        composedAt: "2026-01-01T00:00:00.000Z",
        data: {},
      }),
    ).toThrow();
  });

  it("rejects non-integer version", () => {
    expect(() =>
      snapshotFrameSchema.parse({
        type: "snapshot_update",
        key: "k",
        version: 1.5,
        composedAt: "2026-01-01T00:00:00.000Z",
        data: {},
      }),
    ).toThrow();
  });

  it("rejects malformed composedAt", () => {
    expect(() =>
      snapshotFrameSchema.parse({
        type: "snapshot_update",
        key: "k",
        version: 1,
        composedAt: "not-a-date",
        data: {},
      }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      snapshotFrameSchema.parse({
        type: "snapshot_update",
        key: "k",
        version: 1,
        composedAt: "2026-01-01T00:00:00.000Z",
        data: {},
        extra: "nope",
      }),
    ).toThrow();
  });

  it("rejects wrong `type` discriminator", () => {
    expect(() =>
      snapshotFrameSchema.parse({
        type: "snapshot_invalidated",
        key: "k",
        version: 1,
        composedAt: "2026-01-01T00:00:00.000Z",
        data: {},
      }),
    ).toThrow();
  });
});
