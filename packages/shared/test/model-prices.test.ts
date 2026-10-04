// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
  BUNDLED_MODEL_PRICES,
  cacheHitRatio,
  estimateCostUsd,
  freshTokens,
  modelPriceSchema,
  normalizeModelId,
  resolveModelPrice,
} from "../src/model-prices.ts";

describe("normalizeModelId", () => {
  test("collapses dotted, prefixed, dated, and [1m] spellings onto the hyphenated id", () => {
    expect(normalizeModelId("claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(normalizeModelId("Claude-Sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModelId("us.anthropic.claude-opus-4-8-20260101")).toBe("claude-opus-4-8");
    expect(normalizeModelId("claude-sonnet-5@20260101")).toBe("claude-sonnet-5");
    expect(normalizeModelId("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
  });

  test("leaves another vendor's ids exact so distinct override keys stay distinct", () => {
    expect(normalizeModelId("gpt-4.1")).toBe("gpt-4.1");
    expect(normalizeModelId("gpt-4-1")).toBe("gpt-4-1");
    expect(normalizeModelId("GPT-5.5-20260101")).toBe("GPT-5.5-20260101");
  });
});

describe("resolveModelPrice", () => {
  test("resolves every bundled Claude catalog id and its dotted Copilot alias", () => {
    for (const id of ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(resolveModelPrice(id)).toEqual(BUNDLED_MODEL_PRICES[id]);
      expect(resolveModelPrice(id.replace(/-(\d)-(\d)$/, "-$1.$2"))).toEqual(
        BUNDLED_MODEL_PRICES[id],
      );
    }
    expect(resolveModelPrice("claude-opus-4.8")).toEqual(BUNDLED_MODEL_PRICES["claude-opus-4-8"]);
  });

  test("unknown model is undefined, never a zero price", () => {
    expect(resolveModelPrice("gpt-5")).toBeUndefined();
    expect(resolveModelPrice("constructor")).toBeUndefined();
    expect(
      resolveModelPrice("toString", { "gpt-5": BUNDLED_MODEL_PRICES["claude-haiku-4-5"]! }),
    ).toBeUndefined();
    expect(resolveModelPrice("constructor", {})).toBeUndefined();
    expect(resolveModelPrice("auto")).toBeUndefined();
    expect(resolveModelPrice("claude-opus")).toBeUndefined();
  });

  test("operator overrides win by exact id, then by normalized id, over the bundled table", () => {
    const custom = {
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    };
    expect(resolveModelPrice("gpt-5", { "gpt-5": custom })).toEqual(custom);
    expect(resolveModelPrice("claude-opus-4-8", { "claude-opus-4.8": custom })).toEqual(custom);
    expect(resolveModelPrice("claude-opus-4.8", { "claude-opus-4-8": custom })).toEqual(custom);
    expect(resolveModelPrice("claude-opus-4-8", { "gpt-5": custom })).toEqual(
      BUNDLED_MODEL_PRICES["claude-opus-4-8"],
    );
  });
  test("a live catalog price sits between operator overrides and the bundled table", () => {
    const override = {
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    };
    const live = {
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      cacheReadPerMTok: 0.07,
      cacheWritePerMTok: 0,
    };
    expect(resolveModelPrice("gemini-3.8-flash", undefined, { "gemini-3.8-flash": live })).toEqual(
      live,
    );
    expect(
      resolveModelPrice(
        "gemini-3.8-flash",
        { "gemini-3.8-flash": override },
        {
          "gemini-3.8-flash": live,
        },
      ),
    ).toEqual(override);
    expect(resolveModelPrice("claude-opus-4.8", undefined, { "claude-opus-4.8": live })).toEqual(
      live,
    );
    // Catalog keys match exactly: a dotted Copilot key never prices the hyphenated API id.
    expect(resolveModelPrice("claude-opus-4-8", undefined, { "claude-opus-4.8": live })).toEqual(
      BUNDLED_MODEL_PRICES["claude-opus-4-8"],
    );
    expect(resolveModelPrice("constructor", undefined, {})).toBeUndefined();
  });
});

describe("estimateCostUsd", () => {
  test("prices each dimension per million tokens", () => {
    const p = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 };
    expect(
      estimateCostUsd(
        { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 },
        p,
      ),
    ).toBeCloseTo(0.00765, 10);
  });

  test("unreported cache columns contribute nothing", () => {
    const p = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 };
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 500 }, p)).toBeCloseTo(0.007, 10);
    expect(
      estimateCostUsd(
        { inputTokens: 1000, outputTokens: 500, cacheReadTokens: null, cacheWriteTokens: null },
        p,
      ),
    ).toBeCloseTo(0.007, 10);
  });
});

describe("cacheHitRatio", () => {
  test("is cacheRead over input plus cacheRead plus cacheWrite", () => {
    expect(cacheHitRatio(100, 300, null)).toBeCloseTo(0.75, 10);
    expect(cacheHitRatio(10, 300, 690)).toBeCloseTo(0.3, 10);
  });

  test("is null when cache reads were not reported or nothing was read", () => {
    expect(cacheHitRatio(100, null, 500)).toBeNull();
    expect(cacheHitRatio(100, undefined, undefined)).toBeNull();
    expect(cacheHitRatio(0, 0, 0)).toBeNull();
    expect(cacheHitRatio(100, 0, 0)).toBe(0);
  });
});

describe("freshTokens", () => {
  test("counts input, cache writes, and output but not cache reads", () => {
    expect(
      freshTokens({
        inputTokens: 12,
        outputTokens: 300,
        cacheReadTokens: 90_000,
        cacheWriteTokens: 115_000,
      }),
    ).toBe(115_312);
  });

  test("treats unreported cache writes as nothing written", () => {
    expect(freshTokens({ inputTokens: 1000, outputTokens: 50, cacheWriteTokens: null })).toBe(1050);
    expect(freshTokens({ inputTokens: 1000, outputTokens: 50 })).toBe(1050);
  });
});

describe("modelPriceSchema", () => {
  test("rejects negative rates and unknown keys", () => {
    expect(
      modelPriceSchema.safeParse({
        inputPerMTok: -1,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1,
      }).success,
    ).toBe(false);
    expect(
      modelPriceSchema.safeParse({
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1,
        perRequest: 0.01,
      }).success,
    ).toBe(false);
  });
});
