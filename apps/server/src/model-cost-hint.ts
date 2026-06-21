// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ModelCostHint, ModelInfo } from "@keelson/shared";

// Reduce a model id to the cost signal the request-phase budget gate reads.
// Best-effort: a listModels probe that throws or omits the id yields undefined,
// which the gate treats as an expensive (fail-closed) model. Callers gate this
// behind PolicyEngine.requestPhaseActive so the listModels cost (cached by most
// providers) is paid only under an enabled budget.
export async function resolveModelCostHint(
  provider: { listModels(): Promise<ModelInfo[]> },
  modelId: string | undefined,
): Promise<ModelCostHint | undefined> {
  if (modelId === undefined) return undefined;
  try {
    const match = (await provider.listModels()).find((m) => m.id === modelId);
    if (!match) return undefined;
    return {
      ...(match.costTier !== undefined ? { costTier: match.costTier } : {}),
      ...(match.billing !== undefined ? { billing: match.billing } : {}),
    };
  } catch {
    return undefined;
  }
}
