// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type CanvasBoardView,
  canvasViewSchema,
  type RibAction,
  type RibActionResult,
  type RibSurfaceDescriptor,
  ribIdFromKey,
} from "@keelson/shared";
import { useCallback, useState } from "react";
import { postRibAction } from "../api.ts";
import { BoardActionProvider } from "../components/Canvas/BoardActionContext.tsx";
import { BoardHeader } from "../components/Canvas/BoardView.tsx";
import { useCanvas } from "../components/Canvas/CanvasHost.tsx";
import { SnapshotStateView } from "../components/Canvas/ViewBody.tsx";
import { useToast } from "../components/Toast.tsx";
import { useSnapshot } from "../hooks/useSnapshot.ts";

interface Region {
  key: string;
  collapsible?: boolean;
  collapsed?: boolean;
}

// A rib's primary surface: region-bound boards laid out as header → banner →
// rows(columns) → footer. Each region owns an independent snapshot subscription
// (live + per-region refresh); the harness carries no rib-specific layout code.
export function Surface({ descriptor }: { descriptor: RibSurfaceDescriptor }) {
  const { header, banner, rows, footer } = descriptor.layout;
  return (
    <div className="page surface-page">
      {/* Role-prefixed keys so a region remounts (re-reads its initial collapsed
          flag) if the descriptor swaps it for a different one at this slot. */}
      {header && <SurfaceRegion key={`header:${header.key}`} region={header} />}
      {banner && <SurfaceRegion key={`banner:${banner.key}`} region={banner} />}
      {rows.map((row, rowIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: surface rows are a static descriptor array (never reordered), so the index is a stable, collision-free key — region keys are unconstrained and could collide if joined.
        <div className="surface-row" key={`row:${rowIndex}`}>
          {row.columns.map((col) => (
            <SurfaceRegion key={col.key} region={col} />
          ))}
        </div>
      ))}
      {footer && <SurfaceRegion key={`footer:${footer.key}`} region={footer} />}
    </div>
  );
}

function SurfaceRegion({ region }: { region: Region }) {
  const collapsible = region.collapsible ?? false;
  const [collapsed, setCollapsed] = useState(collapsible ? (region.collapsed ?? false) : false);
  const snap = useSnapshot(region.key);
  const { openCanvas } = useCanvas();
  const toast = useToast();
  const ribId = ribIdFromKey(region.key);

  // Board actions dispatch to the region's owning rib; on success re-hydrate so
  // the board reflects the new state (the producing workflow recompose is
  // server-side). null ribId → no provider → buttons render disabled.
  const dispatch = useCallback(
    async (action: RibAction): Promise<RibActionResult> => {
      if (!ribId) return { ok: false, error: "region key is not rib-namespaced" };
      try {
        const result = await postRibAction(ribId, action);
        if (result.ok) {
          toast.push({ kind: "ok", message: `${action.type} ✓` });
          snap.reload();
        } else {
          toast.push({ kind: "error", message: `${action.type}: ${result.error}` });
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.push({ kind: "error", message: `${action.type} failed: ${message}` });
        return { ok: false, error: message };
      }
    },
    [ribId, snap.reload, toast],
  );

  const parsed = snap.status === "live" ? canvasViewSchema.safeParse(snap.data) : null;
  const board: CanvasBoardView | null =
    parsed?.success && parsed.data.view === "board" ? parsed.data : null;

  const expand = () =>
    openCanvas({
      kind: "view",
      source: { type: "snapshot", key: region.key },
      ...(board?.title ? { title: board.title } : {}),
    });

  return (
    <section className="surface-region" data-collapsed={collapsed || undefined}>
      <div className="surface-region-bar">
        {collapsible && (
          <button
            type="button"
            className="surface-region-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand region" : "Collapse region"}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        )}
        <span className="surface-region-spacer" />
        <button
          type="button"
          className="surface-region-action"
          onClick={snap.reload}
          title="Refresh this region"
        >
          Refresh
        </button>
        <button
          type="button"
          className="surface-region-action"
          onClick={expand}
          title="Open full view"
        >
          Expand
        </button>
      </div>
      {collapsed ? (
        board ? (
          <BoardHeader view={board} />
        ) : (
          <p className="canvas-drawer-note">Collapsed.</p>
        )
      ) : ribId ? (
        <BoardActionProvider dispatch={dispatch}>
          <SnapshotStateView snapshot={snap} />
        </BoardActionProvider>
      ) : (
        <SnapshotStateView snapshot={snap} />
      )}
    </section>
  );
}
