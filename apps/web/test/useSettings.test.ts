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
