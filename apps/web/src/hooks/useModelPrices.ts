// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelPrices } from "@keelson/shared";
import { useEffect, useState } from "react";
import { fetchConfig } from "../api.ts";

// One fetch per page load: the table only changes with config.json, which
// means a server restart or an operator edit, not something a tab tracks live.
let pricesPromise: Promise<ModelPrices> | null = null;

function loadModelPrices(): Promise<ModelPrices> {
  if (!pricesPromise) {
    pricesPromise = fetchConfig()
      .then((config) => config.modelPrices)
      .catch(() => {
        pricesPromise = null;
        return {};
      });
  }
  return pricesPromise;
}

// Empty until the server answers, so a turn reads as unpriced rather than
// priced at nothing while the request is in flight.
export function useModelPrices(): ModelPrices {
  const [prices, setPrices] = useState<ModelPrices>({});
  useEffect(() => {
    let cancelled = false;
    void loadModelPrices().then((table) => {
      if (!cancelled) setPrices(table);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return prices;
}
