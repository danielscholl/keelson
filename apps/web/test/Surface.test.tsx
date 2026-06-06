import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RibSurfaceDescriptor } from "@keelson/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";

// Stub the snapshot hook (not api.ts/ws.ts) so this file's mocks don't collide
// with Canvas.test.tsx's api.ts mock under bun's process-global mock.module.
// Surface's contract is layout + collapse + auto-refresh wiring; the hook's
// actual re-hydrate is the hook's own concern.
const FRESH_ISO = new Date(Date.now() - 5_000).toISOString();
const snapStates: Record<string, { status: string; data: unknown; composedAt?: string | null }> =
  {};
const reloadCalls: Record<string, number> = {};
const useSnapshotKeys: string[] = [];

mock.module("../src/hooks/useSnapshot.ts", () => ({
  useSnapshot: (key: string | null) => {
    if (key === null)
      return { status: "empty", data: null, version: null, composedAt: null, reload: () => {} };
    useSnapshotKeys.push(key);
    const s = snapStates[key] ?? { status: "empty", data: null };
    return {
      status: s.status,
      data: s.data,
      version: 1,
      composedAt: s.composedAt ?? (s.status === "live" ? FRESH_ISO : null),
      reload: () => {
        reloadCalls[key] = (reloadCalls[key] ?? 0) + 1;
      },
    };
  },
}));

// Stub the trigger hook (not api.ts) so refresh-run wiring is observable without
// the api.ts module mock that other suites set process-globally.
const triggerCalls: string[] = [];
let triggerRunning = false;
mock.module("../src/hooks/useWorkflowTrigger.ts", () => ({
  useWorkflowTrigger: (name?: string) => ({
    running: name ? triggerRunning : false,
    error: null,
    trigger: () => {
      if (name) triggerCalls.push(name);
    },
  }),
}));

const { CanvasProvider } = await import("../src/components/Canvas/CanvasHost.tsx");
const { Surface } = await import("../src/views/Surface.tsx");

function board(title: string, statLabel: string, statValue: number) {
  return {
    view: "board",
    title,
    header: { chip: "venus", segments: [{ label: "Fail", n: 3, tone: "error" }] },
    sections: [{ kind: "stats", items: [{ label: statLabel, value: statValue }] }],
  };
}

function live(key: string, data: unknown) {
  snapStates[key] = { status: "live", data };
}

function renderSurface(descriptor: RibSurfaceDescriptor) {
  return render(
    <CanvasProvider>
      <Surface descriptor={descriptor} />
    </CanvasProvider>,
  );
}

beforeEach(() => {
  for (const k of Object.keys(snapStates)) delete snapStates[k];
  for (const k of Object.keys(reloadCalls)) delete reloadCalls[k];
  useSnapshotKeys.length = 0;
  triggerCalls.length = 0;
  triggerRunning = false;
});

describe("Surface", () => {
  test("lays out a row of columns, each rendering its board", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    live("rib:demo:security", board("Security", "Critical", 5));
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        rows: [
          {
            columns: [
              { key: "rib:demo:quality", title: "Quality" },
              { key: "rib:demo:security", title: "Security" },
            ],
          },
        ],
      },
    });
    // The lane head shows the region's static title; the body renders its board.
    expect(screen.getByText("Quality")).toBeDefined();
    expect(screen.getByText("Security")).toBeDefined();
    expect(screen.getByText("Services")).toBeDefined();
    expect(screen.getByText("Critical")).toBeDefined();
    expect(container.querySelectorAll(".surface-row > .surface-region")).toHaveLength(2);
  });

  test("a region without a static title falls back to the board's title in the head", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    // No region.title, but the board's own title still labels the lane.
    expect(screen.getByText("Quality")).toBeDefined();
    expect(screen.getByText("Services")).toBeDefined();
  });

  test("each region subscribes to its own key", () => {
    live("rib:demo:cluster", board("Cluster", "Pods", 8));
    live("rib:demo:quality", board("Quality", "Services", 23));
    live("rib:demo:security", board("Security", "Critical", 5));
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        header: { key: "rib:demo:cluster" },
        rows: [{ columns: [{ key: "rib:demo:quality" }, { key: "rib:demo:security" }] }],
      },
    });
    expect([...new Set(useSnapshotKeys)].sort()).toEqual([
      "rib:demo:cluster",
      "rib:demo:quality",
      "rib:demo:security",
    ]);
  });

  test("a collapsed collapsible region shows only its header strip until expanded", () => {
    live("rib:demo:cluster", board("Cluster", "Pods", 8));
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        header: { key: "rib:demo:cluster", title: "Cluster", collapsible: true, collapsed: true },
        rows: [],
      },
    });
    // The lane head (title + chip + segments) renders; the stats body does not.
    expect(screen.getByText("Cluster")).toBeDefined();
    expect(screen.queryByText("Pods")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand region" }));
    expect(screen.getByText("Pods")).toBeDefined();
  });

  test("a non-collapsible region renders its full board with no collapse toggle", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    expect(screen.getByText("Services")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Collapse region" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand region" })).toBeNull();
  });

  test("renders no per-region refresh button — auto-refresh replaces it", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    // Expand is the only head control that remains.
    expect(screen.getByRole("button", { name: "Expand" })).toBeDefined();
  });

  test("an empty region with a workflow + cadence auto-runs it on mount", () => {
    // No live() → the key is empty, so the region is stale and self-warms.
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        rows: [
          { columns: [{ key: "rib:demo:quality", workflow: "osdu-quality", cadenceMs: 600_000 }] },
        ],
      },
    });
    expect(triggerCalls).toEqual(["osdu-quality"]);
  });

  test("shows a 'refreshing…' freshness readout while its run is in flight", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    triggerRunning = true;
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        rows: [
          { columns: [{ key: "rib:demo:quality", workflow: "osdu-quality", cadenceMs: 600_000 }] },
        ],
      },
    });
    expect(screen.getByText("refreshing…")).toBeDefined();
  });

  test("a region with no data renders a shimmer skeleton, not a waiting note", () => {
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:missing" }] }] },
    });
    expect(container.querySelector(".cv-skeleton")).not.toBeNull();
    expect(screen.queryByText("Waiting for the first update…")).toBeNull();
  });

  test("Expand opens the region full-size in the canvas drawer", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    const region = container.querySelector(".surface-region") as HTMLElement;
    fireEvent.click(within(region).getByRole("button", { name: "Expand" }));
    // The drawer renders the same board (via its own useSnapshot of the key).
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Quality");
    expect(dialog.textContent).toContain("Services");
  });

  test("a region's board actions render enabled (wired to the rib-namespaced dispatcher)", () => {
    live("rib:demo:cluster", {
      view: "board",
      title: "Cluster",
      sections: [{ kind: "actions", items: [{ type: "reconcile", label: "Reconcile" }] }],
    });
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:cluster" }] }] },
    });
    const btn = screen.getByRole("button", { name: "Reconcile" });
    expect(btn).toHaveProperty("disabled", false);
  });
});
