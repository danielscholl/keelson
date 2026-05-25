import type { WorkflowDetail } from "@keelson/shared";
import { useEffect, useMemo, useState } from "react";
import { type NodeView, useWorkflowRun } from "../../hooks/useWorkflowRun.ts";
import type { NodeViewStatus } from "../../lib/dagLayout.ts";
import { DagGraph } from "./DagGraph.tsx";
import { fallbackStatusFromRun, RunTrace } from "./RunTrace.tsx";
import { StartComposer } from "./StartComposer.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function statusBadgeStatus(
  s: "loading" | "unknown" | "running" | "paused" | "succeeded" | "failed" | "cancelled",
): NodeViewStatus | "pending" | "running" {
  if (s === "loading" || s === "unknown") return "pending";
  // Run-level `paused` (W4.6) reuses the node-level `awaiting` badge color
  // since the mockup paints both with the same magenta accent.
  if (s === "paused") return "awaiting";
  return s;
}

export interface RunViewProps {
  // Workflow schema is required so the graph + trace can render in
  // declaration order even before the first node_started frame arrives.
  // Caller fetches it before mounting RunView.
  workflow: WorkflowDetail;
  // Null means "pre-start" — the StartComposer renders at the bottom and
  // no live subscription happens until the parent supplies a runId.
  runId: string | null;
  onBack: () => void;
  // Pre-start only: invoked when the user submits the StartComposer.
  // Parent owns the API call + screen-state transition to the live run.
  onStart?: (args: string) => Promise<void> | void;
  // True while the start request is in flight; latches the composer.
  starting?: boolean;
}

// Three layouts the segmented control switches between. `split` keeps the
// historical default (DAG + Trace side-by-side); `trace` and `graph` are
// the single-pane modes for focused reading.
type Layout = "split" | "trace" | "graph";

export function RunView({ workflow, runId, onBack, onStart, starting = false }: RunViewProps) {
  const preStart = runId === null;
  const { run, nodes, status, error, cancel, resume } = useWorkflowRun(runId);
  const [layout, setLayout] = useState<Layout>("split");
  // Live wall-clock so the header's elapsed duration ticks while running.
  // Stopped on terminal status to avoid a churn loop.
  const [now, setNow] = useState(Date.now());
  // `paused` is non-terminal — the run is sitting on an approval node
  // awaiting POST /resume, still abortable via DELETE. Treating it as
  // running here keeps the Cancel button visible, the elapsed clock
  // ticking, and the trace's `streaming` flag true so the run surface
  // matches its real lifecycle.
  const isRunning = run.status === "running" || run.status === "paused" || run.status === "loading";
  useEffect(() => {
    if (preStart || !isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [preStart, isRunning]);

  // Once the run reaches a terminal status, downstream nodes that never
  // emitted a frame must not stay "pending" — they're either cancelled
  // (run was aborted) or skipped (run terminated without reaching them).
  // fallbackStatusFromRun reconciles run.status into the right default.
  const missingNodeFallback = useMemo(() => fallbackStatusFromRun(run.status), [run.status]);
  const statusByNode = useMemo<ReadonlyMap<string, NodeViewStatus>>(() => {
    const map = new Map<string, NodeViewStatus>();
    for (const sn of workflow.nodes) {
      const node: NodeView | undefined = nodes[sn.id];
      map.set(sn.id, node?.status ?? missingNodeFallback);
    }
    return map;
  }, [workflow.nodes, nodes, missingNodeFallback]);

  const durationByNode = useMemo<ReadonlyMap<string, number>>(() => {
    const map = new Map<string, number>();
    for (const [id, v] of Object.entries(nodes)) {
      if (v.durationMs != null) map.set(id, v.durationMs);
    }
    return map;
  }, [nodes]);

  const elapsed = (() => {
    if (run.completedAt != null && run.startedAt != null) {
      return run.completedAt - run.startedAt;
    }
    if (run.startedAt != null && isRunning) return Math.max(0, now - run.startedAt);
    return undefined;
  })();

  const handleCancel = async () => {
    try {
      await cancel();
    } catch (err) {
      console.warn("[run-view] cancel failed:", err);
    }
  };

  // Composer routes its text (or the literal "approve") through to the
  // run-as-conversation resume endpoint. Guarded so a stale composer event
  // after the pause resolves can't fire a resume against an undefined node.
  const handleSubmitApproval = async (text: string) => {
    if (!run.awaitingNodeId) return;
    await resume(run.awaitingNodeId, text);
  };
  // Abandon reuses the run-level cancel: the DELETE route drains the pending
  // approval before the executor sees the abort, so no separate API needed.
  const handleAbandon = async () => {
    await cancel();
  };

  return (
    <div className="run-view">
      <div className="run-header">
        <button type="button" className="back-btn" onClick={onBack} aria-label="Back to catalog">
          ←
        </button>
        <div>
          <div className="run-name">{workflow.name}</div>
          <div className="run-slug">
            {preStart
              ? `${workflow.nodes.length} node${workflow.nodes.length === 1 ? "" : "s"}`
              : runId.slice(0, 8)}
          </div>
        </div>
        <div className="run-meta">
          {preStart ? (
            <StatusBadge status="pending" />
          ) : (
            <>
              <StatusBadge status={statusBadgeStatus(run.status)} />
              {elapsed != null && <span className="duration">{formatDuration(elapsed)}</span>}
              {isRunning && (
                <button type="button" className="btn danger" onClick={handleCancel}>
                  ✕ Cancel
                </button>
              )}
            </>
          )}
          <div className="layout-toggle" role="radiogroup" aria-label="Run view layout">
            <LayoutButton
              icon="split"
              label="Split"
              active={layout === "split"}
              onClick={() => setLayout("split")}
            />
            <LayoutButton
              icon="trace"
              label="Trace"
              active={layout === "trace"}
              onClick={() => setLayout("trace")}
            />
            <LayoutButton
              icon="graph"
              label="Graph"
              active={layout === "graph"}
              onClick={() => setLayout("graph")}
            />
          </div>
        </div>
      </div>

      {status === "error" && (
        <div className="empty-state" style={{ marginBottom: 14 }}>
          Failed to load run: {error}
        </div>
      )}

      {run.warnings.length > 0 && (
        <div className="run-warnings" role="status">
          {run.warnings.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: warnings are append-only for a settled run and the order matches the executor's emission order
            <div key={i} className="run-warning-row">
              <span className="run-warning-glyph" aria-hidden="true">
                ⚠
              </span>
              <span>
                {w.nodeId ? <strong>{w.nodeId}: </strong> : null}
                {w.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {preStart && onStart && <StartComposer onStart={onStart} starting={starting} />}

      {layout === "split" && (
        <div className="run-body">
          <div className="pane">
            <div className="pane-header">DAG · {workflow.name}</div>
            <div className="dag-stage">
              <DagGraph
                nodes={workflow.nodes}
                statusByNode={statusByNode}
                durationByNode={durationByNode}
              />
            </div>
          </div>
          <div className="pane">
            <div className="pane-header">Trace</div>
            <div className="pane-body">
              <RunTrace
                schemaNodes={workflow.nodes}
                nodes={nodes}
                streaming={isRunning}
                awaitingNodeId={run.awaitingNodeId}
                onSubmitApproval={handleSubmitApproval}
                onAbandon={handleAbandon}
              />
            </div>
          </div>
        </div>
      )}

      {layout === "trace" && (
        <div className="pane run-body-single">
          <div className="pane-header">Trace</div>
          <div className="pane-body">
            <RunTrace
              schemaNodes={workflow.nodes}
              nodes={nodes}
              streaming={isRunning}
              awaitingNodeId={run.awaitingNodeId}
              onSubmitApproval={handleSubmitApproval}
              onAbandon={handleAbandon}
            />
          </div>
        </div>
      )}

      {layout === "graph" && (
        <div className="pane run-body-single">
          <div className="pane-header">DAG · {workflow.name}</div>
          <div className="dag-stage">
            <DagGraph
              nodes={workflow.nodes}
              statusByNode={statusByNode}
              durationByNode={durationByNode}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface LayoutButtonProps {
  icon: Layout;
  label: string;
  active: boolean;
  onClick: () => void;
}

function LayoutButton({ icon, label, active, onClick }: LayoutButtonProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`layout-toggle-btn${active ? " active" : ""}`}
      onClick={onClick}
    >
      <LayoutGlyph icon={icon} />
      <span>{label}</span>
    </button>
  );
}

// 14px inline SVGs — pictograms of each layout. `currentColor` so the
// active/inactive color cascades from the button's text color.
function LayoutGlyph({ icon }: { icon: Layout }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (icon === "split") {
    return (
      <svg {...common}>
        <rect x="1.5" y="2.5" width="5.5" height="11" rx="1.2" />
        <rect x="9" y="2.5" width="5.5" height="11" rx="1.2" />
      </svg>
    );
  }
  if (icon === "trace") {
    return (
      <svg {...common}>
        <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" />
        <line x1="2.5" y1="8" x2="13.5" y2="8" />
        <line x1="2.5" y1="11.5" x2="13.5" y2="11.5" />
      </svg>
    );
  }
  // graph
  return (
    <svg {...common}>
      <circle cx="8" cy="3.2" r="1.6" />
      <circle cx="8" cy="8" r="1.6" />
      <circle cx="8" cy="12.8" r="1.6" />
      <line x1="8" y1="4.8" x2="8" y2="6.4" />
      <line x1="8" y1="9.6" x2="8" y2="11.2" />
    </svg>
  );
}
