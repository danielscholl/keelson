// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type CanvasBoardView,
  type CanvasTone,
  canvasViewSchema,
  type RibSurfaceDescriptor,
  ribIdFromKey,
} from "@keelson/shared";
import { useCallback, useState } from "react";
import { BoardActionProvider } from "../components/Canvas/BoardActionContext.tsx";
import { BoardBody, Segments } from "../components/Canvas/BoardView.tsx";
import { useCanvas } from "../components/Canvas/CanvasHost.tsx";
import { SnapshotStateView } from "../components/Canvas/ViewBody.tsx";
import { useRibActionDispatch } from "../hooks/useRibActionDispatch.ts";
import { useSnapshot } from "../hooks/useSnapshot.ts";
import { useWorkflowTrigger } from "../hooks/useWorkflowTrigger.ts";

interface Region {
  key: string;
  workflow?: string;
  title?: string;
  glyph?: { char: string; tone?: CanvasTone };
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
  const ribId = ribIdFromKey(region.key);

  // Board actions dispatch to the region's owning rib; on success re-hydrate so
  // the board reflects the new state (the producing workflow recompose is
  // server-side). null ribId → no provider → buttons render disabled.
  const reload = snap.reload;
  const onSuccess = useCallback(() => reload(), [reload]);
  const actions = useRibActionDispatch(ribId, { onSuccess });

  // Refresh re-runs the region's bound workflow (repopulating its key) when one
  // is declared; otherwise it re-reads the cached frame. The run's new frame
  // arrives over the live subscription, so there's no manual reload to chase.
  const runRefresh = useWorkflowTrigger(region.workflow);
  const busy = runRefresh.running;
  const onRefresh = region.workflow ? runRefresh.trigger : snap.reload;

  const parsed = snap.status === "live" ? canvasViewSchema.safeParse(snap.data) : null;
  const board: CanvasBoardView | null =
    parsed?.success && parsed.data.view === "board" ? parsed.data : null;

  const expand = () =>
    openCanvas({
      kind: "view",
      source: { type: "snapshot", key: region.key },
      ...(board?.title ? { title: board.title } : {}),
    });

  // The gradient lane head: static identity (glyph + title) the rib supplies,
  // plus the board's live status/scope/pulse, and the region's own controls.
  const head = (
    <div className="surface-region-head">
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
      {region.glyph && (
        <span
          className="surface-region-glyph-chip"
          data-tone={region.glyph.tone}
          aria-hidden="true"
        >
          {region.glyph.char}
        </span>
      )}
      {region.title && <span className="surface-region-title">{region.title}</span>}
      {board?.header?.status && (
        <span className="cvb-header-status" data-tone={board.header.status.tone}>
          {board.header.status.label}
        </span>
      )}
      {board?.header?.chip && (
        <span className="cvb-chip surface-region-scope">{board.header.chip}</span>
      )}
      {board?.header?.segments && board.header.segments.length > 0 && (
        <Segments items={board.header.segments} />
      )}
      <span className="surface-region-spacer" />
      {runRefresh.error && (
        <span className="surface-region-error" title={runRefresh.error}>
          Refresh failed
        </span>
      )}
      <button
        type="button"
        className="surface-region-action surface-region-icon"
        onClick={onRefresh}
        disabled={busy}
        aria-label="Refresh"
        title={region.workflow ? "Refresh (re-run workflow)" : "Refresh this region"}
      >
        <span className={`surface-region-glyph${busy ? " is-spinning" : ""}`} aria-hidden="true">
          ↻
        </span>
      </button>
      <button
        type="button"
        className="surface-region-action surface-region-icon"
        onClick={expand}
        aria-label="Expand"
        title="Open full view"
      >
        <span aria-hidden="true">⤢</span>
      </button>
    </div>
  );

  const body = board ? (
    <BoardBody view={board} />
  ) : (
    <SnapshotStateView snapshot={snap} busy={busy} />
  );

  return (
    <section className="surface-region" data-collapsed={collapsed || undefined}>
      {head}
      {!collapsed &&
        (ribId ? (
          <div className="surface-region-body">
            <BoardActionProvider run={actions.run} reveal={actions.reveal}>
              {body}
            </BoardActionProvider>
          </div>
        ) : (
          <div className="surface-region-body">{body}</div>
        ))}
    </section>
  );
}
