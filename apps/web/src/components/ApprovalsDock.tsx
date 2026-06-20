// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// App-level surface for policy ASK approvals. A policy `ask` (e.g. ask_on_shell)
// pauses a turn on ANY surface — chat, a rib turn, a workflow prompt — and the
// server publishes the open set on the global POLICY_APPROVALS_SNAPSHOT_KEY. So
// the prompt lives at the app root, not inside one surface: wherever the pause
// originated, the user sees it and resolves it here.

import {
  type ApprovalDecision,
  type PendingApprovalView,
  POLICY_APPROVALS_SNAPSHOT_KEY,
  policyApprovalsSnapshotSchema,
} from "@keelson/shared";
import { useEffect, useState } from "react";
import { resolveApproval } from "../api.ts";
import { useSnapshot } from "../hooks/useSnapshot.ts";

export interface ApprovalPromptProps {
  approvals: readonly PendingApprovalView[];
  // Ids with an in-flight decision — their buttons disable until the snapshot
  // updates (or the request fails).
  busyIds: ReadonlySet<string>;
  onResolve: (id: string, decision: ApprovalDecision) => void;
}

// Presentational dock: renders one card per pending approval, newest last (the
// snapshot is already oldest-first). Renders nothing when there's nothing to
// approve so it stays out of the way. Kept prop-driven so it's unit-testable
// without the snapshot/HTTP layer.
export function ApprovalPrompt({ approvals, busyIds, onResolve }: ApprovalPromptProps) {
  if (approvals.length === 0) return null;
  return (
    <section className="approvals-dock" aria-label="Pending approvals">
      {approvals.map((a) => {
        const busy = busyIds.has(a.id);
        return (
          <div key={a.id} className="approvals-card">
            <div className="approvals-card-head">
              <span className="approvals-card-title">Approval needed</span>
              <span className="approvals-card-meta">
                {a.surface}
                {a.tool ? ` · ${a.tool}` : ""}
              </span>
            </div>
            <p className="approvals-card-reason">{a.reason}</p>
            <div className="approval-actions">
              <button
                type="button"
                className="btn abandon"
                onClick={() => onResolve(a.id, "reject")}
                disabled={busy}
              >
                ✕ Reject
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => onResolve(a.id, "accept")}
                disabled={busy}
              >
                ✓ Accept
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function parseApprovals(data: unknown): PendingApprovalView[] {
  const parsed = policyApprovalsSnapshotSchema.safeParse(data);
  return parsed.success ? parsed.data : [];
}

// Container: subscribes to the global approvals snapshot and wires resolve →
// POST /api/approvals/:id. The snapshot recomposes on resolve, so a settled
// approval drops off the dock on the next frame; the busy set just gates
// double-clicks in the meantime.
export function ApprovalsDock() {
  const { data } = useSnapshot(POLICY_APPROVALS_SNAPSHOT_KEY);
  const approvals = parseApprovals(data);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  // Drop busy markers for approvals that have left the snapshot (resolved, timed
  // out, or aborted) so the set can't grow unbounded over a long session.
  useEffect(() => {
    setBusyIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(approvals.map((a) => a.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [approvals]);

  const onResolve = (id: string, decision: ApprovalDecision): void => {
    setBusyIds((prev) => new Set(prev).add(id));
    void (async () => {
      try {
        await resolveApproval(id, decision);
        // The snapshot WS pushes the shortened list; nothing else to do.
      } catch (err) {
        // 404 (raced a timeout/another client) or a transient failure — re-enable
        // so the user can retry. The dock owns no toast; log for dev visibility.
        console.warn("[approvals-dock] resolve failed:", err);
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    })();
  };

  return <ApprovalPrompt approvals={approvals} busyIds={busyIds} onResolve={onResolve} />;
}
