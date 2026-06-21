// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ModelCostHint, ModelInfo } from "@keelson/shared";

// Upper bound on the model-tier probe so a slow provider can't stall turn
// admission once budgets are enabled. On timeout the gate sees an unknown model
// (fail-closed → treated as expensive), the same as a throwing probe.
const LIST_MODELS_TIMEOUT_MS = 3000;

// Reduce a model id to the cost signal the request-phase budget gate reads.
// Best-effort: a listModels probe that throws, times out, or omits the id yields
// undefined, which the gate treats as an expensive (fail-closed) model. Callers
// gate this behind PolicyEngine.requestPhaseActive so the listModels cost (cached
// by most providers) is paid only under an enabled budget.
export async function resolveModelCostHint(
  provider: { listModels(): Promise<ModelInfo[]> },
  modelId: string | undefined,
): Promise<ModelCostHint | undefined> {
  if (modelId === undefined) return undefined;
  try {
    const models = await withTimeout(provider.listModels(), LIST_MODELS_TIMEOUT_MS);
    if (models === undefined) return undefined;
    const match = models.find((m) => m.id === modelId);
    if (!match) return undefined;
    return {
      ...(match.costTier !== undefined ? { costTier: match.costTier } : {}),
      ...(match.billing !== undefined ? { billing: match.billing } : {}),
    };
  } catch {
    return undefined;
  }
}

// Resolve to undefined if `p` doesn't settle within `ms`. The pending probe is
// abandoned; a late rejection is swallowed so it isn't unhandled after the
// timeout has already won the race.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
