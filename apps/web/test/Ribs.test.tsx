import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CanvasDocument, RibAction, RibSummary } from "@keelson/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realApi from "../src/api.ts";

let ribsImpl: () => Promise<RibSummary[]> = async () => [];
const actionCalls: Array<{ id: string; action: RibAction }> = [];

mock.module("../src/api.ts", () => ({
  ...realApi,
  getRibs: () => ribsImpl(),
  postRibAction: async (id: string, action: RibAction) => {
    actionCalls.push({ id, action });
    return { ok: true as const, data: { echoed: action.type } };
  },
}));

// Capture the document handed to the canvas without mounting the snapshot
// WS pipeline — the descriptor → CanvasDocument mapping is what we assert.
let lastDoc: CanvasDocument | null = null;
mock.module("../src/components/Canvas/CanvasHost.tsx", () => ({
  useCanvas: () => ({
    openCanvas: (doc: CanvasDocument) => {
      lastDoc = doc;
    },
    close: () => {},
  }),
}));

const { ToastHost } = await import("../src/components/Toast.tsx");
const { Ribs } = await import("../src/views/Ribs.tsx");

function rib(partial: Partial<RibSummary> & Pick<RibSummary, "id" | "displayName">): RibSummary {
  return {
    registered: [],
    views: [],
    actions: [],
    hasOnAction: false,
    ...partial,
  };
}

async function renderRibs() {
  return render(
    <ToastHost>
      <Ribs />
    </ToastHost>,
  );
}

beforeEach(() => {
  ribsImpl = async () => [];
  actionCalls.length = 0;
  lastDoc = null;
});

describe("Ribs panel", () => {
  test("renders the rib list with an auth badge", async () => {
    ribsImpl = async () => [
      rib({ id: "osdu", displayName: "OSDU Bridge", auth: { authenticated: true } }),
      rib({ id: "demo", displayName: "Demo", auth: { authenticated: false } }),
    ];
    await renderRibs();
    expect(await screen.findByText("OSDU Bridge")).toBeDefined();
    expect(screen.getByText("Demo")).toBeDefined();
    expect(screen.getByText("Authenticated")).toBeDefined();
    expect(screen.getByText("Needs auth")).toBeDefined();
  });

  test("shows the empty state when no ribs are installed", async () => {
    ribsImpl = async () => [];
    await renderRibs();
    expect(await screen.findByText("No ribs installed")).toBeDefined();
  });

  test("shows an error state when the fetch fails", async () => {
    ribsImpl = async () => {
      throw new Error("boom");
    };
    await renderRibs();
    expect(await screen.findByText("Couldn't load ribs")).toBeDefined();
    expect(screen.getByText("boom")).toBeDefined();
  });

  test("clicking a view descriptor opens it in the canvas via a snapshot source", async () => {
    ribsImpl = async () => [
      rib({
        id: "osdu",
        displayName: "OSDU Bridge",
        views: [{ key: "rib:osdu:graph", canvasKind: "view", title: "Live Graph" }],
      }),
    ];
    await renderRibs();
    fireEvent.click(await screen.findByRole("button", { name: "Live Graph" }));
    expect(lastDoc).toEqual({
      kind: "view",
      source: { type: "snapshot", key: "rib:osdu:graph" },
      title: "Live Graph",
    });
  });

  test("does not render action buttons when the rib has no action handler", async () => {
    ribsImpl = async () => [
      rib({
        id: "osdu",
        displayName: "OSDU Bridge",
        actions: [{ type: "refresh", label: "Refresh data" }],
        hasOnAction: false,
      }),
    ];
    await renderRibs();
    expect(await screen.findByText("OSDU Bridge")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Refresh data" })).toBeNull();
  });

  test("clicking an action posts it to the rib", async () => {
    ribsImpl = async () => [
      rib({
        id: "osdu",
        displayName: "OSDU Bridge",
        actions: [{ type: "refresh", label: "Refresh data" }],
        hasOnAction: true,
      }),
    ];
    await renderRibs();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh data" }));
    await waitFor(() => expect(actionCalls).toHaveLength(1));
    expect(actionCalls[0]).toEqual({ id: "osdu", action: { type: "refresh" } });
  });
});
