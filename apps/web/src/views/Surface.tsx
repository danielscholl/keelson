// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type CanvasBoardView,
  type CanvasTone,
  canvasViewSchema,
  type OpenChatSeed,
  type RibSurfaceDescriptor,
  ribIdFromKey,
} from "@keelson/shared";
import { useCallback, useState } from "react";
import { BoardActionProvider } from "../components/Canvas/BoardActionContext.tsx";
import { BoardBody, Segments } from "../components/Canvas/BoardView.tsx";
import { useCanvas } from "../components/Canvas/CanvasHost.tsx";
import { SnapshotStateView } from "../components/Canvas/ViewBody.tsx";
import { useAutoRefresh } from "../hooks/useAutoRefresh.ts";
import { useRibActionDispatch } from "../hooks/useRibActionDispatch.ts";
import { useSnapshot } from "../hooks/useSnapshot.ts";
import { useWorkflowTrigger } from "../hooks/useWorkflowTrigger.ts";
import { buildExploreSeed, type ExploreHandler, OPENING_PROMPT } from "../lib/exploreSeed.ts";

interface Region {
  key: string;
  workflow?: string;
  cadenceMs?: number;
  title?: string;
  glyph?: { char: string; tone?: CanvasTone };
  collapsible?: boolean;
  collapsed?: boolean;
}

// A rib's primary surface: region-bound boards laid out as header → banner →
// rows(columns) → footer. Each region owns an independent snapshot subscription
// (live + per-region refresh); the harness carries no rib-specific layout code.
export function Surface({
  descriptor,
  onExplore,
}: {
  descriptor: RibSurfaceDescriptor;
  // Raised when a region's "explore in chat" control fires, carrying the seed
  // built from that region's current snapshot. App hands it to the Chat view.
  onExplore?: ExploreHandler;
}) {
  const { header, banner, rows, footer } = descriptor.layout;
  return (
    <div className="page surface-page">
      {/* Role-prefixed keys so a region remounts (re-reads its initial collapsed
          flag) if the descriptor swaps it for a different one at this slot. */}
      {header && (
        <SurfaceRegion key={`header:${header.key}`} region={header} onExplore={onExplore} />
      )}
      {banner && (
        <SurfaceRegion key={`banner:${banner.key}`} region={banner} onExplore={onExplore} />
      )}
      {rows.map((row, rowIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: surface rows are a static descriptor array (never reordered), so the index is a stable, collision-free key — region keys are unconstrained and could collide if joined.
        <div className="surface-row" key={`row:${rowIndex}`}>
          {row.columns.map((col) => (
            <SurfaceRegion key={col.key} region={col} onExplore={onExplore} />
          ))}
        </div>
      ))}
      {footer && (
        <SurfaceRegion key={`footer:${footer.key}`} region={footer} onExplore={onExplore} />
      )}
    </div>
  );
}

function SurfaceRegion({ region, onExplore }: { region: Region; onExplore?: ExploreHandler }) {
  const collapsible = region.collapsible ?? false;
  const [collapsed, setCollapsed] = useState(collapsible ? (region.collapsed ?? false) : false);
  const snap = useSnapshot(region.key);
  const { openCanvas } = useCanvas();
  const ribId = ribIdFromKey(region.key);

  // The region's bound workflow re-runs on its cadence and on open while stale;
  // the new frame arrives over the live subscription. `freshness` is the head's
  // "updated Xm ago" readout — there is no manual per-region refresh control.
  const runRefresh = useWorkflowTrigger(region.workflow);
  const busy = runRefresh.running;
  const freshness = useAutoRefresh({
    workflow: region.workflow,
    cadenceMs: region.cadenceMs,
    status: snap.status,
    composedAt: snap.composedAt,
    running: runRefresh.running,
    error: runRefresh.error,
    trigger: runRefresh.trigger,
  });

  // Board actions dispatch to the region's owning rib; on success re-run the
  // bound workflow so the board reflects the new state (a plain frame re-read
  // would show pre-action state). null ribId → no provider → buttons disabled.
  const reload = snap.reload;
  const onSuccess = useCallback(
    () => (region.workflow ? runRefresh.trigger() : reload()),
    [region.workflow, runRefresh.trigger, reload],
  );
  // An open-chat directive rides the same panel→chat path as the ✦ button; a
  // missing openingPrompt defaults to the hidden seeded-opening sentinel.
  const onOpenChat = useCallback(
    (seed: OpenChatSeed) =>
      onExplore?.({
        systemPrompt: seed.systemPrompt,
        name: seed.name,
        openingPrompt: seed.openingPrompt ?? OPENING_PROMPT,
      }),
    [onExplore],
  );
  // Only wire onOpenChat when onExplore exists; otherwise the dispatch would
  // intercept an open-chat directive, no-op, and swallow the normal success path.
  const actions = useRibActionDispatch(ribId, {
    onSuccess,
    onOpenChat: onExplore ? onOpenChat : undefined,
  });

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
      {(region.title ?? board?.title) && (
        <span className="surface-region-title">{region.title ?? board?.title}</span>
      )}
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
      {freshness.label && (
        <span
          className="surface-region-freshness"
          data-tone={freshness.tone ?? undefined}
          title={runRefresh.error ?? undefined}
        >
          {freshness.label}
        </span>
      )}
      {snap.status === "live" && onExplore && (
        <button
          type="button"
          className="surface-region-action surface-region-icon"
          onClick={() =>
            onExplore(buildExploreSeed(board?.title ?? region.title ?? region.key, snap.data))
          }
          aria-label="Explore in chat"
          title="Explore this in chat"
        >
          <span aria-hidden="true">✦</span>
        </button>
      )}
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

  // A region with a bound workflow but no cadence never auto-runs, so an empty
  // key would otherwise shimmer "Loading…" forever. Once hydrated-empty (and not
  // mid-run) offer a one-shot manual load instead of a perpetual skeleton.
  const idle = snap.status === "empty" && !busy && Boolean(region.workflow) && !region.cadenceMs;

  const body = board ? (
    <BoardBody view={board} />
  ) : idle ? (
    <RegionIdle onLoad={runRefresh.trigger} error={runRefresh.error} />
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

// The on-demand resting state for a workflow-bound, cadence-free region: a quiet
// note and a one-shot run control, rather than a skeleton that implies a load is
// already underway. A failed prior run surfaces here (a no-cadence region has no
// freshness label to carry it) so the operator knows the Load didn't take.
function RegionIdle({ onLoad, error }: { onLoad: () => void; error?: string | null }) {
  return (
    <div className="surface-region-idle">
      <p className="surface-region-idle-note">
        {error ? `Load failed: ${error}` : "Not loaded yet — this panel runs on demand."}
      </p>
      <button type="button" className="surface-region-action" onClick={onLoad}>
        {error ? "Retry" : "Load"}
      </button>
    </div>
  );
}
