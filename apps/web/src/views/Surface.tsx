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
import { useCallback, useEffect, useState } from "react";
import { postRibAction } from "../api.ts";
import { BoardActionProvider } from "../components/Canvas/BoardActionContext.tsx";
import { BoardBody, Segments } from "../components/Canvas/BoardView.tsx";
import { useCanvas } from "../components/Canvas/CanvasHost.tsx";
import { SnapshotStateView } from "../components/Canvas/ViewBody.tsx";
import { ProjectChip } from "../components/Chat/ProjectChip.tsx";
import { ProjectPickerPopover } from "../components/Chat/ProjectPickerPopover.tsx";
import { useCanvasKindForKey } from "../components/RibsProvider.tsx";
import { useActiveProject } from "../hooks/useActiveProject.ts";
import { useAutoRefresh } from "../hooks/useAutoRefresh.ts";
import { useRibActionDispatch } from "../hooks/useRibActionDispatch.ts";
import { useSnapshot } from "../hooks/useSnapshot.ts";
import { useStreamingPulse } from "../hooks/useStreamingPulse.ts";
import { useWorkflowTrigger } from "../hooks/useWorkflowTrigger.ts";
import { buildExploreSeed, type ExploreHandler, OPENING_PROMPT } from "../lib/exploreSeed.ts";

// A run-workflow directive may ask to stay on the current surface (see the `stay`
// field on the run-workflow client effect), so the shared callback carries it.
type LaunchWorkflow = (
  workflow: string,
  args: Record<string, string>,
  stay?: boolean,
) => void | Promise<void>;

interface Region {
  key: string;
  workflow?: string;
  cadenceMs?: number;
  title?: string;
  byline?: string;
  glyph?: { char: string; tone?: CanvasTone };
  collapsible?: boolean;
  collapsed?: boolean;
  live?: boolean;
}

// A rib's primary surface: region-bound boards laid out as header → banner →
// rows(columns) → footer. Each region owns an independent snapshot subscription
// (live + per-region refresh); the harness carries no rib-specific layout code.
export function Surface({
  descriptor,
  onExplore,
  onLaunchWorkflow,
}: {
  descriptor: RibSurfaceDescriptor;
  // Raised when a region's "explore in chat" control fires, carrying the seed
  // built from that region's current snapshot. App hands it to the Chat view.
  onExplore?: ExploreHandler;
  // Raised when a board action returns a run-workflow directive; App launches
  // the run and (unless `stay`) focuses the Workflows tab.
  onLaunchWorkflow?: LaunchWorkflow;
}) {
  const { header, banner, rows, footer } = descriptor.layout;
  // A projectScoped surface carries the shared project chip in its header, wired to
  // the owning rib's select-project action; derive the rib id from a region key
  // (every region key is rib-namespaced).
  const ribId = ribIdFromKey(
    header?.key ?? banner?.key ?? rows[0]?.columns[0]?.key ?? footer?.key ?? "",
  );
  return (
    <div className="page surface-page">
      {(descriptor.title || descriptor.subtitle || descriptor.projectScoped) && (
        <header className="surface-identity">
          <div className="surface-identity-text">
            {descriptor.title && <h1 className="surface-identity-title">{descriptor.title}</h1>}
            {descriptor.subtitle && (
              <p className="surface-identity-subtitle">{descriptor.subtitle}</p>
            )}
          </div>
          {descriptor.projectScoped && ribId && (
            <SurfaceProjectPicker
              ribId={ribId}
              popoverId={`surface-project-picker-${descriptor.id}`}
            />
          )}
        </header>
      )}
      {/* Role-prefixed keys so a region remounts (re-reads its initial collapsed
          flag) if the descriptor swaps it for a different one at this slot. */}
      {header && (
        <SurfaceRegion
          key={`header:${header.key}`}
          region={header}
          onExplore={onExplore}
          onLaunchWorkflow={onLaunchWorkflow}
        />
      )}
      {banner && (
        <SurfaceRegion
          key={`banner:${banner.key}`}
          region={banner}
          onExplore={onExplore}
          onLaunchWorkflow={onLaunchWorkflow}
        />
      )}
      {groupRowsByZone(rows).map((zone) => (
        <section className="surface-zone" key={`zone:${zone.start}`}>
          {zone.title && <h2 className="surface-zone-title">{zone.title}</h2>}
          {zone.rows.map((row, rowIndex) => (
            // Surface rows are a static descriptor array (never reordered), so the
            // row's position is a stable, collision-free key — region keys are
            // unconstrained and could collide if joined.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            <div className="surface-row" key={`row:${zone.start + rowIndex}`}>
              {row.columns.map((col) => (
                <SurfaceRegion
                  key={col.key}
                  region={col}
                  onExplore={onExplore}
                  onLaunchWorkflow={onLaunchWorkflow}
                />
              ))}
            </div>
          ))}
        </section>
      ))}
      {footer && (
        <SurfaceRegion
          key={`footer:${footer.key}`}
          region={footer}
          onExplore={onExplore}
          onLaunchWorkflow={onLaunchWorkflow}
        />
      )}
    </div>
  );
}

type SurfaceRow = RibSurfaceDescriptor["layout"]["rows"][number];

// Fold the flat row list into zones: a run of consecutive rows sharing a
// `zoneTitle` renders under one heading; title-less rows each stand alone (no
// wrapper heading), preserving the pre-zone layout for surfaces that set none.
function groupRowsByZone(
  rows: readonly SurfaceRow[],
): { start: number; title?: string; rows: SurfaceRow[] }[] {
  const zones: { start: number; title?: string; rows: SurfaceRow[] }[] = [];
  rows.forEach((row, index) => {
    const last = zones.at(-1);
    if (row.zoneTitle && last?.title === row.zoneTitle) {
      last.rows.push(row);
      return;
    }
    zones.push({ start: index, rows: [row], ...(row.zoneTitle ? { title: row.zoneTitle } : {}) });
  });
  return zones;
}

function SurfaceRegion({
  region,
  onExplore,
  onLaunchWorkflow,
}: {
  region: Region;
  onExplore?: ExploreHandler;
  onLaunchWorkflow?: LaunchWorkflow;
}) {
  const collapsible = region.collapsible ?? false;
  const [collapsed, setCollapsed] = useState(collapsible ? (region.collapsed ?? false) : false);
  const snap = useSnapshot(region.key);
  // Lights only while frames actively stream in on the key — distinct from the
  // cadence-derived "updated Xm ago" freshness label.
  const streaming = useStreamingPulse(snap.version, region.live ?? false);
  const { openCanvas } = useCanvas();
  const resolveCanvasKind = useCanvasKindForKey();
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
        ...(seed.model ? { model: seed.model } : {}),
        ...(seed.providerId ? { providerId: seed.providerId } : {}),
      }),
    [onExplore],
  );
  // An open-canvas directive opens that snapshot's board in the drawer — the same
  // doc expand() builds. Pass the effect handlers into the OPENED doc's opts so a
  // board action inside the opened canvas behaves like inline (as expand() does).
  const onOpenCanvas = useCallback(
    (key: string, title?: string) =>
      openCanvas(
        {
          kind: resolveCanvasKind(key),
          source: { type: "snapshot", key },
          ...(title ? { title } : {}),
        },
        { onOpenChat, ...(onLaunchWorkflow ? { onLaunchWorkflow } : {}) },
      ),
    [openCanvas, onOpenChat, onLaunchWorkflow, resolveCanvasKind],
  );
  // Only wire onOpenChat when onExplore exists; otherwise the dispatch would
  // intercept an open-chat directive, no-op, and swallow the normal success path.
  // onLaunchWorkflow follows the same only-wire-when-available rule. openCanvas is
  // always available here, so onOpenCanvas wires unconditionally.
  const actions = useRibActionDispatch(ribId, {
    onSuccess,
    onOpenChat: onExplore ? onOpenChat : undefined,
    ...(onLaunchWorkflow ? { onLaunchWorkflow } : {}),
    onOpenCanvas,
  });

  const parsed = snap.status === "live" ? canvasViewSchema.safeParse(snap.data) : null;
  const board: CanvasBoardView | null =
    parsed?.success && parsed.data.view === "board" ? parsed.data : null;

  const expand = () =>
    openCanvas(
      {
        kind: resolveCanvasKind(region.key),
        source: { type: "snapshot", key: region.key },
        ...(board?.title ? { title: board.title } : {}),
      },
      // So an Enter/launch button clicked in the expanded drawer behaves the same
      // way it does inline, instead of being swallowed with a success toast.
      { onOpenChat, ...(onLaunchWorkflow ? { onLaunchWorkflow } : {}) },
    );

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
        <span className="surface-region-identity">
          <span className="surface-region-title">{region.title ?? board?.title}</span>
          {region.byline && <span className="surface-region-byline">{region.byline}</span>}
        </span>
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
      {region.live && (
        <span
          className="surface-region-live"
          role="img"
          data-streaming={streaming || undefined}
          title={streaming ? "Live — streaming now" : "Live region"}
          aria-label={streaming ? "Live, streaming now" : "Live region, idle"}
        />
      )}
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

// The surface header's project picker for a projectScoped surface: the same
// ProjectChip + ProjectPickerPopover the Chat and Workflows surfaces use, driven by
// the global active project. The rib maps its own default project to its flat scope.
function SurfaceProjectPicker({ ribId, popoverId }: { ribId: string; popoverId: string }) {
  const { projects, activeProject, activeProjectId, explicitProjectId, setActiveProject, refresh } =
    useActiveProject();
  useEffect(() => {
    // Sync the rib's scope from the EXPLICIT stored selection — not the fallback-
    // resolved active project, which would post a transient "default" before the
    // project list hydrates and momentarily clobber the scope. Skip when there's no
    // explicit selection, so viewing the surface never overwrites a scope set
    // out-of-band (e.g. via the CLI).
    if (!explicitProjectId) return;
    void postRibAction(ribId, {
      type: "select-project",
      payload: { scopeId: explicitProjectId },
    }).catch(() => {});
  }, [ribId, explicitProjectId]);
  return (
    <>
      <ProjectChip projectName={activeProject?.name ?? "default"} popoverId={popoverId} />
      <ProjectPickerPopover
        popoverId={popoverId}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelect={setActiveProject}
        onProjectUpdated={() => void refresh()}
        onProjectDeleted={(deletedId) => {
          void refresh();
          if (activeProjectId === deletedId) setActiveProject(null);
        }}
      />
    </>
  );
}
