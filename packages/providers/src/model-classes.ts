// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ModelClassMap, ModelInfo } from "@keelson/shared";

export type { ModelClassMap } from "@keelson/shared";

const COST_TIER_RANK = {
  free: 0,
  low: 1,
  mid: 2,
  high: 3,
} as const;

export function deriveModelClasses(
  catalog: readonly ModelInfo[],
  defaultModel: string,
): ModelClassMap | undefined {
  const [firstModel] = catalog;
  if (firstModel === undefined) return undefined;
  if (catalog.length === 1) {
    const id = firstModel.id;
    return { fast: id, balanced: id, deep: id };
  }

  const ranked = catalog.map((model, index) => ({
    model,
    rank:
      model.costTier === undefined
        ? 3 - (index * 3) / (catalog.length - 1)
        : COST_TIER_RANK[model.costTier],
  }));
  const maxRank = Math.max(...ranked.map(({ rank }) => rank));
  const minRank = Math.min(...ranked.map(({ rank }) => rank));
  const sortedRanks = ranked.map(({ rank }) => rank).sort((a, b) => b - a);
  const middle = Math.floor(sortedRanks.length / 2);
  const leftMiddleRank = sortedRanks[middle - 1] ?? sortedRanks[0] ?? 0;
  const rightMiddleRank = sortedRanks[middle] ?? leftMiddleRank;
  const medianRank =
    sortedRanks.length % 2 === 0 ? (leftMiddleRank + rightMiddleRank) / 2 : rightMiddleRank;

  const deep = ranked.find(({ rank }) => rank === maxRank)?.model ?? firstModel;
  const fast = ranked.find(({ rank }) => rank === minRank)?.model ?? catalog.at(-1) ?? firstModel;
  const balanced =
    catalog.find(({ id }) => id === defaultModel) ??
    ranked.find(({ rank }) => rank === medianRank)?.model ??
    catalog[Math.floor(catalog.length / 2)] ??
    firstModel;

  return {
    fast: fast.id,
    balanced: balanced.id,
    deep: deep.id,
  };
}
