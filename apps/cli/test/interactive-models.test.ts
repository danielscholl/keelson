// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@keelson/shared";
import { createModelLoader, modelHint, toModelCompletions } from "../src/interactive/models.ts";

describe("modelHint", () => {
  test("joins display name and cost tier", () => {
    expect(modelHint({ id: "gpt-5", displayName: "GPT-5", costTier: "high" })).toBe("GPT-5 · high");
  });

  test("uses whichever field is present", () => {
    expect(modelHint({ id: "x", displayName: "X" })).toBe("X");
    expect(modelHint({ id: "x", costTier: "low" })).toBe("low");
  });

  test("returns undefined for a bare id", () => {
    expect(modelHint({ id: "auto" })).toBeUndefined();
  });
});

describe("toModelCompletions", () => {
  const models: ModelInfo[] = [
    { id: "gpt-5", displayName: "GPT-5", costTier: "high" },
    { id: "gpt-4o" },
  ];

  test("maps ids to value/label with an optional description", () => {
    expect(toModelCompletions(models, "")).toEqual([
      { value: "gpt-5", label: "gpt-5", description: "GPT-5 · high" },
      { value: "gpt-4o", label: "gpt-4o" },
    ]);
  });

  test("filters by prefix", () => {
    expect(toModelCompletions(models, "gpt-4").map((c) => c.value)).toEqual(["gpt-4o"]);
  });

  test("prepends the ensured default when the live list omits it", () => {
    const out = toModelCompletions(models, "", "auto");
    expect(out[0]).toEqual({ value: "auto", label: "auto" });
    expect(out).toHaveLength(3);
  });

  test("does not duplicate the default when it is already present", () => {
    const withAuto: ModelInfo[] = [{ id: "auto" }, ...models];
    expect(toModelCompletions(withAuto, "", "auto").filter((c) => c.value === "auto")).toHaveLength(
      1,
    );
  });
});

describe("createModelLoader", () => {
  test("returns the live list and caches it across coalesced calls", async () => {
    let calls = 0;
    const load = createModelLoader({
      fetch: async () => {
        calls += 1;
        return [{ id: "gpt-5" }];
      },
      fallback: () => ["auto"],
    });
    const [a, b] = await Promise.all([load("copilot"), load("copilot")]);
    expect(a).toEqual([{ id: "gpt-5" }]);
    expect(b).toEqual([{ id: "gpt-5" }]);
    await load("copilot");
    expect(calls).toBe(1);
  });

  test("falls back to static ids on probe failure and retries next time", async () => {
    let calls = 0;
    const load = createModelLoader({
      fetch: async () => {
        calls += 1;
        throw new Error("signed out");
      },
      fallback: () => ["auto", "gpt-5"],
    });
    expect(await load("copilot")).toEqual([{ id: "auto" }, { id: "gpt-5" }]);
    await load("copilot");
    expect(calls).toBe(2);
  });

  test("treats an empty live list as a miss and uses the fallback", async () => {
    const load = createModelLoader({
      fetch: async () => [],
      fallback: () => ["auto"],
    });
    expect(await load("copilot")).toEqual([{ id: "auto" }]);
  });
});
