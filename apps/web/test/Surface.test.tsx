import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CANVAS_HTML_ACTION_CHANNEL,
  RIBS_VERSION_SNAPSHOT_KEY,
  type RibActionResponse,
  type RibSummary,
  type RibSurfaceDescriptor,
} from "@keelson/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as realApi from "../src/api.ts";
import type { RegionAction } from "../src/hooks/useSettings.ts";
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
const triggerHookArgs: Array<Record<string, string> | undefined> = [];
let triggerRunning = false;
let triggerError: string | null = null;
mock.module("../src/hooks/useWorkflowTrigger.ts", () => ({
  useWorkflowTrigger: (name?: string, workflowArgs?: Record<string, string>) => {
    if (name) triggerHookArgs.push(workflowArgs);
    return {
      running: name ? triggerRunning : false,
      error: name ? triggerError : null,
      trigger: () => {
        if (name) triggerCalls.push(name);
      },
    };
  },
}));

const postRibActionCalls: Array<{ ribId: string; action: unknown }> = [];
let postRibActionResult: RibActionResponse = { ok: true };
mock.module("../src/api.ts", () => ({
  ...realApi,
  postRibAction: async (ribId: string, action: unknown) => {
    postRibActionCalls.push({ ribId, action });
    return postRibActionResult;
  },
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

// A rib declaring one key as `canvasKind: "html"` — what routes a region to the
// frame renderer instead of the structured one.
function htmlRib(key: string): RibSummary {
  return {
    id: "demo",
    displayName: "Demo",
    registered: [],
    views: [{ key, canvasKind: "html" }],
    surfaces: [],
    hasOnAction: true,
  };
}

function postMessageTo(data: unknown, source: unknown) {
  const e = new MessageEvent("message", { data });
  Object.defineProperty(e, "source", { value: source, configurable: true });
  window.dispatchEvent(e);
}

function renderSurface(
  descriptor: RibSurfaceDescriptor,
  opts?: { onOpenSurface?: (surfaceId: string, regionKey?: string) => void },
) {
  return render(
    <RibsProvider>
      <CanvasProvider>
        <Surface descriptor={descriptor} onOpenSurface={opts?.onOpenSurface} />
      </CanvasProvider>
    </RibsProvider>,
  );
}

beforeEach(() => {
  for (const k of Object.keys(snapStates)) delete snapStates[k];
  for (const k of Object.keys(reloadCalls)) delete reloadCalls[k];
  useSnapshotKeys.length = 0;
  triggerCalls.length = 0;
  triggerHookArgs.length = 0;
  triggerRunning = false;
  triggerError = null;
  postRibActionCalls.length = 0;
  postRibActionResult = { ok: true };
  ribSummaries = [];
  // Seeding an explicit empty list (rather than clearing) opts these tests into all
  // three controls: select and expand are hidden by default, and most cases here
  // exercise the controls themselves rather than that default.
  seedRegionActions([]);
});

// Persist a hiddenRegionActions payload and sync useSettings' module-scope cache —
// it only re-reads on a `storage` event, so a seeded preference would otherwise
// leak into every later test. Pass null to persist nothing (the default applies).
function seedRegionActions(hidden: RegionAction[] | null): void {
  localStorage.clear();
  if (hidden !== null) {
    localStorage.setItem(
      "keelson.settings.v1",
      JSON.stringify({ favorites: [], lastUsed: null, hiddenRegionActions: hidden }),
    );
  }
  window.dispatchEvent(new StorageEvent("storage", { key: "keelson.settings.v1" }));
}

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

  test("hideWhenEmpty omits a region until a live board has sections", () => {
    const descriptor: RibSurfaceDescriptor = {
      id: "squad",
      title: "Squad",
      layout: {
        rows: [
          {
            zoneTitle: "Casting",
            columns: [{ key: "rib:squad:casting", title: "Casting", hideWhenEmpty: true }],
          },
        ],
      },
    };
    const first = renderSurface(descriptor);
    expect(first.container.querySelector('[data-region-key="rib:squad:casting"]')).toBeNull();
    expect(first.container.querySelector(".surface-row")?.children.length).toBe(0);

    live("rib:squad:casting", board("Casting", "Seats", 3));
    first.unmount();
    const withContent = renderSurface(descriptor);
    expect(
      withContent.container.querySelector('[data-region-key="rib:squad:casting"]'),
    ).not.toBeNull();
    expect(screen.getByText("Seats")).toBeDefined();

    live("rib:squad:casting", { view: "board", title: "Casting", sections: [] });
    withContent.unmount();
    const emptyAgain = renderSurface(descriptor);
    expect(emptyAgain.container.querySelector('[data-region-key="rib:squad:casting"]')).toBeNull();
    expect(emptyAgain.container.querySelector(".surface-row")?.children.length).toBe(0);
  });

  test("hideWhenEmpty treats non-board live payloads as content", () => {
    live("rib:squad:table", {
      view: "table",
      columns: [{ key: "name" }],
      rows: [{ name: "Ready" }],
    });
    const { container } = renderSurface({
      id: "squad",
      title: "Squad",
      layout: {
        rows: [{ columns: [{ key: "rib:squad:table", title: "Table", hideWhenEmpty: true }] }],
      },
    });
    expect(container.querySelector('[data-region-key="rib:squad:table"]')).not.toBeNull();
    expect(screen.getByText("Table")).toBeDefined();
  });

  test("hideWhenEmpty keeps a live payload that fails the view parse visible", () => {
    // A producer bug must stay observable: the region renders its error state
    // rather than silently disappearing.
    live("rib:squad:broken", { view: "no-such-view" });
    const { container } = renderSurface({
      id: "squad",
      title: "Squad",
      layout: {
        rows: [{ columns: [{ key: "rib:squad:broken", title: "Broken", hideWhenEmpty: true }] }],
      },
    });
    expect(container.querySelector('[data-region-key="rib:squad:broken"]')).not.toBeNull();
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

  test("an html-declared region renders its markup inline, not the view-parse error", () => {
    live("rib:demo:html-panel", "<p>hi from html lens</p>");
    ribSummaries = [htmlRib("rib:demo:html-panel")];
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      // hideRegionActions mirrors an authoring console (the Chamber surface): with
      // no Expand control, the inline body is the ONLY way to see the page.
      hideRegionActions: true,
      layout: { rows: [{ columns: [{ key: "rib:demo:html-panel", title: "HTML Lens" }] }] },
    });

    const region = container.querySelector(".surface-region") as HTMLElement;
    expect(region.querySelector("iframe.canvas-html-frame")).not.toBeNull();
    expect(region.textContent).not.toContain("didn't match a known view type");
  });

  test("hideWhenEmpty omits an html region whose markup is blank, and keeps one with content", () => {
    live("rib:demo:blank", "   \n  ");
    live("rib:demo:filled", "<p>real page</p>");
    ribSummaries = [
      {
        ...htmlRib("rib:demo:blank"),
        views: [
          { key: "rib:demo:blank", canvasKind: "html" },
          { key: "rib:demo:filled", canvasKind: "html" },
        ],
      },
    ];
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: {
        rows: [
          {
            columns: [
              { key: "rib:demo:blank", title: "Blank", hideWhenEmpty: true },
              { key: "rib:demo:filled", title: "Filled", hideWhenEmpty: true },
            ],
          },
        ],
      },
    });

    const titles = [...container.querySelectorAll(".surface-region")].map((r) => r.textContent);
    expect(titles.some((t) => t?.includes("Blank"))).toBe(false);
    expect(titles.some((t) => t?.includes("Filled"))).toBe(true);
  });

  test("an html region's frame action is dispatched with origin canvas-html", async () => {
    live("rib:demo:html-panel", "<p>hi</p>");
    ribSummaries = [htmlRib("rib:demo:html-panel")];
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:html-panel", title: "HTML Lens" }] }] },
    });

    const frame = container.querySelector("iframe.canvas-html-frame") as HTMLIFrameElement;
    const win = {} as Window;
    Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
    postMessageTo(
      { channel: CANVAS_HTML_ACTION_CHANNEL, type: "suspend", payload: { cluster: "demo" } },
      win,
    );

    // The stamp is the security boundary: an omitted origin means a trusted board
    // dispatch, so untrusted frame markup must never reach the rib without it.
    await waitFor(() => expect(postRibActionCalls.length).toBe(1));
    expect(postRibActionCalls[0]).toEqual({
      ribId: "demo",
      action: { type: "suspend", payload: { cluster: "demo" }, origin: "canvas-html" },
    });
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

  test("hideRegionActions suppresses the Explore, select, and Expand head controls", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    // A no-op onExplore: its presence is what would normally render the controls,
    // so passing it proves the opt-out — not the handler — is what suppresses them.
    render(
      <CanvasProvider>
        <Surface
          descriptor={{
            id: "chamber",
            title: "Chamber",
            hideRegionActions: true,
            layout: { rows: [{ columns: [{ key: "rib:demo:quality", title: "Quality" }] }] },
          }}
          onExplore={() => {}}
        />
      </CanvasProvider>,
    );
    // The board still renders (board actions flow through onExplore); only the
    // head-strip host controls are gone.
    expect(screen.getByText("Services")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Explore in chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "Select panel for multi-panel explore" }),
    ).toBeNull();
  });

  test("by default a panel head carries Explore in chat alone", () => {
    seedRegionActions(null);
    live("rib:demo:quality", board("Quality", "Services", 23));
    render(
      <CanvasProvider>
        <Surface
          descriptor={{
            id: "cimpl",
            title: "CIMPL",
            layout: { rows: [{ columns: [{ key: "rib:demo:quality", title: "Quality" }] }] },
          }}
          onExplore={() => {}}
        />
      </CanvasProvider>,
    );
    expect(screen.getByRole("button", { name: "Explore in chat" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "Select panel for multi-panel explore" }),
    ).toBeNull();
  });

  test("a viewer's hiddenRegionActions drops those controls but keeps the rest", () => {
    seedRegionActions(["select", "expand"]);
    live("rib:demo:quality", board("Quality", "Services", 23));
    render(
      <CanvasProvider>
        <Surface
          descriptor={{
            id: "cimpl",
            title: "CIMPL",
            layout: { rows: [{ columns: [{ key: "rib:demo:quality", title: "Quality" }] }] },
          }}
          onExplore={() => {}}
        />
      </CanvasProvider>,
    );
    expect(screen.getByRole("button", { name: "Explore in chat" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "Select panel for multi-panel explore" }),
    ).toBeNull();
  });

  test("a surface's hideRegionActions still wins over a viewer keeping a control", () => {
    // Viewer hides only select; the surface opts out of everything — the union
    // means explore and expand stay gone rather than coming back.
    seedRegionActions(["select"]);
    live("rib:demo:quality", board("Quality", "Services", 23));
    render(
      <CanvasProvider>
        <Surface
          descriptor={{
            id: "chamber",
            title: "Chamber",
            hideRegionActions: true,
            layout: { rows: [{ columns: [{ key: "rib:demo:quality", title: "Quality" }] }] },
          }}
          onExplore={() => {}}
        />
      </CanvasProvider>,
    );
    expect(screen.queryByRole("button", { name: "Explore in chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  });

  test("flipping hideRegionActions on clears a stale selection and its bar", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    live("rib:demo:security", board("Security", "Critical", 5));
    const descriptor = (hide: boolean): RibSurfaceDescriptor => ({
      id: "cimpl",
      title: "CIMPL",
      ...(hide ? { hideRegionActions: true } : {}),
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
    const { rerender } = render(
      <CanvasProvider>
        <Surface descriptor={descriptor(false)} onExplore={() => {}} />
      </CanvasProvider>,
    );
    const [firstCheckbox] = screen.getAllByRole("checkbox", {
      name: "Select panel for multi-panel explore",
    });
    if (!firstCheckbox) throw new Error("expected a selectable panel");
    fireEvent.click(firstCheckbox);
    expect(screen.getByRole("button", { name: /Explore 1 selected/ })).toBeDefined();
    // Opting the surface out of region actions drops the now-unreachable selection.
    rerender(
      <CanvasProvider>
        <Surface descriptor={descriptor(true)} onExplore={() => {}} />
      </CanvasProvider>,
    );
    expect(screen.queryByRole("button", { name: /Explore .* selected/ })).toBeNull();
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

  test("selected live regions raise one aggregate explore seed", () => {
    live("rib:demo:quality", board("Quality", "Services", 23));
    live("rib:demo:security", board("Security", "Critical", 5));
    const seeds: ChatSeed[] = [];
    render(
      <CanvasProvider>
        <Surface
          descriptor={{
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
          }}
          onExplore={(s) => seeds.push(s)}
        />
      </CanvasProvider>,
    );

    const checkboxes = screen.getAllByRole("checkbox", {
      name: "Select panel for multi-panel explore",
    });
    const [qualityCheckbox, securityCheckbox] = checkboxes;
    if (!qualityCheckbox || !securityCheckbox) {
      throw new Error("expected two selectable live panels");
    }
    fireEvent.click(qualityCheckbox);
    fireEvent.click(securityCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Explore 2 selected" }));

    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.name).toBe("Quality +1 more");
    expect(seeds[0]?.systemPrompt).toContain("## Quality");
    expect(seeds[0]?.systemPrompt).toContain("## Security");
    expect(seeds[0]?.systemPrompt.match(/===BEGIN PANEL DATA/g)?.length).toBe(1);
    expect(seeds[0]?.systemPrompt.match(/===END PANEL DATA===/g)?.length).toBe(1);
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

  test("a region board action can open another surface and carries its region key", async () => {
    live("rib:demo:cluster", {
      view: "board",
      title: "Cluster",
      sections: [{ kind: "actions", items: [{ type: "open-room", label: "Open room" }] }],
    });
    postRibActionResult = {
      ok: true,
      data: {
        effect: "open-surface",
        surfaceId: "surface:chamber:rooms",
        regionKey: "rib:chamber:room-7",
      },
    };
    const surfaces: Array<{ surfaceId: string; regionKey?: string }> = [];
    const { container } = renderSurface(
      {
        id: "cimpl",
        title: "CIMPL",
        layout: { rows: [{ columns: [{ key: "rib:demo:cluster" }] }] },
      },
      { onOpenSurface: (surfaceId, regionKey) => surfaces.push({ surfaceId, regionKey }) },
    );

    expect(container.querySelector(".surface-region")?.getAttribute("data-region-key")).toBe(
      "rib:demo:cluster",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open room" }));

    await waitFor(() =>
      expect(surfaces).toEqual([
        { surfaceId: "surface:chamber:rooms", regionKey: "rib:chamber:room-7" },
      ]),
    );
    expect(postRibActionCalls).toEqual([{ ribId: "demo", action: { type: "open-room" } }]);
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

  test("a region opted into live renders a freshness pulse dot in its head", () => {
    live("rib:squad:run", board("Run", "Rounds", 3));
    const { container } = renderSurface({
      id: "squad",
      title: "Squad",
      layout: { rows: [{ columns: [{ key: "rib:squad:run", title: "Run", live: true }] }] },
    });
    // The dot is present (opt-in affordance) but idle — a single hydrated frame
    // is the baseline, not a stream event, so it carries no data-streaming.
    const dot = container.querySelector(".surface-region-live");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-streaming")).toBeNull();
  });

  test("a region without the live opt-in renders no pulse dot", () => {
    live("rib:squad:run", board("Run", "Rounds", 3));
    const { container } = renderSurface({
      id: "squad",
      title: "Squad",
      layout: { rows: [{ columns: [{ key: "rib:squad:run", title: "Run" }] }] },
    });
    expect(container.querySelector(".surface-region-live")).toBeNull();
  });

  test("a positive pulse segment renders the head meta row", () => {
    live("rib:demo:pulse", {
      view: "board",
      title: "Pulse",
      header: { segments: [{ label: "active", n: 2, tone: "ok" }] },
      sections: [{ kind: "stats", items: [{ label: "OpenPulse", value: 1 }] }],
    });
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:pulse", title: "Pulse" }] }] },
    });
    expect(container.querySelector(".surface-region-head-meta")).not.toBeNull();
  });

  test("an all-non-positive pulse renders no head meta row (Segments would be empty)", () => {
    live("rib:demo:pulse", {
      view: "board",
      title: "Pulse",
      header: {
        segments: [
          { label: "active", n: 0, tone: "ok" },
          { label: "stalled", n: -1, tone: "error" },
        ],
      },
      sections: [{ kind: "stats", items: [{ label: "OpenPulse", value: 0 }] }],
    });
    const { container } = renderSurface({
      id: "cimpl",
      title: "CIMPL",
      layout: { rows: [{ columns: [{ key: "rib:demo:pulse", title: "Pulse" }] }] },
    });
    // The board itself still renders (its stat body is present); only the empty
    // pulse row is suppressed, so this proves the guard — not a parse failure.
    expect(container.textContent).toContain("OpenPulse");
    expect(container.querySelector(".surface-region-head-meta")).toBeNull();
  });

  test("a region's workflowArgs reach the refresh trigger hook", () => {
    live("rib:chamber:lens:morning-brief", board("Morning Brief", "Items", 4));
    renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          {
            columns: [
              {
                key: "rib:chamber:lens:morning-brief",
                title: "morning-brief",
                workflow: "chamber-lens-refresh",
                workflowArgs: { lens: "morning-brief" },
                cadenceMs: 3_600_000,
              },
            ],
          },
        ],
      },
    });
    expect(triggerHookArgs).toContainEqual({ lens: "morning-brief" });
  });

  test("headActions render a head ⋯ menu whose destructive verb confirms, then dispatches", async () => {
    live("rib:chamber:lens:brief", board("Brief", "Items", 2));
    renderSurface({
      id: "chamber",
      title: "Chamber",
      layout: {
        rows: [
          {
            columns: [
              {
                key: "rib:chamber:lens:brief",
                title: "brief",
                headActions: [
                  {
                    type: "retire-lens",
                    label: "Retire lens…",
                    destructive: true,
                    payload: { id: "brief" },
                    confirm: {
                      title: "Retire lens",
                      body: "Retire brief?",
                      confirmLabel: "Retire",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Brief actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Retire lens…" }));
    // Destructive → the confirm dialog gates the dispatch; nothing posted yet.
    expect(postRibActionCalls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    await waitFor(() =>
      expect(postRibActionCalls).toEqual([
        { ribId: "chamber", action: { type: "retire-lens", payload: { id: "brief" } } },
      ]),
    );
  });

  test("headActions survive hideRegionActions and a collapsed region", () => {
    live("rib:chamber:lens:brief", board("Brief", "Items", 2));
    renderSurface({
      id: "chamber",
      title: "Chamber",
      hideRegionActions: true,
      layout: {
        rows: [
          {
            columns: [
              {
                key: "rib:chamber:lens:brief",
                title: "brief",
                collapsible: true,
                collapsed: true,
                headActions: [{ type: "retire-lens", label: "Retire lens…", destructive: true }],
              },
            ],
          },
        ],
      },
    });
    // Host chrome is suppressed and the body is folded away…
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(screen.queryByText("Items")).toBeNull();
    // …but the rib's own head verbs stay reachable.
    expect(screen.getByRole("button", { name: "Brief actions" })).toBeDefined();
  });
});
