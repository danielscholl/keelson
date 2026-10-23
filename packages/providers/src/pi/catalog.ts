// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelInfo } from "../types.ts";

// Injectable seam for the dynamic pi model catalog. Production wires
// realPiCatalogSource (lazy pi SDK model runtime); tests pass a fake so they
// never touch the real ~/.pi/agent config or vendor env keys.
export type PiCatalogSource = () => Promise<ModelInfo[]>;

// pi reports cost.output in USD per 1M output tokens (Opus 25, Sonnet 15,
// Haiku 4, GPT-4 60, Gemini Flash ~0.4–2.5). Bucket into the picker's tiers.
export function costTierFromOutput(outputPerMillion: number): NonNullable<ModelInfo["costTier"]> {
  if (!(outputPerMillion > 0)) return "free";
  if (outputPerMillion <= 5) return "low";
  if (outputPerMillion <= 20) return "mid";
  return "high";
}

// Minimal structural slice of a pi Model this module reads. Declared locally
// so the mapping is decoupled from pi's heavily-generic public types and so
// buildPiCatalog stays unit-testable with plain fakes.
export interface PiModelLike {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  cost?: { output: number };
}

// Map every runnable model to ModelInfo, tagging the real billing route.
// `models` is pi's ModelRuntime availability list — built-in plus
// ~/.pi/agent/models.json custom models with auth configured — the same
// runtime the session factory resolves refs against, so a model the picker
// offers is always one a turn can actually run, including local
// OpenAI-compatible servers. billing: an OAuth login is a flat-rate
// subscription; a priced model on a key is metered; an unpriced key-backed
// model (a local server) is left unknown.
export function buildPiCatalog(
  models: readonly PiModelLike[],
  isUsingOAuth: (provider: string) => boolean,
): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of models) {
    // One malformed model skips only itself, not the whole catalog.
    try {
      const output = m.cost?.output ?? 0;
      const billing: ModelInfo["billing"] = isUsingOAuth(m.provider)
        ? "subscription"
        : output > 0
          ? "metered"
          : undefined;
      const vision = Array.isArray(m.input) && m.input.includes("image");
      out.push({
        id: `${m.provider}/${m.id}`,
        displayName: m.name,
        costTier: costTierFromOutput(output),
        ...(billing ? { billing } : {}),
        supports: { thinking: Boolean(m.reasoning), ...(vision ? { vision: true } : {}) },
      });
    } catch {
      // skip this model; keep the rest of the catalog
    }
  }
  return out;
}

// Production source: lazy-import the pi SDK and build its ModelRuntime from
// ~/.pi/agent (auth.json + models.json). Throws when the pi packages aren't
// resolvable (the repo-root + some CI cases) — the caller catches and falls
// back to the curated baseline. Kept lazy so a missing pi install never breaks
// unrelated provider work.
export const realPiCatalogSource: PiCatalogSource = async () => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const runtime = await sdk.ModelRuntime.create();
  const models = await runtime.getAvailable();
  return buildPiCatalog(models as unknown as PiModelLike[], (provider) =>
    runtime.isUsingOAuth(provider),
  );
};
