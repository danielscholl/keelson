// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useCallback, useSyncExternalStore } from "react";

// Versioned so a shape change abandons stale payloads cleanly.
const STORAGE_KEY = "keelson.settings.v1" as const;

export interface ModelRef {
  providerId: string;
  modelId: string;
}

// "system" means follow prefers-color-scheme; the picker shows three states
// but the rendered `data-theme` attribute is always "light" or "dark".
export type ThemePreference = "light" | "dark" | "system";
export type WorkflowsViewMode = "both" | "workflows" | "runs";

export interface Settings {
  // Insertion-order list shown at the top of the picker.
  favorites: ModelRef[];
  // Last provider/model pair sent on; seeds a fresh chat.
  lastUsed: ModelRef | null;
  // Missing = expanded.
  sidebarCollapsed?: boolean;
  // Missing = "system".
  theme?: ThemePreference;
  // Missing = "both".
  workflowsViewMode?: WorkflowsViewMode;
  // Rib ids whose workflows are hidden from the catalog + runs feed. View-only:
  // the rib's producers keep refreshing its surfaces. Missing = none hidden.
  hiddenWorkflowSources?: string[];
  // Show rib-bound background producer workflows in the catalog. Missing = false
  // (they're auto-refresh machinery the operator never runs by hand).
  showBackgroundWorkflows?: boolean;
  // Show scheduled (producer) runs in the runs feed. Missing = false — the feed
  // defaults to manual runs so high-cadence lanes don't bury them.
  showScheduledRuns?: boolean;
}

const DEFAULTS: Settings = { favorites: [], lastUsed: null };

const THEME_VALUES = ["light", "dark", "system"] as const;
function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === "string" && (THEME_VALUES as readonly string[]).includes(v);
}

const WORKFLOWS_VIEW_MODE_VALUES = ["both", "workflows", "runs"] as const;
function isWorkflowsViewMode(v: unknown): v is WorkflowsViewMode {
  return typeof v === "string" && (WORKFLOWS_VIEW_MODE_VALUES as readonly string[]).includes(v);
}

function isModelRef(v: unknown): v is ModelRef {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.providerId === "string" && typeof o.modelId === "string";
}

function isSettings(v: unknown): v is Settings {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.favorites) || !o.favorites.every(isModelRef)) return false;
  if (o.lastUsed !== null && !isModelRef(o.lastUsed)) return false;
  // Reject present-but-wrong-type so a bad payload doesn't flip the rail.
  if (o.sidebarCollapsed !== undefined && typeof o.sidebarCollapsed !== "boolean") {
    return false;
  }
  if (o.theme !== undefined && !isThemePreference(o.theme)) return false;
  if (o.workflowsViewMode !== undefined && !isWorkflowsViewMode(o.workflowsViewMode)) return false;
  if (
    o.hiddenWorkflowSources !== undefined &&
    (!Array.isArray(o.hiddenWorkflowSources) ||
      !o.hiddenWorkflowSources.every((s) => typeof s === "string"))
  ) {
    return false;
  }
  if (o.showBackgroundWorkflows !== undefined && typeof o.showBackgroundWorkflows !== "boolean") {
    return false;
  }
  if (o.showScheduledRuns !== undefined && typeof o.showScheduledRuns !== "boolean") {
    return false;
  }
  return true;
}

function readFromStorage(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    return isSettings(parsed) ? parsed : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function writeToStorage(next: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or disabled storage — non-fatal.
  }
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

// Module-level singleton so writes from one mount don't clobber stale local
// state held by another (TopBar + Chat both subscribe).
let cached: Settings | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Settings {
  if (cached === null) cached = readFromStorage();
  return cached;
}

function getServerSnapshot(): Settings {
  return DEFAULTS;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function update(updater: (prev: Settings) => Settings): void {
  const prev = getSnapshot();
  const next = updater(prev);
  if (next === prev) return;
  cached = next;
  writeToStorage(next);
  for (const l of listeners) l();
}

// Cross-tab sync: another tab writing to the same key updates this one too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cached = readFromStorage();
    for (const l of listeners) l();
  });
}

export interface UseSettingsResult {
  settings: Settings;
  toggleFavorite: (ref: ModelRef) => void;
  isFavorite: (ref: ModelRef) => boolean;
  setLastUsed: (ref: ModelRef) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setTheme: (value: ThemePreference) => void;
  setWorkflowsViewMode: (value: WorkflowsViewMode) => void;
  // Toggle a rib's workflows in/out of the catalog + runs view (view-only).
  toggleHiddenWorkflowSource: (ribId: string) => void;
  isWorkflowSourceHidden: (ribId: string) => boolean;
  setShowBackgroundWorkflows: (value: boolean) => void;
  setShowScheduledRuns: (value: boolean) => void;
}

export function useSettings(): UseSettingsResult {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleFavorite = useCallback((ref: ModelRef) => {
    update((prev) => {
      const idx = prev.favorites.findIndex((f) => sameRef(f, ref));
      const favorites =
        idx === -1 ? [...prev.favorites, ref] : prev.favorites.filter((_, i) => i !== idx);
      return { ...prev, favorites };
    });
  }, []);

  const isFavorite = useCallback(
    (ref: ModelRef): boolean => settings.favorites.some((f) => sameRef(f, ref)),
    [settings.favorites],
  );

  const setLastUsed = useCallback((ref: ModelRef) => {
    update((prev) => {
      if (prev.lastUsed && sameRef(prev.lastUsed, ref)) return prev;
      return { ...prev, lastUsed: ref };
    });
  }, []);

  const setSidebarCollapsed = useCallback((value: boolean) => {
    update((prev) => {
      if ((prev.sidebarCollapsed ?? false) === value) return prev;
      return { ...prev, sidebarCollapsed: value };
    });
  }, []);

  const setTheme = useCallback((value: ThemePreference) => {
    update((prev) => {
      if ((prev.theme ?? "system") === value) return prev;
      return { ...prev, theme: value };
    });
  }, []);

  const setWorkflowsViewMode = useCallback((value: WorkflowsViewMode) => {
    update((prev) => {
      if ((prev.workflowsViewMode ?? "both") === value) return prev;
      return { ...prev, workflowsViewMode: value };
    });
  }, []);

  const toggleHiddenWorkflowSource = useCallback((ribId: string) => {
    update((prev) => {
      const current = prev.hiddenWorkflowSources ?? [];
      const next = current.includes(ribId)
        ? current.filter((id) => id !== ribId)
        : [...current, ribId];
      return { ...prev, hiddenWorkflowSources: next };
    });
  }, []);

  const isWorkflowSourceHidden = useCallback(
    (ribId: string): boolean => (settings.hiddenWorkflowSources ?? []).includes(ribId),
    [settings.hiddenWorkflowSources],
  );

  const setShowBackgroundWorkflows = useCallback((value: boolean) => {
    update((prev) => {
      if ((prev.showBackgroundWorkflows ?? false) === value) return prev;
      return { ...prev, showBackgroundWorkflows: value };
    });
  }, []);

  const setShowScheduledRuns = useCallback((value: boolean) => {
    update((prev) => {
      if ((prev.showScheduledRuns ?? false) === value) return prev;
      return { ...prev, showScheduledRuns: value };
    });
  }, []);

  return {
    settings,
    toggleFavorite,
    isFavorite,
    setLastUsed,
    setSidebarCollapsed,
    setTheme,
    setWorkflowsViewMode,
    toggleHiddenWorkflowSource,
    isWorkflowSourceHidden,
    setShowBackgroundWorkflows,
    setShowScheduledRuns,
  };
}
