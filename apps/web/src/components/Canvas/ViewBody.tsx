import { type CanvasSource, type CanvasView, canvasViewSchema } from "@keelson/shared";
import { type SnapshotState, useSnapshot } from "../../hooks/useSnapshot.ts";
import { BoardView } from "./BoardView.tsx";
import { GraphView } from "./GraphView.tsx";
import { TableView } from "./TableView.tsx";

// Closed catalog: a `view` discriminant maps to exactly one renderer. A new
// view variant in canvasViewSchema makes the switch a compile error here.
function renderView(view: CanvasView) {
  switch (view.view) {
    case "table":
      return <TableView view={view} />;
    case "graph":
      return <GraphView view={view} />;
    case "board":
      return <BoardView view={view} />;
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

// Fail-closed gate: structured data is validated against canvasViewSchema
// before any typed renderer touches it. Invalid data renders a note, never a
// trusted component over an unvalidated shape.
export function ViewFromData({ data }: { data: unknown }) {
  const parsed = canvasViewSchema.safeParse(data);
  if (!parsed.success) {
    return (
      <p className="canvas-drawer-note canvas-drawer-error">
        This view couldn't be rendered — the data didn't match a known view type.
      </p>
    );
  }
  return renderView(parsed.data);
}

// A shimmer placeholder shown while a panel has no data yet (initial load, a
// never-run key, or a refresh run in flight). Sized to roughly approximate a
// board so the skeleton → data swap doesn't reflow.
function CanvasSkeleton({ label }: { label: string }) {
  return (
    <div className="cv-skeleton" role="status" aria-live="polite" aria-label={label}>
      <div className="cv-skeleton-stats">
        <span className="cv-skeleton-bar cv-skeleton-tile" />
        <span className="cv-skeleton-bar cv-skeleton-tile" />
        <span className="cv-skeleton-bar cv-skeleton-tile" />
      </div>
      <span className="cv-skeleton-bar cv-skeleton-line" />
      <span className="cv-skeleton-bar cv-skeleton-line cv-skeleton-line--short" />
      <span className="cv-skeleton-bar cv-skeleton-line" />
    </div>
  );
}

// Renders an already-subscribed snapshot's status → view. Split out so a caller
// holding its own `useSnapshot` state (a surface region) can render the same
// loading/error/empty/live treatment without opening a second subscription.
// `busy` (a refresh run in flight) shows the skeleton only when there's no data
// to keep — an in-place re-refresh keeps the current board and spins its icon.
export function SnapshotStateView({ snapshot, busy }: { snapshot: SnapshotState; busy?: boolean }) {
  if (snapshot.status === "error") {
    return <p className="canvas-drawer-note canvas-drawer-error">Failed to load this snapshot.</p>;
  }
  if (snapshot.status === "live") {
    return <ViewFromData data={snapshot.data} />;
  }
  return <CanvasSkeleton label={busy ? "Running…" : "Loading…"} />;
}

function SnapshotView({ snapshotKey }: { snapshotKey: string }) {
  const snapshot = useSnapshot(snapshotKey);
  return <SnapshotStateView snapshot={snapshot} />;
}

// Renders a `kind: "view"` canvas. A view needs structured JSON, so it binds to
// a snapshot (live) or inline (static JSON text) source; an artifact (a file
// path) isn't a view source.
export function ViewBody({ source }: { source: CanvasSource }) {
  if (source.type === "snapshot") {
    return <SnapshotView snapshotKey={source.key} />;
  }
  if (source.type === "inline") {
    let data: unknown;
    try {
      data = JSON.parse(source.text);
    } catch {
      return (
        <p className="canvas-drawer-note canvas-drawer-error">
          This view couldn't be rendered — the inline data wasn't valid JSON.
        </p>
      );
    }
    return <ViewFromData data={data} />;
  }
  return <p className="canvas-drawer-note">A 'view' canvas needs a snapshot or inline source.</p>;
}
