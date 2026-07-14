import { beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useSettings } from "../src/hooks/useSettings.ts";

const STORAGE_KEY = "keelson.settings.v1";

// useSettings caches at module scope and only re-reads on a `storage` event,
// so a storage event after each seed resets the cache between tests.
function seedAndSync(settings?: unknown): void {
  localStorage.clear();
  if (settings !== undefined) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

describe("useSettings — workflowsViewMode", () => {
  beforeEach(() => {
    seedAndSync();
  });

  test("defaults to 'both' when nothing is persisted", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.workflowsViewMode).toBeUndefined();
    expect(result.current.settings.workflowsViewMode ?? "both").toBe("both");
  });

  test("loads a valid persisted view mode", () => {
    seedAndSync({ favorites: [], lastUsed: null, workflowsViewMode: "workflows" });
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.workflowsViewMode).toBe("workflows");
  });

  test("setWorkflowsViewMode updates the snapshot and persists to localStorage", () => {
    const { result } = renderHook(() => useSettings());
    act(() => {
      result.current.setWorkflowsViewMode("runs");
    });
    expect(result.current.settings.workflowsViewMode).toBe("runs");
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).workflowsViewMode).toBe("runs");
  });

  test("falls back to default when the persisted value is invalid", () => {
    seedAndSync({ favorites: [], lastUsed: null, workflowsViewMode: "garbage" });
    const { result } = renderHook(() => useSettings());
    // isSettings() rejects the whole payload, so DEFAULTS apply: the field is
    // undefined and callers default it to "both".
    expect(result.current.settings.workflowsViewMode).toBeUndefined();
    expect(result.current.settings.workflowsViewMode ?? "both").toBe("both");
  });
});

describe("useSettings — workflow provenance view prefs", () => {
  beforeEach(() => {
    seedAndSync();
  });

  test("toggleHiddenWorkflowSource adds/removes a rib id and persists", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.isWorkflowSourceHidden("osdu")).toBe(false);
    act(() => result.current.toggleHiddenWorkflowSource("osdu"));
    expect(result.current.isWorkflowSourceHidden("osdu")).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string).hiddenWorkflowSources).toEqual([
      "osdu",
    ]);
    act(() => result.current.toggleHiddenWorkflowSource("osdu"));
    expect(result.current.isWorkflowSourceHidden("osdu")).toBe(false);
  });

  test("setShowBackgroundWorkflows / setShowScheduledRuns default false and persist", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.showBackgroundWorkflows ?? false).toBe(false);
    expect(result.current.settings.showScheduledRuns ?? false).toBe(false);
    act(() => result.current.setShowBackgroundWorkflows(true));
    act(() => result.current.setShowScheduledRuns(true));
    expect(result.current.settings.showBackgroundWorkflows).toBe(true);
    expect(result.current.settings.showScheduledRuns).toBe(true);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(raw.showBackgroundWorkflows).toBe(true);
    expect(raw.showScheduledRuns).toBe(true);
  });

  test("rejects a malformed hiddenWorkflowSources payload (whole-settings guard)", () => {
    seedAndSync({ favorites: [], lastUsed: null, hiddenWorkflowSources: "osdu" });
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.hiddenWorkflowSources).toBeUndefined();
  });
});

describe("useSettings — hiddenRegionActions", () => {
  beforeEach(() => {
    seedAndSync();
  });

  test("select and expand are hidden by default, explore is not", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.hiddenRegionActions).toBeUndefined();
    expect(result.current.isRegionActionHidden("explore")).toBe(false);
    expect(result.current.isRegionActionHidden("select")).toBe(true);
    expect(result.current.isRegionActionHidden("expand")).toBe(true);
  });

  test("toggling a defaulted action on writes the rest of the default down", () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.toggleHiddenRegionAction("expand"));
    expect(result.current.isRegionActionHidden("expand")).toBe(false);
    // Select keeps its default, now persisted rather than implied.
    expect(result.current.isRegionActionHidden("select")).toBe(true);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(raw.hiddenRegionActions).toEqual(["select"]);
  });

  test("toggleHiddenRegionAction round-trips explore and persists it", () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.toggleHiddenRegionAction("explore"));
    expect(result.current.isRegionActionHidden("explore")).toBe(true);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(raw.hiddenRegionActions).toEqual(["select", "expand", "explore"]);
    act(() => result.current.toggleHiddenRegionAction("explore"));
    expect(result.current.isRegionActionHidden("explore")).toBe(false);
  });

  test("an empty persisted list turns all three on (distinct from missing)", () => {
    seedAndSync({ favorites: [], lastUsed: null, hiddenRegionActions: [] });
    const { result } = renderHook(() => useSettings());
    expect(result.current.isRegionActionHidden("select")).toBe(false);
    expect(result.current.isRegionActionHidden("expand")).toBe(false);
  });

  test("rejects an unknown action in a persisted payload (whole-settings guard)", () => {
    seedAndSync({ favorites: [], lastUsed: null, hiddenRegionActions: ["select", "bogus"] });
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.hiddenRegionActions).toBeUndefined();
  });
});
