// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { tokenUsageHasSpend } from "@keelson/shared";

// Compact token-count formatting for usage chips and trace rows:
// 842 → "842", 1 234 → "1.2k", 42 000 → "42k", 1 250 000 → "1.3M".
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) {
    const k = n / 1000;
    return k < 10 ? `${k.toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(m)}M`;
}

// Context-fill percentage, clamped to [0, 100]. Returns null when either
// side is missing — callers render nothing rather than a fake 0%.
export function contextPercent(
  contextTokens: number | undefined,
  contextWindow: number | undefined,
): number | null {
  if (contextTokens === undefined || contextWindow === undefined || contextWindow <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));
}

// Shared color thresholds: amber at 70%, red at 85% (the cross-harness
// convention — Cline, Goose, and Claude Code statuslines all cluster here).
export function contextFillLevel(pct: number): "ok" | "warn" | "hot" {
  if (pct >= 85) return "hot";
  if (pct >= 70) return "warn";
  return "ok";
}

// The ↑/↓ display gate. Context-only reporters (Copilot session.usage_info
// without assistant.usage) carry real context fields with zero in/out totals;
// rendering "↑ 0 ↓ 0" for those would present a fabricated measurement.
export function hasSpend(usage: { inputTokens: number; outputTokens: number }): boolean {
  return usage.inputTokens + usage.outputTokens > 0;
}

// Run-level rollup: sum spend across every reporting node. Returns null when
// nothing was billed (cache reads and writes count) so the caller renders
// nothing rather than a fabricated "0".
export interface TokenSpend {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// Cache counts stay absent unless some node reported them, so "not reported"
// never reads as a measured zero.
export function sumTokenSpend(usages: Iterable<TokenSpend | undefined | null>): TokenSpend | null {
  const total: TokenSpend = { inputTokens: 0, outputTokens: 0 };
  for (const u of usages) {
    if (!u) continue;
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    if (u.cacheReadInputTokens !== undefined) {
      total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + u.cacheReadInputTokens;
    }
    if (u.cacheCreationInputTokens !== undefined) {
      total.cacheCreationInputTokens =
        (total.cacheCreationInputTokens ?? 0) + u.cacheCreationInputTokens;
    }
  }
  return tokenUsageHasSpend(total) ? total : null;
}

// Ledger cost: four decimals under a dollar ($0.0123) so a single cheap turn
// still reads as a number, two above it. Null is an unpriced model, and the
// word says so rather than a "$0.00" that would look like a free turn; a
// positive cost too small for four decimals shows as a lower bound for the
// same reason.
export function formatCostUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "unpriced";
  if (n > 0 && n < 0.0001) return "<$0.0001";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// Cache hit ratio as a whole percentage; null (no cache reads reported, or
// nothing to divide by) renders as a dash rather than a fabricated 0%.
export function formatCacheHit(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}
