import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RibSurfaceDescriptor } from "@keelson/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";

// Stub the snapshot hook (not api.ts/ws.ts) so this file's mocks don't collide
// with Canvas.test.tsx's api.ts mock under bun's process-global mock.module.
// Surface's contract is layout + collapse + refresh wiring; the hook's actual
// re-hydrate is the hook's own concern.
const snapStates: Record<string, { status: string; data: unknown }> = {};
const reloadCalls: Record<string, number> = {};
const useSnapshotKeys: string[] = [];

mock.module("../src/hooks/useSnapshot.ts", () => ({
  useSnapshot: (key: string | null) => {
    if (key === null) return { status: "empty", data: null, version: null, reload: () => {} };
    useSnapshotKeys.push(key);
    const s = snapStates[key] ?? { status: "empty", data: null };
    return {
      status: s.status,
      data: s.data,
      version: 1,
      reload: () => {
        reloadCalls[key] = (reloadCalls[key] ?? 0) + 1;
      },
    };
  },
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
});

describe("Surface", () => {
  test("lays out a row of columns, each rendering its board", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    live("rib:demo:security", board("Security", "Critical", 5));
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }, { key: "rib:demo:security" }] }] },
    });
    expect(screen.getByText("Quality")).toBeDefined();
    expect(screen.getByText("Security")).toBeDefined();
    expect(screen.getByText("Services")).toBeDefined();
    expect(screen.getByText("Critical")).toBeDefined();
    expect(container.querySelectorAll(".surface-row > .surface-region")).toHaveLength(2);
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
      layout: { header: { key: "rib:demo:cluster", collapsible: true, collapsed: true }, rows: [] },
    });
    // The header strip (title + chip + segments) renders; the stats body does not.
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

  test("Refresh asks the region's snapshot to re-hydrate", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    expect(reloadCalls["rib:demo:quality"]).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(reloadCalls["rib:demo:quality"]).toBe(1);
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

  test("a region with no snapshot yet degrades to a waiting note, not a crash", () => {
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:missing" }] }] },
    });
    expect(screen.getByText("Waiting for the first update…")).toBeDefined();
  });
});
