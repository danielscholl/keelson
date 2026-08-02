import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "@keelson/shared";
import { deriveModelClasses } from "../src/index.ts";

describe("deriveModelClasses", () => {
  const catalog: readonly ModelInfo[] = [
    { id: "deep-model", costTier: "high" },
    { id: "balanced-model", costTier: "mid" },
    { id: "fast-model", costTier: "low" },
  ];

  it("derives cost-ranked classes and uses an in-catalog default", () => {
    expect(deriveModelClasses(catalog, "balanced-model")).toEqual({
      fast: "fast-model",
      balanced: "balanced-model",
      deep: "deep-model",
    });
  });

  it("uses the median-ranked model when the default is outside the catalog", () => {
    expect(deriveModelClasses(catalog, "")).toEqual({
      fast: "fast-model",
      balanced: "balanced-model",
      deep: "deep-model",
    });
  });

  it("uses catalog order for models without cost tiers", () => {
    expect(deriveModelClasses([{ id: "first" }, { id: "middle" }, { id: "last" }], "")).toEqual({
      fast: "last",
      balanced: "middle",
      deep: "first",
    });
  });

  it("uses catalog order to break equal-tier ties", () => {
    expect(
      deriveModelClasses(
        [
          { id: "first-high", costTier: "high" },
          { id: "second-high", costTier: "high" },
          { id: "low", costTier: "low" },
        ],
        "",
      ),
    ).toEqual({
      fast: "low",
      balanced: "first-high",
      deep: "first-high",
    });
  });

  it("collapses a single-model catalog", () => {
    expect(deriveModelClasses([{ id: "only-model" }], "")).toEqual({
      fast: "only-model",
      balanced: "only-model",
      deep: "only-model",
    });
  });

  it("returns undefined for an empty catalog", () => {
    expect(deriveModelClasses([], "")).toBeUndefined();
  });
});
