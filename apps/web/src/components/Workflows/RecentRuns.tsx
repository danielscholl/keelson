import type {
  Project,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@keelson/shared";
import { useEffect, useMemo, useState } from "react";

import { bulkDeleteWorkflowRuns, deleteWorkflowRun, listWorkflowRuns } from "../../api.ts";
import { useSettings } from "../../hooks/useSettings.ts";
import type { NodeViewStatus } from "../../lib/dagLayout.ts";
import { visibleRuns } from "../../lib/rib.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { SkeletonStack } from "../Skeleton.tsx";
import { useToast } from "../Toast.tsx";
import { RibBadge } from "./RibBadge.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

// Poll so runs started outside the UI (e.g. via the keelson CLI, or the
// heartbeat) appear and advance status without a manual refresh.
const RUNS_POLL_INTERVAL_MS = 4000;
const RUNS_FEED_LIMIT = 50;

function badgeStatusFor(s: WorkflowRunStatus): NodeViewStatus | "running" {
  switch (s) {
    case "running":
      return "running";
    case "paused":
      return "awaiting";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "";
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const ms = end - start;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatStarted(startedAt: string): string {
  const ms = Date.parse(startedAt);
  if (!Number.isFinite(ms)) return startedAt;
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
}

export interface RecentRunsProps {
  // The catalog — used to map a run's ribId to the rib's display name for the
  // row badge. No longer drives fetching (the feed is a single endpoint).
  workflows: ReadonlyArray<WorkflowSummary>;
  onOpenRun: (runId: string, workflowName: string) => void;
  refreshKey?: number;
  onRunDeleted?: () => void;
  projectsById?: ReadonlyMap<string, Project>;
}

type RunRow = WorkflowRunSummary;

export function RecentRuns({
  workflows,
  onOpenRun,
  refreshKey = 0,
  onRunDeleted,
  projectsById,
}: RecentRunsProps) {
  const { settings, setShowScheduledRuns, isWorkflowSourceHidden } = useSettings();
  const showScheduled = settings.showScheduledRuns ?? false;
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<RunRow | null>(null);
  const [pendingBulk, setPendingBulk] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();

  // ribId → display name, from the catalog, so a run row can label its origin
  // rib. Falls back to the raw id for a run whose rib was since removed.
  const ribNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workflows) {
      if (w.source.kind === "rib" && w.source.ribId) {
        m.set(w.source.ribId, w.source.ribName ?? w.source.ribId);
      }
    }
    return m;
  }, [workflows]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate refetch trigger from the parent (bumped after run kick / delete)
  useEffect(() => {
    let cancelled = false;
    let running = false;

    const fetchRuns = () => {
      if (running) return;
      running = true;
      // Default feed is manual-only; revealing scheduled runs drops the filter
      // so both surface together.
      listWorkflowRuns({
        ...(showScheduled ? {} : { origin: "manual" }),
        limit: RUNS_FEED_LIMIT,
      })
        .then((runs) => {
          if (cancelled) return;
          setRows(runs);
          // Drop selections for runs that no longer exist.
          setSelected((prev) => {
            const live = new Set(runs.map((r) => r.runId));
            const next = new Set([...prev].filter((id) => live.has(id)));
            return next.size === prev.size ? prev : next;
          });
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          running = false;
        });
    };

    fetchRuns();
    const timer = setInterval(fetchRuns, RUNS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshKey, showScheduled]);

  if (rows === null) {
    return (
      <div className="runs-table">
        <SkeletonStack rows={3} height="42px" />
      </div>
    );
  }
  if (error) {
    return <div className="empty-state">Failed to load run history: {error}</div>;
  }

  // Honor the same per-rib hide the catalog uses (view-only): a hidden rib's
  // runs drop out of the feed too, so hiding declutters the list AND the runs.
  const visibleRows = visibleRuns(rows, isWorkflowSourceHidden);
  const hiddenByRib = rows.length - visibleRows.length;

  const scheduledToggle = (
    <label className="bg-toggle">
      <input
        type="checkbox"
        checked={showScheduled}
        onChange={(e) => setShowScheduledRuns(e.target.checked)}
      />
      Show scheduled
    </label>
  );

  if (visibleRows.length === 0) {
    return (
      <>
        <div className="runs-toolbar">{scheduledToggle}</div>
        <div className="empty-state">
          <div className="empty-state-title">No runs yet</div>
          <div className="empty-state-body">
            {hiddenByRib > 0
              ? `${hiddenByRib} run${hiddenByRib === 1 ? "" : "s"} hidden by a rib filter. Show the rib in the catalog to see them.`
              : showScheduled
                ? "Kick a workflow above to populate history."
                : "No manual runs yet. Kick a workflow above, or enable “Show scheduled” to see background refreshes."}
          </div>
        </div>
      </>
    );
  }

  const allSelected = visibleRows.every((r) => selected.has(r.runId));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(visibleRows.map((r) => r.runId)));
  };
  const toggleOne = (runId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      await deleteWorkflowRun(target.runId);
      setRows((prev) => prev?.filter((r) => r.runId !== target.runId) ?? prev);
      onRunDeleted?.();
      setPendingDelete(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({ kind: "error", message: `Couldn't delete ${target.workflowName} run: ${msg}` });
    } finally {
      setDeleting(false);
    }
  };

  const handleConfirmBulk = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);
    try {
      const deleted = await bulkDeleteWorkflowRuns({ runIds: ids });
      const removed = new Set(ids);
      setRows((prev) => prev?.filter((r) => !removed.has(r.runId)) ?? prev);
      setSelected(new Set());
      onRunDeleted?.();
      setPendingBulk(false);
      toast.push({ kind: "info", message: `Deleted ${deleted} run${deleted === 1 ? "" : "s"}.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({ kind: "error", message: `Bulk delete failed: ${msg}` });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="runs-toolbar">
        {selected.size > 0 ? (
          <div className="bulk-bar">
            <span>{selected.size} selected</span>
            <button type="button" className="btn-danger-sm" onClick={() => setPendingBulk(true)}>
              Delete selected
            </button>
            <button type="button" className="btn-ghost-sm" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        ) : (
          <span className="runs-hint">Select rows to delete in bulk</span>
        )}
        {scheduledToggle}
      </div>
      <div className="runs-table runs-table--with-project">
        <div className="runs-row head">
          <span>
            <input
              type="checkbox"
              aria-label="Select all runs"
              checked={allSelected}
              onChange={toggleAll}
            />
          </span>
          <span>Workflow</span>
          <span>Project</span>
          <span>Status</span>
          <span>Duration</span>
          <span>Started</span>
          <span style={{ textAlign: "right" }}>Actions</span>
        </div>
        {visibleRows.map((r) => {
          const openRun = () => onOpenRun(r.runId, r.workflowName);
          const project = r.projectId ? projectsById?.get(r.projectId) : undefined;
          const projectLabel =
            project?.name ?? (r.projectId ? "(deleted project)" : r.workingDir ? "(adhoc)" : "—");
          const checked = selected.has(r.runId);
          return (
            // biome-ignore lint/a11y/useSemanticElements: row contains nested buttons/checkbox, so it can't itself be a <button>
            <div
              key={r.runId}
              className={`runs-row${checked ? " is-selected" : ""}`}
              role="button"
              tabIndex={0}
              onClick={openRun}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openRun();
                }
              }}
            >
              <span>
                <input
                  type="checkbox"
                  aria-label={`Select ${r.workflowName} run ${r.runId.slice(0, 8)}`}
                  checked={checked}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleOne(r.runId)}
                />
              </span>
              <span className="run-name">
                <span className="run-name-row">
                  {r.workflowName}
                  {r.ribId && <RibBadge ribId={r.ribId} label={ribNames.get(r.ribId)} />}
                  {r.origin === "scheduled" && (
                    <span className="run-origin-pill" title="Background producer run">
                      scheduled
                    </span>
                  )}
                </span>
                <small>{r.runId.slice(0, 8)}</small>
              </span>
              <span className="run-project" title={r.workingDir ?? project?.rootPath ?? ""}>
                {projectLabel}
                {r.worktreePath && (
                  <em className="run-isolated" title={r.worktreePath}>
                    {" "}
                    · isolated
                  </em>
                )}
              </span>
              <span>
                <StatusBadge status={badgeStatusFor(r.status)} />
              </span>
              <span className="run-dur">{formatDuration(r.startedAt, r.completedAt)}</span>
              <span className="run-time">{formatStarted(r.startedAt)}</span>
              <span className="actions">
                <button
                  type="button"
                  className="icon-btn danger"
                  aria-label={`Delete ${r.workflowName} run ${r.runId.slice(0, 8)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(r);
                  }}
                >
                  🗑
                </button>
                <span className="icon-btn" aria-hidden="true">
                  View →
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete workflow run"
        body={
          pendingDelete ? (
            <>
              Delete the <strong>{pendingDelete.workflowName}</strong> run{" "}
              <code>{pendingDelete.runId.slice(0, 8)}</code>? This removes it from history and
              deletes its linked chat conversation. A still-running run is cancelled first.
            </>
          ) : null
        }
        mode={{ kind: "simple" }}
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
      />
      <ConfirmModal
        open={pendingBulk}
        title="Delete selected runs"
        body={
          <>
            Delete <strong>{selected.size}</strong> run{selected.size === 1 ? "" : "s"}? This
            removes them from history and deletes their linked chat conversations. Still-running
            runs are cancelled first.
          </>
        }
        mode={{ kind: "simple" }}
        confirmLabel={deleting ? "Deleting…" : `Delete ${selected.size}`}
        danger
        onConfirm={handleConfirmBulk}
        onCancel={() => {
          if (!deleting) setPendingBulk(false);
        }}
      />
    </>
  );
}
