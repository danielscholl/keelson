// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// USD per million tokens, one row per billing dimension of a turn.
export const modelPriceSchema = z
  .object({
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative(),
    cacheWritePerMTok: z.number().nonnegative(),
    // 1-hour cache writes; absent prices them at cacheWritePerMTok.
    cacheWrite1hPerMTok: z.number().nonnegative().optional(),
  })
  .strict();
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const modelPricesSchema = z.record(z.string().min(1), modelPriceSchema);
export type ModelPrices = z.infer<typeof modelPricesSchema>;

// Anthropic bills a 1-hour cache write at twice the base input rate.
function price(
  inputPerMTok: number,
  outputPerMTok: number,
  cacheReadPerMTok: number,
  cacheWritePerMTok: number,
): ModelPrice {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok,
    cacheWritePerMTok,
    cacheWrite1hPerMTok: inputPerMTok * 2,
  };
}

// Anthropic first-party API list prices (platform.claude.com/docs/en/about-claude/pricing).
// Cache write is the 5-minute TTL rate; writes a provider reports as 1-hour
// price at cacheWrite1hPerMTok.
export const BUNDLED_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-fable-5-1": price(10, 50, 0.25, 12.5),
  "claude-fable-5": price(10, 50, 1, 12.5),
  "claude-opus-5-5": price(4, 20, 0.2, 5),
  "claude-opus-5": price(5, 25, 0.5, 6.25),
  "claude-opus-4-8": price(5, 25, 0.5, 6.25),
  "claude-opus-4-7": price(5, 25, 0.5, 6.25),
  "claude-opus-4-6": price(5, 25, 0.5, 6.25),
  "claude-sonnet-5-5": price(2, 10, 0.2, 2.5),
  "claude-sonnet-5": price(2, 10, 0.2, 2.5),
  "claude-sonnet-4-6": price(3, 15, 0.3, 3.75),
  "claude-haiku-4-5": price(1, 5, 0.1, 1.25),
});

// Collapses the spellings one Anthropic model travels under across providers
// (Copilot's dotted `claude-opus-4.8`, Bedrock's `us.anthropic.` prefix, dated
// or `[1m]` suffixes) onto the hyphenated id the bundled table is keyed by.
// Only Claude ids are rewritten: another vendor's `gpt-4.1` and `gpt-4-1` are
// distinct ids and must stay distinct override keys.
export function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.includes("claude")) return trimmed;
  return lower
    .replace(/\[1m\]$/, "")
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, "")
    .replace(/[@-]\d{8}$/, "")
    .replace(/\./g, "-");
}

// Own-property lookup: a gateway model id is arbitrary text, so "constructor"
// or "toString" must miss rather than resolve to an inherited function.
function ownPrice(table: Readonly<Record<string, ModelPrice>>, id: string): ModelPrice | undefined {
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

// Operator overrides win by exact id, then by normalized id; then a provider's
// live catalog price by exact id; then the bundled table. Unknown → undefined,
// never a zero price.
export function resolveModelPrice(
  model: string,
  overrides?: ModelPrices,
  catalog?: ModelPrices,
): ModelPrice | undefined {
  const normalized = normalizeModelId(model);
  if (overrides) {
    const exact = ownPrice(overrides, model);
    if (exact) return exact;
    for (const [id, p] of Object.entries(overrides)) {
      if (normalizeModelId(id) === normalized) return p;
    }
  }
  const live = catalog ? ownPrice(catalog, model) : undefined;
  return live ?? ownPrice(BUNDLED_MODEL_PRICES, normalized);
}

export interface PricedTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  // The part of cacheWriteTokens written to the 1-hour cache.
  cacheWrite1hTokens?: number | null;
}

// Cache columns the provider never reported contribute nothing: the cost of
// what was measured is still true, and null stays "not reported", not zero.
export function estimateCostUsd(tokens: PricedTokenCounts, p: ModelPrice): number {
  const writes = tokens.cacheWriteTokens ?? 0;
  const writes1h = Math.min(tokens.cacheWrite1hTokens ?? 0, writes);
  return (
    (tokens.inputTokens * p.inputPerMTok +
      tokens.outputTokens * p.outputPerMTok +
      (tokens.cacheReadTokens ?? 0) * p.cacheReadPerMTok +
      (writes - writes1h) * p.cacheWritePerMTok +
      writes1h * (p.cacheWrite1hPerMTok ?? p.cacheWritePerMTok)) /
    1_000_000
  );
}

export interface CostByTokenType {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export function costByTokenTypeUsd(tokens: PricedTokenCounts, p: ModelPrice): CostByTokenType {
  const writes = tokens.cacheWriteTokens ?? 0;
  const writes1h = Math.min(tokens.cacheWrite1hTokens ?? 0, writes);
  return {
    input: (tokens.inputTokens * p.inputPerMTok) / 1_000_000,
    cacheRead: ((tokens.cacheReadTokens ?? 0) * p.cacheReadPerMTok) / 1_000_000,
    cacheWrite:
      ((writes - writes1h) * p.cacheWritePerMTok +
        writes1h * (p.cacheWrite1hPerMTok ?? p.cacheWritePerMTok)) /
      1_000_000,
    output: (tokens.outputTokens * p.outputPerMTok) / 1_000_000,
  };
}

// Tokens the model newly processed. Cache writes count: providers that split
// them out report most new prompt tokens there, not in inputTokens.
export function freshTokens(tokens: PricedTokenCounts): number {
  return tokens.inputTokens + (tokens.cacheWriteTokens ?? 0) + tokens.outputTokens;
}

// Share of all prompt tokens (fresh, cache read, cache write) served from
// cache. Null when cache reads were never reported or nothing was read at all,
// so a provider that doesn't report cache can't show as 0% hit.
export function cacheHitRatio(
  inputTokens: number,
  cacheReadTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined,
): number | null {
  if (cacheReadTokens === null || cacheReadTokens === undefined) return null;
  const denominator = inputTokens + cacheReadTokens + (cacheWriteTokens ?? 0);
  return denominator > 0 ? cacheReadTokens / denominator : null;
}
