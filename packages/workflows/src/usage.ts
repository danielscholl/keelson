// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { NodeTokenUsage } from "./executor.ts";

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
  const cacheRead = (total.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
  if (cacheRead > 0) out.cacheReadInputTokens = cacheRead;
  const cacheCreation = (total.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
  if (cacheCreation > 0) out.cacheCreationInputTokens = cacheCreation;
  const contextTokens = u.contextTokens ?? total.contextTokens;
  if (contextTokens !== undefined) out.contextTokens = contextTokens;
  const contextWindow = u.contextWindow ?? total.contextWindow;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  return out;
}
