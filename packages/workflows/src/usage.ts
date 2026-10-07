// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { NodeTokenUsage } from "./executor.ts";

// A cache count either side reported survives the sum, even at zero; absent
// means the provider never reported it.
function addReported(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : a + b;
}

// Totals sum across attempts; the context pair tracks the latest one
// (a gauge, not a volume).
export function addNodeUsage(
  total: NodeTokenUsage | undefined,
  u: NodeTokenUsage | undefined,
): NodeTokenUsage | undefined {
  if (u === undefined) return total;
  if (total === undefined) return { ...u };
  const out: NodeTokenUsage = {
    inputTokens: total.inputTokens + u.inputTokens,
    outputTokens: total.outputTokens + u.outputTokens,
  };
  const cacheRead = addReported(total.cacheReadInputTokens, u.cacheReadInputTokens);
  if (cacheRead !== undefined) out.cacheReadInputTokens = cacheRead;
  const cacheCreation = addReported(total.cacheCreationInputTokens, u.cacheCreationInputTokens);
  if (cacheCreation !== undefined) out.cacheCreationInputTokens = cacheCreation;
  const cacheCreation1h = addReported(
    total.cacheCreation1hInputTokens,
    u.cacheCreation1hInputTokens,
  );
  if (cacheCreation1h !== undefined) out.cacheCreation1hInputTokens = cacheCreation1h;
  const contextTokens = u.contextTokens ?? total.contextTokens;
  if (contextTokens !== undefined) out.contextTokens = contextTokens;
  const contextWindow = u.contextWindow ?? total.contextWindow;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  return out;
}
