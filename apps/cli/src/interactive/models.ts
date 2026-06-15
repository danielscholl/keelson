// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelInfo } from "@keelson/shared";

export interface ModelCompletion {
  value: string;
  label: string;
  description?: string;
}

// A human hint for the picker — the provider's friendly name and/or cost tier
// when it supplies them. Bare ids (stub, the signed-out fallback, the synthetic
// default) get none.
export function modelHint(model: ModelInfo): string | undefined {
  const parts = [model.displayName, model.costTier].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// Picker candidates from a model list. `ensureId`, when given and missing from
// the list, is prepended: it carries the provider's synthetic default (Copilot's
// "auto") that the live SDK list omits but which must stay selectable.
export function toModelCompletions(
  models: readonly ModelInfo[],
  prefix: string,
  ensureId?: string,
): ModelCompletion[] {
  const present = ensureId !== undefined && models.some((m) => m.id === ensureId);
  const candidates: readonly ModelInfo[] =
    ensureId !== undefined && !present ? [{ id: ensureId }, ...models] : models;
  return candidates
    .filter((m) => m.id.startsWith(prefix))
    .map((m) => {
      const description = modelHint(m);
      return { value: m.id, label: m.id, ...(description !== undefined ? { description } : {}) };
    });
}

export interface ModelLoaderDeps {
  // The live probe (the server's GET /api/providers/:id/models, which itself
  // degrades to the provider's curated list when the SDK probe fails).
  fetch: (providerId: string) => Promise<readonly ModelInfo[]>;
  // The static capabilities.models already in hand — used when the probe errors
  // or returns nothing, so the picker is never empty.
  fallback: (providerId: string) => readonly string[];
}

// Per-provider, session-lived, coalesced model cache. Mirrors run.ts's project
// and workflow caches. A failed or empty probe is not cached, so the next open
// retries the live list rather than being stuck on the fallback.
export function createModelLoader(
  deps: ModelLoaderDeps,
): (providerId: string) => Promise<ModelInfo[]> {
  const cache = new Map<string, Promise<ModelInfo[]>>();
  return (providerId) => {
    const hit = cache.get(providerId);
    if (hit) return hit;
    const pending = (async (): Promise<ModelInfo[]> => {
      try {
        const live = await deps.fetch(providerId);
        if (live.length > 0) return [...live];
      } catch {
        // Fall through to the static fallback below.
      }
      cache.delete(providerId);
      return deps.fallback(providerId).map((id) => ({ id }));
    })();
    cache.set(providerId, pending);
    return pending;
  };
}
