// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// "Close enough" workflow-name matching for the run paths (chat tool + the
// POST /runs route) so a user need not type the exact name. Strict tiers first
// (exact / case / hyphen-space-normalized — these ARE the name), then a typo
// tier built on the Sørensen–Dice coefficient over character bigrams. Dice is
// symmetric, 0..1, dependency-free, and robust to typos/transpositions in short
// names. A confident typo resolves to a run; weaker guesses surface as
// suggestions so a vague term never auto-starts a (possibly destructive) run.

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

// Dice similarity of two names after normalization. Identical normalized forms
// score 1; strings too short to form a bigram score 0 (the prefix signal in the
// resolver rescues those).
export function diceCoefficient(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return na.length === 0 ? 0 : 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let overlap = 0;
  for (const [bg, count] of ba) {
    const other = bb.get(bg);
    if (other !== undefined) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (na.length - 1 + (nb.length - 1));
}

export type WorkflowResolution =
  | { kind: "match"; name: string }
  | { kind: "suggest"; candidates: string[] }
  | { kind: "none" };

// Anything at/above this similarity is offered as "did you mean"; below it is
// ignored. There is deliberately NO auto-run-on-fuzzy tier: only an exact /
// case / hyphen-normalized hit (the SAME name typed differently) returns a
// match. A genuine typo, partial, or name+args resolves to a suggestion so the
// caller confirms before a possibly-destructive workflow starts — string
// heuristics can't reliably tell "smoketst" (typo) from "preview" (a real word
// one edit from pr-review) or "fix issue #1" (name+args).
const SUGGEST_SCORE = 0.45;
const MAX_SUGGESTIONS = 3;

export function resolveWorkflowName(input: string, names: readonly string[]): WorkflowResolution {
  const raw = input.trim();
  if (raw === "") return { kind: "none" };

  // Auto-run only when the input IS a known name typed loosely.
  if (names.includes(raw)) return { kind: "match", name: raw };
  const ci = names.filter((n) => n.toLowerCase() === raw.toLowerCase());
  if (ci.length === 1) return { kind: "match", name: ci[0]! };
  const target = normalize(raw);
  if (target === "") return { kind: "none" };
  const normExact = names.filter((n) => normalize(n) === target);
  if (normExact.length === 1) return { kind: "match", name: normExact[0]! };
  if (normExact.length > 1) return { kind: "suggest", candidates: [...normExact] };

  // Otherwise rank by similarity (Dice, with a prefix/substring floor so short
  // partials like "fix" still surface) and offer the closest as suggestions.
  const scored = names
    .map((name) => {
      const nn = normalize(name);
      const dice = diceCoefficient(raw, name);
      const affix = nn.startsWith(target) || target.startsWith(nn) || nn.includes(target);
      return { name, score: affix ? Math.max(dice, SUGGEST_SCORE) : dice };
    })
    .filter((c) => c.score >= SUGGEST_SCORE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "none" };
  return { kind: "suggest", candidates: scored.slice(0, MAX_SUGGESTIONS).map((c) => c.name) };
}
