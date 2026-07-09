// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelInfo, ProviderInfo } from "@keelson/shared";
import { useCallback, useEffect, useSyncExternalStore } from "react";
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

interface CatalogFetchers {
  fetchProviders: typeof fetchProviders;
  fetchProviderModels: typeof fetchProviderModels;
}
let fetchers: CatalogFetchers = { fetchProviders, fetchProviderModels };

export interface ModelCatalogState {
  catalog: ModelCatalog | null;
  // True after a load failed and nothing has succeeded since — lets a picker
  // say "couldn't load" instead of an eternal "loading".
  failed: boolean;
}

// Module-level store, not per-component state: every ModelFieldPicker trigger
// AND its nested ModelCatalogPopover call useModelCatalog(), and they must
// observe the identical catalog — otherwise a reload the popover triggers
// (e.g. its Retry button) would recover the popover's own view but leave the
// trigger's separate copy stuck on `catalog: null`, permanently rendering a
// raw model id instead of the catalog's display name. useSyncExternalStore
// makes every subscriber re-render off the one shared snapshot.
let state: ModelCatalogState = { catalog: null, failed: false };
const listeners = new Set<() => void>();

function setState(next: ModelCatalogState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ModelCatalogState {
  return state;
}

// Bumped by configureModelCatalog/reloadModelCatalog so a still-in-flight
// request from a superseded load can't clobber a newer one's results after it
// resolves out of order.
let loadToken = 0;
let started = false;

// Providers publish immediately (each seeded with its curated
// capabilities.models baseline), then each provider's live model list merges
// in independently as its own fetch settles — mirrors Chat.tsx's fan-out
// pattern. A single slow or hung provider therefore only ever holds back its
// own section, never every other provider's.
async function load(): Promise<void> {
  const token = ++loadToken;
  try {
    const { providers } = await fetchers.fetchProviders();
    if (token !== loadToken) return;
    const modelsByProvider: Record<string, ModelInfo[]> = {};
    for (const p of providers) {
      modelsByProvider[p.id] = (p.capabilities.models ?? []).map((id) => ({ id }));
    }
    setState({ catalog: { providers, modelsByProvider }, failed: false });
    await Promise.all(
      providers.map(async (p) => {
        try {
          const models = await fetchers.fetchProviderModels(p.id);
          if (token !== loadToken || !state.catalog) return;
          setState({
            catalog: {
              providers,
              modelsByProvider: { ...state.catalog.modelsByProvider, [p.id]: models },
            },
            failed: false,
          });
        } catch {
          // Non-fatal — that provider's section keeps its curated baseline.
        }
      }),
    );
  } catch {
    if (token !== loadToken) return;
    setState({ catalog: null, failed: true });
  }
}

function ensureLoaded(): void {
  if (started) return;
  started = true;
  void load();
}

// Forces a fresh load regardless of `started` — the popover's Retry button
// and its retry-on-reopen-while-failed path call this.
function reload(): void {
  started = true;
  void load();
}

// Test seam: swap the fetchers and reset the store, so picker suites stay
// hermetic under bun's process-global module registry (other suites
// mock.module api.ts, which would otherwise poison this loader); call with no
// argument to restore the real api fetchers.
export function configureModelCatalog(next?: CatalogFetchers): void {
  fetchers = next ?? { fetchProviders, fetchProviderModels };
  loadToken++;
  started = false;
  setState({ catalog: null, failed: false });
}

export function useModelCatalog(): ModelCatalogState & { reload: () => void } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    ensureLoaded();
  }, []);
  const boundReload = useCallback(() => reload(), []);
  return { ...snapshot, reload: boundReload };
}
