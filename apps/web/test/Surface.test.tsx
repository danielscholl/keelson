import { beforeEach, describe, expect, mock, test } from "bun:test";
import { RIBS_VERSION_SNAPSHOT_KEY, type RibSummary, type RibSurfaceDescriptor } from "@keelson/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { type ChatSeed, OPENING_PROMPT } from "../src/lib/exploreSeed.ts";

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
let triggerError: string | null = null;
mock.module("../src/hooks/useWorkflowTrigger.ts", () => ({
  useWorkflowTrigger: (name?: string) => ({
    running: name ? triggerRunning : false,
    error: name ? triggerError : null,
    trigger: () => {
      if (name) triggerCalls.push(name);
    },
  }),
}));

let ribSummaries: RibSummary[] = [];
mock.module("../src/hooks/useRibs.ts", () => ({
  useRibs: () => ({ status: "ready", ribs: ribSummaries, error: null, refresh: () => {} }),
}));

const { CanvasProvider } = await import("../src/components/Canvas/CanvasHost.tsx");
const { RibsProvider } = await import("../src/components/RibsProvider.tsx");
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
    <RibsProvider>
      <CanvasProvider>
        <Surface descriptor={descriptor} />
      </CanvasProvider>
    </RibsProvider>,
  );
}

beforeEach(() => {
  for (const k of Object.keys(snapStates)) delete snapStates[k];
  for (const k of Object.keys(reloadCalls)) delete reloadCalls[k];
  useSnapshotKeys.length = 0;
  triggerCalls.length = 0;
  triggerRunning = false;
  triggerError = null;
  ribSummaries = [];
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
    expect(
      [...new Set(useSnapshotKeys)].filter((key) => key !== RIBS_VERSION_SNAPSHOT_KEY).sort(),
    ).toEqual(["rib:demo:cluster", "rib:demo:quality", "rib:demo:security"]);
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

  test("a workflow-bound region with no cadence offers a one-shot Load, not an endless skeleton", () => {
    // chamber's Briefing footer shape: a producing workflow but no cadence, so
    // it never auto-runs and would otherwise shimmer forever.
    const { container } = renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        footer: { key: "rib:chamber:brief", workflow: "chamber-brief", title: "Briefing" },
        rows: [],
      },
    });
    expect(container.querySelector(".cv-skeleton")).toBeNull();
    expect(screen.getByRole("button", { name: "Load" })).toBeDefined();
  });

  test("the idle Load control runs the bound workflow once on click", () => {
    renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        footer: { key: "rib:chamber:brief", workflow: "chamber-brief", title: "Briefing" },
        rows: [],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(triggerCalls).toEqual(["chamber-brief"]);
  });

  test("a failed on-demand Load surfaces the error and offers Retry", () => {
    triggerError = "boom: collector exited 1";
    renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        footer: { key: "rib:chamber:brief", workflow: "chamber-brief", title: "Briefing" },
        rows: [],
      },
    });
    expect(screen.getByText(/Load failed: boom/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  test("a busy workflow-bound region shows the running skeleton, not the idle Load", () => {
    triggerRunning = true;
    const { container } = renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        footer: { key: "rib:chamber:brief", workflow: "chamber-brief", title: "Briefing" },
        rows: [],
      },
    });
    expect(screen.queryByRole("button", { name: "Load" })).toBeNull();
    expect(container.querySelector(".cv-skeleton")).not.toBeNull();
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

  test("Expand opens html-declared keys as html and view-declared keys as view", () => {
    live("rib:demo:html-panel", "<p>hi from html lens</p>");
    live("rib:demo:view-panel", board("View Panel", "Services", 23));
    ribSummaries = [
      {
        id: "demo",
        displayName: "Demo",
        registered: [],
        views: [
          { key: "rib:demo:html-panel", canvasKind: "html" },
          { key: "rib:demo:view-panel", canvasKind: "view" },
        ],
        surfaces: [],
        hasOnAction: false,
      },
    ];
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        rows: [
          {
            columns: [
              { key: "rib:demo:html-panel", title: "HTML Lens" },
              { key: "rib:demo:view-panel", title: "View Lens" },
            ],
          },
        ],
      },
    });

    const htmlRegion = [...container.querySelectorAll(".surface-region")].find((region) =>
      region.textContent?.includes("HTML Lens"),
    ) as HTMLElement;
    fireEvent.click(within(htmlRegion).getByRole("button", { name: "Expand" }));
    let dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("iframe.canvas-html-frame")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close canvas" }));

    const viewRegion = [...container.querySelectorAll(".surface-region")].find((region) =>
      region.textContent?.includes("View Lens"),
    ) as HTMLElement;
    fireEvent.click(within(viewRegion).getByRole("button", { name: "Expand" }));
    dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("iframe.canvas-html-frame")).toBeNull();
    expect(dialog.textContent).toContain("Services");
  });

  test("no Explore control renders when onExplore is absent", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    expect(screen.queryByRole("button", { name: "Explore in chat" })).toBeNull();
  });

  test("Explore raises a chat seed built from the region's live snapshot", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    const seeds: ChatSeed[] = [];
    render(
      <CanvasProvider>
        <Surface
          descriptor={{
            id: "cimpl",
            title: "CIMPL",
            layout: { rows: [{ columns: [{ key: "rib:demo:quality", title: "Quality" }] }] },
          }}
          onExplore={(s) => seeds.push(s)}
        />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Explore in chat" }));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.name).toBe("Quality");
    expect(seeds[0]?.openingPrompt).toBe(OPENING_PROMPT);
    // The board snapshot (no markdown/text field) primes as a fenced JSON block.
    expect(seeds[0]?.systemPrompt).toContain("Quality");
    expect(seeds[0]?.systemPrompt).toContain("BEGIN PANEL DATA");
  });

  test("no Explore control on a region still waiting for its first snapshot", () => {
    const seeds: ChatSeed[] = [];
    render(
      <CanvasProvider>
        <Surface
          descriptor={{
            id: "cimpl",
            title: "CIMPL",
            layout: { rows: [{ columns: [{ key: "rib:demo:missing" }] }] },
          }}
          onExplore={(s) => seeds.push(s)}
        />
      </CanvasProvider>,
    );
    // Gated on snap.status === "live" — an empty region offers nothing to prime.
    expect(screen.queryByRole("button", { name: "Explore in chat" })).toBeNull();
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

  test("renders the surface title and subtitle as a page-identity slot", () => {
    const { container } = renderSurface({
      id: "chamber",
      title: "Chamber",
      subtitle: "3 rooms · 2 lenses",
      layout: { rows: [] },
    });
    expect(container.querySelector(".surface-identity-title")?.textContent).toBe("Chamber");
    expect(container.querySelector(".surface-identity-subtitle")?.textContent).toBe(
      "3 rooms · 2 lenses",
    );
  });

  test("renders a run of zoneTitle rows under one titled zone heading", () => {
    live("rib:chamber:room-1", board("Room 1", "Members", 4));
    live("rib:chamber:room-2", board("Room 2", "Members", 2));
    const { container } = renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          { zoneTitle: "Rooms", columns: [{ key: "rib:chamber:room-1", title: "Room 1" }] },
          { zoneTitle: "Rooms", columns: [{ key: "rib:chamber:room-2", title: "Room 2" }] },
        ],
      },
    });
    const zoneTitles = [...container.querySelectorAll(".surface-zone-title")].map(
      (n) => n.textContent,
    );
    // One zone heading covers both same-titled rows, not one per row.
    expect(zoneTitles).toEqual(["Rooms"]);
    const zone = container.querySelector(".surface-zone") as HTMLElement;
    expect(zone.querySelectorAll(".surface-row")).toHaveLength(2);
    expect(within(zone).getByText("Room 1")).toBeDefined();
    expect(within(zone).getByText("Room 2")).toBeDefined();
  });

  test("a titleless row stands alone with no zone heading (pre-zone layout)", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:quality" }] }] },
    });
    expect(container.querySelector(".surface-zone-title")).toBeNull();
    expect(container.querySelectorAll(".surface-row")).toHaveLength(1);
  });

  test("a collapsible row-column region collapses to its head until expanded", () => {
    live("rib:chamber:room-1", board("Room 1", "Members", 4));
    renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          {
            columns: [
              { key: "rib:chamber:room-1", title: "Room 1", collapsible: true, collapsed: true },
            ],
          },
        ],
      },
    });
    expect(screen.getByText("Room 1")).toBeDefined();
    expect(screen.queryByText("Members")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand region" }));
    expect(screen.getByText("Members")).toBeDefined();
  });

  test("renders a region byline beneath its title in the head", () => {
    live("rib:chamber:room-1", board("Room 1", "Members", 4));
    const { container } = renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          {
            columns: [{ key: "rib:chamber:room-1", title: "Room 1", byline: "scope: navigation" }],
          },
        ],
      },
    });
    expect(container.querySelector(".surface-region-byline")?.textContent).toBe(
      "scope: navigation",
    );
  });
});
