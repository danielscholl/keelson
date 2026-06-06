import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { type AutoRefreshInput, useAutoRefresh } from "../src/hooks/useAutoRefresh.ts";

const base: AutoRefreshInput = {
  workflow: "osdu-x",
  cadenceMs: 600_000,
  status: "live",
  composedAt: null,
  running: false,
  error: null,
  trigger: () => {},
};

function counter() {
  let n = 0;
  return {
    trigger: () => {
      n += 1;
    },
    count: () => n,
  };
}

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("useAutoRefresh — fire decision", () => {
  test("fires on mount when the frame is missing (empty + stale)", () => {
    const t = counter();
    renderHook(() =>
      useAutoRefresh({ ...base, status: "empty", composedAt: null, trigger: t.trigger }),
    );
    expect(t.count()).toBe(1);
  });

  test("does not fire when the frame is fresh", () => {
    const t = counter();
    renderHook(() => useAutoRefresh({ ...base, composedAt: agoIso(60_000), trigger: t.trigger }));
    expect(t.count()).toBe(0);
  });

  test("fires when the frame is older than the cadence", () => {
    const t = counter();
    renderHook(() => useAutoRefresh({ ...base, composedAt: agoIso(700_000), trigger: t.trigger }));
    expect(t.count()).toBe(1);
  });

  test("does not fire while a run is in flight", () => {
    const t = counter();
    renderHook(() =>
      useAutoRefresh({
        ...base,
        status: "empty",
        composedAt: null,
        running: true,
        trigger: t.trigger,
      }),
    );
    expect(t.count()).toBe(0);
  });

  test("does not fire while the snapshot is still loading", () => {
    const t = counter();
    renderHook(() =>
      useAutoRefresh({ ...base, status: "loading", composedAt: null, trigger: t.trigger }),
    );
    expect(t.count()).toBe(0);
  });

  test("does not fire without a workflow or a cadence", () => {
    const a = counter();
    renderHook(() =>
      useAutoRefresh({ ...base, workflow: undefined, status: "empty", trigger: a.trigger }),
    );
    expect(a.count()).toBe(0);
    const b = counter();
    renderHook(() =>
      useAutoRefresh({ ...base, cadenceMs: undefined, status: "empty", trigger: b.trigger }),
    );
    expect(b.count()).toBe(0);
  });

  test("does not fire while the tab is hidden", () => {
    const t = counter();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    try {
      renderHook(() =>
        useAutoRefresh({ ...base, status: "empty", composedAt: null, trigger: t.trigger }),
      );
      expect(t.count()).toBe(0);
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
    }
  });
});

describe("useAutoRefresh — freshness label", () => {
  test("shows 'refreshing…' while running", () => {
    const { result } = renderHook(() => useAutoRefresh({ ...base, running: true }));
    expect(result.current).toEqual({ label: "refreshing…", tone: null });
  });

  test("shows the error readout when the last run errored", () => {
    const { result } = renderHook(() =>
      useAutoRefresh({ ...base, composedAt: agoIso(5_000), error: "boom" }),
    );
    expect(result.current).toEqual({ label: "refresh failed", tone: "error" });
  });

  test("clears the error once a newer frame supersedes the errored run", () => {
    const { result, rerender } = renderHook((props: AutoRefreshInput) => useAutoRefresh(props), {
      initialProps: { ...base, composedAt: agoIso(120_000), error: "boom" },
    });
    expect(result.current.tone).toBe("error");
    rerender({ ...base, composedAt: agoIso(1_000), error: "boom" });
    expect(result.current.label).toBe("updated just now");
    expect(result.current.tone).toBeNull();
  });

  test("keeps the error when a failed refresh produced no new frame", () => {
    const frame = agoIso(5_000);
    const { result, rerender } = renderHook((props: AutoRefreshInput) => useAutoRefresh(props), {
      initialProps: { ...base, composedAt: frame, running: true },
    });
    expect(result.current.label).toBe("refreshing…");
    rerender({ ...base, composedAt: frame, error: "boom", running: false });
    expect(result.current).toEqual({ label: "refresh failed", tone: "error" });
  });

  test("shows a relative age, warn-toned once past the cadence", () => {
    const fresh = renderHook(() => useAutoRefresh({ ...base, composedAt: agoIso(120_000) }));
    expect(fresh.result.current.label).toBe("updated 2m ago");
    expect(fresh.result.current.tone).toBeNull();

    const stale = renderHook(() => useAutoRefresh({ ...base, composedAt: agoIso(700_000) }));
    expect(stale.result.current.tone).toBe("warn");
  });

  test("renders no readout for a region without a cadence", () => {
    const { result } = renderHook(() =>
      useAutoRefresh({ ...base, cadenceMs: undefined, composedAt: agoIso(1_000) }),
    );
    expect(result.current).toEqual({ label: null, tone: null });
  });

  test("shows no readout before any frame arrives", () => {
    const { result } = renderHook(() =>
      useAutoRefresh({ ...base, status: "empty", composedAt: null }),
    );
    expect(result.current).toEqual({ label: null, tone: null });
  });
});
