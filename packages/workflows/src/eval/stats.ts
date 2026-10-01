// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

export interface WilsonInterval {
  readonly low: number;
  readonly high: number;
}

const Z_95 = 1.959964;

// Wilson score interval: unlike the normal approximation it stays inside
// [0, 1] and does not collapse to zero width at 0/n or n/n.
export function wilsonInterval(successes: number, trials: number, z = Z_95): WilsonInterval | null {
  if (!Number.isFinite(trials) || trials <= 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  // The edges are exact by construction; clamp so 0/n and n/n never show
  // float dust like 0.9999999999999999.
  return {
    low: successes <= 0 ? 0 : Math.max(0, center - half),
    high: successes >= trials ? 1 : Math.min(1, center + half),
  };
}

export function intervalsOverlap(a: WilsonInterval, b: WilsonInterval): boolean {
  return a.low <= b.high && b.low <= a.high;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

// Nearest-rank percentile (R type 1): p95 of ten values is the tenth-largest,
// never an interpolated number no sample actually took.
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}
