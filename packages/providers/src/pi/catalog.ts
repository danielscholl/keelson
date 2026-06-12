// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelInfo } from "../types.ts";

// Injectable seam for the dynamic pi model catalog. Production wires
// realPiCatalogSource (lazy pi SDK + auth read); tests pass a fake so they
// never touch the real ~/.pi/agent/auth.json or vendor env keys.
export type PiCatalogSource = () => Promise<ModelInfo[]>;

// pi reports cost.output in USD per 1M output tokens (Opus 25, Sonnet 15,
// Haiku 4, GPT-4 60, Gemini Flash ~0.4–2.5). Bucket into the picker's tiers.
export function costTierFromOutput(outputPerMillion: number): NonNullable<ModelInfo["costTier"]> {
  if (!(outputPerMillion > 0)) return "free";
  if (outputPerMillion <= 5) return "low";
  if (outputPerMillion <= 20) return "mid";
  return "high";
}

// Minimal structural slices of the pi SDK this module reads. Declared locally
// so the mapping is decoupled from pi's heavily-generic public types and so
// buildPiCatalog stays unit-testable with plain fakes.
interface PiModelLike {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  cost: { output: number };
}
interface PiAuthCredentialLike {
  type: "oauth" | "api_key";
}
export interface PiAuthStorageLike {
  // Stored auth.json credential for a vendor, if any (undefined when the vendor
  // is only reachable via an env key).
  get(provider: string): PiAuthCredentialLike | undefined;
}
export interface PiAiLike {
  getProviders(): readonly string[];
  getModels(provider: string): readonly PiModelLike[];
  // Resolved env API key for a vendor, or undefined. Never returns a key for
  // vendors that require an OAuth token (e.g. github-copilot).
  getEnvApiKey(provider: string): string | undefined;
}

// Map every authenticated vendor's models to ModelInfo, tagging the real
// billing route. A vendor is authenticated when it has a stored credential or
// a resolvable env key — unauthenticated vendors are hidden so the picker only
// offers models the user can actually run. billing: a stored OAuth login is a
// flat-rate subscription; everything else (stored api_key or an env key) is a
// metered per-token key. (A vendor authenticated via an env *OAuth* token —
// rare — is reported metered; refine if that case ever matters.)
export function buildPiCatalog(piai: PiAiLike, auth: PiAuthStorageLike): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const vendor of piai.getProviders()) {
    // One bad vendor — a throwing auth.get / getEnvApiKey / getModels — skips
    // only itself, not the whole catalog; every vendor that resolves cleanly
    // still reaches the picker.
    try {
      const stored = auth.get(vendor);
      const envKey = piai.getEnvApiKey(vendor);
      if (!stored && !envKey) continue;
      const billing: NonNullable<ModelInfo["billing"]> =
        stored?.type === "oauth" ? "subscription" : "metered";
      for (const m of piai.getModels(vendor)) {
        const vision = Array.isArray(m.input) && m.input.includes("image");
        out.push({
          id: `${vendor}/${m.id}`,
          displayName: m.name,
          costTier: costTierFromOutput(m.cost?.output ?? 0),
          billing,
          supports: { thinking: Boolean(m.reasoning), ...(vision ? { vision: true } : {}) },
        });
      }
    } catch {
      // skip this vendor; keep the rest of the catalog
    }
  }
  return out;
}

// Production source: lazy-import the pi SDK + read ~/.pi/agent/auth.json. Throws
// when the pi packages aren't resolvable (the repo-root + some CI cases) — the
// caller catches and falls back to the curated baseline. Kept lazy so a missing
// pi install never breaks unrelated provider work.
export const realPiCatalogSource: PiCatalogSource = async () => {
  const piai = await import("@earendil-works/pi-ai");
  const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
  const auth = AuthStorage.create();
  return buildPiCatalog(piai as unknown as PiAiLike, auth as unknown as PiAuthStorageLike);
};
