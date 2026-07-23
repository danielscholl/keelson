// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { WorkflowDetail } from "@keelson/shared";
import { useEffect, useState } from "react";
import { getWorkflowDetail } from "../../api.ts";
import { useDrawerDismiss } from "../../hooks/useDrawerDismiss.ts";
import { useWorkflowRun } from "../../hooks/useWorkflowRun.ts";
import { formatDuration } from "../../lib/formatDuration.ts";
import { RunTrace } from "./RunTrace.tsx";
import { StatusBadge, statusBadgeStatus } from "./StatusBadge.tsx";

export interface RunDrawerProps {
  workflowName: string;
  runId: string;
  // Scopes the schema fetch the same way the Workflows tab does.
  projectId?: string | null;
  onClose: () => void;
  // Escape hatch to the full run surface (DAG + trace + resume).
  onOpenInWorkflows: (workflowName: string, runId: string) => void;
}

// A `stay` launch keeps the operator on the surface they acted from, so the
// run needs somewhere to be watched that isn't the Workflows tab. This is that
// place: the live trace — ANSI intact, node output expandable — beside the
// board whose button started it. The board itself needs no refresh; its
// snapshot key updates over its own socket when the workflow publishes.
export function RunDrawer({
  workflowName,
  runId,
  projectId,
  onClose,
  onOpenInWorkflows,
}: RunDrawerProps) {
  const { dialogRef, closeRef, onKeyDown } = useDrawerDismiss(onClose);
  const { run, nodes, cancel, resume } = useWorkflowRun(runId);
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // The trace renders in DAG declaration order, so it needs the schema — but a
  // schema that fails to load must not blank the drawer; the header still
  // carries status, elapsed, and Cancel.
  useEffect(() => {
    let cancelled = false;
    getWorkflowDetail(workflowName, projectId ?? undefined).then(
      (detail) => {
        if (!cancelled) setWorkflow(detail);
      },
      (err) => {
        if (!cancelled) setSchemaError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workflowName, projectId]);

  const isRunning = run.status === "running" || run.status === "paused" || run.status === "loading";

  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const elapsed =
    run.completedAt != null && run.startedAt != null
      ? run.completedAt - run.startedAt
      : run.startedAt != null && isRunning
        ? Math.max(0, now - run.startedAt)
        : undefined;

  const handleSubmitApproval = async (text: string) => {
    if (!run.awaitingNodeId) return;
    await resume(run.awaitingNodeId, text);
  };

  return (
    <>
      <div className="run-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={dialogRef}
        className="run-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${workflowName} run`}
        onKeyDown={onKeyDown}
      >
        <header className="run-drawer-header">
          <div className="run-drawer-ident">
            <span className="run-drawer-title">{workflowName}</span>
            <span className="run-drawer-slug">{runId.slice(0, 8)}</span>
          </div>
          <div className="run-drawer-meta">
            <StatusBadge status={statusBadgeStatus(run.status)} />
            {elapsed != null && <span className="duration">{formatDuration(elapsed)}</span>}
            {isRunning && (
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  cancel().catch((err) => console.warn("[run-drawer] cancel failed:", err));
                }}
              >
                ✕ Cancel
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => onOpenInWorkflows(workflowName, runId)}
              title="Open the full run surface — DAG, layouts, resume"
            >
              Open in Workflows
            </button>
            <button
              ref={closeRef}
              type="button"
              className="canvas-drawer-close"
              onClick={onClose}
              aria-label="Close run"
            >
              ×
            </button>
          </div>
        </header>

        {run.status === "failed" && run.error && (
          <div className="run-error" role="alert">
            <span className="run-error-glyph" aria-hidden="true">
              ✕
            </span>
            <span>{run.error}</span>
          </div>
        )}

        <div className="run-drawer-body">
          {workflow ? (
            <RunTrace
              schemaNodes={workflow.nodes}
              nodes={nodes}
              runId={runId}
              streaming={isRunning}
              awaitingNodeId={run.awaitingNodeId}
              onSubmitApproval={handleSubmitApproval}
              onAbandon={cancel}
            />
          ) : schemaError ? (
            <div className="empty-state">Couldn't load the workflow schema: {schemaError}</div>
          ) : (
            <div className="empty-state">Loading…</div>
          )}
        </div>
      </aside>
    </>
  );
}
