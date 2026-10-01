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

// mulberry32: a tiny deterministic PRNG, so seeded splits and sampled
// permutation tests reproduce across machines without a dependency.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PAIRED_ALPHA = 0.05;
// Smallest count of changed cases whose best two-sided p (2 / 2^n) clears
// PAIRED_ALPHA; below it no difference can be called.
export const PAIRED_MIN_CHANGED = 6;
const EXACT_PERMUTATION_LIMIT = 20;
const SAMPLED_PERMUTATIONS = 100_000;
const SUM_EPSILON = 1e-9;

export interface PairedTest {
  // Cases graded on both sides.
  readonly cases: number;
  // Cases whose pass rate differs between the sides.
  readonly changed: number;
  readonly meanDelta: number;
  readonly pValue: number;
}

// Two-sided sign-flip permutation test on per-case differences. Each case is
// its own control, so only the cases that moved carry evidence; with one rep
// per side this is the exact McNemar test.
export function pairedPermutationTest(deltas: readonly number[]): PairedTest | null {
  if (deltas.length === 0) return null;
  const moved = deltas.filter((d) => Math.abs(d) > SUM_EPSILON);
  let observed = 0;
  for (const d of moved) observed += d;
  const meanDelta = observed / deltas.length;
  const threshold = Math.abs(observed) - SUM_EPSILON;
  if (moved.length === 0) return { cases: deltas.length, changed: 0, meanDelta: 0, pValue: 1 };
  let pValue: number;
  if (moved.length <= EXACT_PERMUTATION_LIMIT) {
    const total = 2 ** moved.length;
    let extreme = 0;
    for (let mask = 0; mask < total; mask++) {
      let sum = 0;
      for (let i = 0; i < moved.length; i++) {
        sum += (mask >>> i) & 1 ? (moved[i] as number) : -(moved[i] as number);
      }
      if (Math.abs(sum) >= threshold) extreme++;
    }
    pValue = extreme / total;
  } else {
    const random = seededRandom(moved.length);
    let extreme = 0;
    for (let n = 0; n < SAMPLED_PERMUTATIONS; n++) {
      let sum = 0;
      for (const d of moved) sum += random() < 0.5 ? d : -d;
      if (Math.abs(sum) >= threshold) extreme++;
    }
    pValue = (extreme + 1) / (SAMPLED_PERMUTATIONS + 1);
  }
  return { cases: deltas.length, changed: moved.length, meanDelta, pValue };
}
