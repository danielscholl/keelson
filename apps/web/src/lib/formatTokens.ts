// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

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
