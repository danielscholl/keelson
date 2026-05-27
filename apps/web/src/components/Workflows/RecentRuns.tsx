import type {
  Project,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@keelson/shared";
import { useEffect, useState } from "react";

import { deleteWorkflowRun, listRuns } from "../../api.ts";
import type { NodeViewStatus } from "../../lib/dagLayout.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { SkeletonStack } from "../Skeleton.tsx";
import { useToast } from "../Toast.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

// Map the wire-schema run status onto the badge's NodeViewStatus surface.
// `paused` maps to `awaiting` (same magenta accent the per-node awaiting
// badge uses; cf. statusBadgeStatus in RunView.tsx). Without this explicit
// mapping, paused runs would render as `cancelled` and look terminated in
// history even though they're still resumable.
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
  // Catalog drives this — fanning out one listRuns() per workflow is
  // wasteful but matches the current server surface (no aggregate endpoint
  // yet) and avoids needing a backend change for the first cut.
  workflows: ReadonlyArray<WorkflowSummary>;
  onOpenRun: (runId: string, workflowName: string) => void;
  // Optional refresh ticker so a freshly-started run shows up in the list.
  // Caller bumps this when it kicks a new run.
  refreshKey?: number;
  // Bumped after a successful delete so parent state (active runs, badges)
  // stays in sync with the now-shorter history.
  onRunDeleted?: () => void;
  // Projects keyed by id, so each row can show its project label. The
  // parent owns the list — passing a map keeps RecentRuns from fetching
  // /api/projects on its own and dropping cache freshness on every
  // refresh.
  projectsById?: ReadonlyMap<string, Project>;
}

interface RunRow extends WorkflowRunSummary {}

export function RecentRuns({
  workflows,
  onOpenRun,
  refreshKey = 0,
  onRunDeleted,
  projectsById,
}: RecentRunsProps) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RunRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  // Per-workflow fanout failures. We don't bail the whole panel for one
  // bad workflow (other workflows' history is still useful) but the
  // operator needs to know which entries are partial vs. authoritative.
  const [failedWorkflows, setFailedWorkflows] = useState<Array<{ name: string; error: string }>>(
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate refetch trigger from the parent (bumped after run kick / delete); see comment at the dep array below
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setFailedWorkflows([]);
    Promise.all(
      workflows.map((w) =>
        listRuns(w.name).then(
          (runs) => ({ kind: "ok" as const, name: w.name, runs }),
          (err) => ({
            kind: "err" as const,
            name: w.name,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    )
      .then((perWorkflow) => {
        if (cancelled) return;
        const merged: RunRow[] = [];
        const failed: Array<{ name: string; error: string }> = [];
        for (const r of perWorkflow) {
          if (r.kind === "ok") merged.push(...r.runs);
          else failed.push({ name: r.name, error: r.error });
        }
        merged.sort((a, b) => {
          // Newest first by startedAt; the column is ISO so string sort works.
          return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0;
        });
        // Keep the table small — top 20 entries by recency.
        setRows(merged.slice(0, 20));
        setFailedWorkflows(failed);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // `refreshKey` is in the dep list intentionally — the parent bumps it
    // to force a refetch after a run kick or delete, even when the
    // workflows array identity hasn't changed. Biome flags it as "more
    // dependencies than necessary" because the value isn't read inside
    // the effect; we want it watched, not consumed (suppressed above).
  }, [workflows, refreshKey]);

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

  const failureBanner =
    failedWorkflows.length > 0 ? (
      <div className="run-warnings" role="status">
        {failedWorkflows.map((f) => (
          <div key={f.name} className="run-warning-row">
            <span className="run-warning-glyph" aria-hidden="true">
              ⚠
            </span>
            <span>
              <strong>{f.name}</strong> history failed to load: {f.error}
            </span>
          </div>
        ))}
      </div>
    ) : null;

  if (rows.length === 0) {
    return (
      <>
        {failureBanner}
        <div className="empty-state">
          <div className="empty-state-title">No runs yet</div>
          <div className="empty-state-body">Kick a workflow above to populate history.</div>
        </div>
      </>
    );
  }

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      await deleteWorkflowRun(target.runId);
      // Optimistic local drop — the panel feels instant; the parent's
      // onRunDeleted bump re-fetches downstream views (e.g. chat sidebar).
      setRows((prev) => prev?.filter((r) => r.runId !== target.runId) ?? prev);
      onRunDeleted?.();
      setPendingDelete(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({
        kind: "error",
        message: `Couldn't delete ${target.workflowName} run: ${msg}`,
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      {failureBanner}
      <div className="runs-table runs-table--with-project">
        <div className="runs-row head">
          <span />
          <span>Workflow</span>
          <span>Project</span>
          <span>Status</span>
          <span>Duration</span>
          <span>Started</span>
          <span style={{ textAlign: "right" }}>Actions</span>
        </div>
        {rows.map((r) => {
          const openRun = () => onOpenRun(r.runId, r.workflowName);
          const project = r.projectId ? projectsById?.get(r.projectId) : undefined;
          const projectLabel = project?.name ?? (r.workingDir ? "(adhoc)" : "—");
          return (
            // The row is a <div role="button"> rather than a <button> so the
            // delete action inside can be a real nested <button> — nesting
            // interactive elements inside a <button> is invalid HTML.
            // biome-ignore lint/a11y/useSemanticElements: row contains a nested button (delete), so it can't itself be a <button>
            <div
              key={r.runId}
              className="runs-row"
              role="button"
              tabIndex={0}
              onClick={openRun}
              onKeyDown={(e) => {
                // Bail if a nested interactive (the delete <button>, or any
                // future inline action) bubbled this keydown up to us — the
                // native button activation has its own Enter/Space handling
                // and calling preventDefault() here would suppress it.
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openRun();
                }
              }}
            >
              <span />
              <span className="run-name">
                {r.workflowName}
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
    </>
  );
}
