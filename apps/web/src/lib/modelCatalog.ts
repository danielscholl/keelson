// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelInfo, ProviderInfo } from "@keelson/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchProviderModels, fetchProviders } from "../api.ts";

// The provider/model catalog every model picker walks: providers in registry
// order, each with its live model list (falling back to the provider's curated
// capabilities baseline when the per-provider fetch fails).
export interface ModelCatalog {
  providers: ProviderInfo[];
  modelsByProvider: Record<string, ModelInfo[]>;
}

// Multi-vendor providers (pi) prefix model ids as "vendor/model". Pickers
// sub-group by that prefix so a 200-model authenticated catalog stays
// scannable; single-vendor providers (Copilot/Claude) have no "/" and render
// flat with no sub-header.
export function vendorOf(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : null;
}

const VENDOR_LABELS: Record<string, string> = {
  "github-copilot": "GitHub Copilot",
  openai: "OpenAI",
  xai: "xAI",
  deepseek: "DeepSeek",
  "google-vertex": "Google Vertex",
  openrouter: "OpenRouter",
};

export function prettyVendor(vendor: string): string {
  return (
    VENDOR_LABELS[vendor] ??
    vendor
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export interface VendorGroup {
  vendor: string | null;
  models: ModelInfo[];
}

// Group only CONSECUTIVE runs of the same vendor, preserving the incoming
// (canonical) model order. The catalog already arrives vendor-grouped, so each
// vendor normally yields one run; keeping it order-preserving means the rendered
// order always matches the keyboard/Enter-select order derived from the same
// list, and an interleaved catalog shows a vendor's sub-header per run rather
// than silently reordering rows.
export function groupByVendor(models: ModelInfo[]): VendorGroup[] {
  const groups: VendorGroup[] = [];
  for (const m of models) {
    const vendor = vendorOf(m.id);
    const last = groups[groups.length - 1];
    if (last && last.vendor === vendor) {
      last.models.push(m);
      continue;
    }
    groups.push({ vendor, models: [m] });
  }
  return groups;
}

export const COST_LABEL: Record<NonNullable<ModelInfo["costTier"]>, string> = {
  free: "free",
  low: "$",
  mid: "$$",
  high: "$$$",
};

// One shared in-flight promise so a board with many picker fields (e.g. one per
// roster card) fetches the catalog once, not once per field. A failed load
// clears the cache so a later mount retries instead of pinning the failure.
let catalogPromise: Promise<ModelCatalog> | null = null;

interface CatalogFetchers {
  fetchProviders: typeof fetchProviders;
  fetchProviderModels: typeof fetchProviderModels;
}
let fetchers: CatalogFetchers = { fetchProviders, fetchProviderModels };

// Test seam: swap the fetchers and drop the cache, so picker suites stay
// hermetic under bun's process-global module registry (other suites
// mock.module api.ts, which would otherwise poison this loader); call with no
// argument to restore the real api fetchers.
export function configureModelCatalog(next?: CatalogFetchers): void {
  fetchers = next ?? { fetchProviders, fetchProviderModels };
  catalogPromise = null;
}

function loadCatalog(): Promise<ModelCatalog> {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const { providers } = await fetchers.fetchProviders();
    const modelsByProvider: Record<string, ModelInfo[]> = {};
    await Promise.all(
      providers.map(async (p) => {
        try {
          modelsByProvider[p.id] = await fetchers.fetchProviderModels(p.id);
        } catch {
          modelsByProvider[p.id] = (p.capabilities.models ?? []).map((id) => ({ id }));
        }
      }),
    );
    return { providers, modelsByProvider };
  })();
  catalogPromise.catch(() => {
    catalogPromise = null;
  });
  return catalogPromise;
}

export interface ModelCatalogState {
  catalog: ModelCatalog | null;
  // True after a load failed and nothing has succeeded since — lets a picker
  // say "couldn't load" instead of an eternal "loading". `reload` clears it
  // and retries (the failed promise is already evicted from the cache), so a
  // popover can re-attempt on each open after a transient API failure.
  failed: boolean;
  reload: () => void;
}

export function useModelCatalog(): ModelCatalogState {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setFailed(false);
    loadCatalog().then(
      (c) => setCatalog(c),
      () => setFailed(true),
    );
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadCatalog().then(
      (c) => {
        if (!cancelled) setCatalog(c);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return { catalog, failed, reload };
}
