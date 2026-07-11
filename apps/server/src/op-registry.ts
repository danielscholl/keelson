// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// The live half of the op registry. It owns the in-memory controllers
// (AbortController + optional steer callback) for native rib ops and layers a
// READ-ONLY projection of workflow runs on top of the durable OpStore, so the
// generic run_* tools present one unified op view over both. Workflow runs are
// never mirrored into op_events (that would double-write the workflow store);
// they are projected on demand from the WorkflowController.

import type {
  OpFrameKind,
  OpHandle,
  RegisterOpRequest,
  WorkflowRunDetail,
  WorkflowRunStatus,
} from "@keelson/shared";
import { TERMINAL_RUN_STATUSES } from "@keelson/shared";
import type { OpStatus, OpStore } from "./op-store.ts";
import type { WorkflowController } from "./workflows-handler.ts";

// Workflow ops carry this prefix so run_status/run_events/run_cancel route to the
// WorkflowController projection instead of the native OpStore. A native op id is a
// bare UUID; a workflow op id is `wf:<runId>`.
const WF_PREFIX = "wf:";

export interface OpSummaryView {
  id: string;
  kind: string;
  title: string | null;
  owner: string;
  status: OpStatus;
  steerable: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface OpStatusView extends OpSummaryView {
  result: unknown;
  error: string | null;
  // Highest event seq — the cursor ceiling a poller passes back to run_events.
  // For a native op this is a durable append-only counter; for a workflow op it
  // is the current projected frame count (a resume may renumber — re-read from 0).
  lastSeq: number;
}

export interface OpEventView {
  seq: number;
  kind: OpFrameKind;
  message: string | null;
  data: unknown;
  createdAt: string;
}

export type OpControlResult = { ok: true; message: string } | { ok: false; message: string };

export interface OpRegistry {
  // Native op lifecycle — backs RibContext.registerOp (owner stamped by the seam).
  register(owner: string, req: RegisterOpRequest): OpHandle;
  list(): OpSummaryView[];
  status(id: string): OpStatusView | undefined;
  events(id: string, cursor: number, limit?: number): OpEventView[];
  cancel(id: string): OpControlResult;
  steer(id: string, note: string): OpControlResult;
  // Abort every live native op and settle its row. Called at server shutdown
  // BEFORE the database closes, so a detached rib op can't write through a
  // closed db after `done`/`log`.
  drain(): void;
}

export interface OpRegistryDeps {
  store: OpStore;
  // Projection source for workflow-run ops. Lazy: the controller is built after
  // the registry, and workflow ops are read-only projections.
  getWorkflowController?: () => WorkflowController | undefined;
  // Abort a live workflow run — abort-only (keeps the cancelled row so the
  // terminal result stays retrievable), NOT purge. False when no live run.
  cancelWorkflowRun?: (runId: string) => boolean;
  now?: () => string;
}

interface LiveController {
  abort: AbortController;
  onSteer?: (note: string) => void;
}

function mapWorkflowStatus(status: WorkflowRunStatus): OpStatus {
  switch (status) {
    case "succeeded":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      // running + paused both project to running: the op vocabulary has no paused.
      return "running";
  }
}

// Build the projected frame list for a workflow run: one frame per COMPLETED node
// ordered by completion time, plus a terminal run frame. A still-running node is
// simply not emitted yet. getRun returns nodes in rowid (completion) order — rows
// are written only at node_done — and Array.sort is stable, so a completedAt sort
// with NO tiebreak keeps completion order even on a same-millisecond tie: a later
// completion always lands at a higher seq (the monotonic-cursor invariant
// run_events relies on). A nodeId tiebreak would reorder a same-ms pair by name,
// shifting an already-emitted frame. (A workflow RESUME re-runs nodes and rewrites
// completedAt in place, so a cursor held across a resume may miss re-run frames —
// re-read from cursor 0 after resuming; see OpStatusView.lastSeq.)
function workflowFrames(detail: WorkflowRunDetail): OpEventView[] {
  const completed = detail.nodes
    .filter((node) => node.completedAt !== null)
    .sort((a, b) => {
      const at = a.completedAt as string;
      const bt = b.completedAt as string;
      return at === bt ? 0 : at < bt ? -1 : 1;
    });
  const frames: OpEventView[] = completed.map((node, i) => ({
    seq: i + 1,
    kind: node.status === "failed" ? "error" : "progress",
    message: `[${node.nodeId}] ${node.status}`,
    data: null,
    createdAt: node.completedAt as string,
  }));
  if ((TERMINAL_RUN_STATUSES as readonly WorkflowRunStatus[]).includes(detail.status)) {
    frames.push({
      seq: frames.length + 1,
      kind: detail.status === "failed" ? "error" : "done",
      message: `run ${detail.status}${detail.error ? `: ${detail.error}` : ""}`,
      data: null,
      createdAt: detail.completedAt ?? detail.startedAt,
    });
  }
  return frames;
}

export function createOpRegistry(deps: OpRegistryDeps): OpRegistry {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  // A live op is present here iff it is still running: both self-settle
  // (done/error) and run_cancel remove it, so every handle method gating on
  // membership becomes a clean no-op once the op is terminal.
  const live = new Map<string, LiveController>();

  const controller = (): WorkflowController | undefined => deps.getWorkflowController?.();

  const recordToSummary = (id: string): OpSummaryView | undefined => {
    const rec = store.get(id);
    if (!rec) return undefined;
    return {
      id: rec.id,
      kind: rec.kind,
      title: rec.title,
      owner: rec.owner,
      status: rec.status,
      steerable: rec.steerable,
      createdAt: rec.createdAt,
      completedAt: rec.completedAt,
    };
  };

  const projectWorkflowSummaries = (): OpSummaryView[] => {
    const c = controller();
    if (!c) return [];
    return c.listRuns().map((run) => ({
      id: `${WF_PREFIX}${run.runId}`,
      kind: `workflow:${run.workflowName}`,
      title: null,
      owner: "workflow",
      status: mapWorkflowStatus(run.status),
      steerable: false,
      createdAt: run.startedAt,
      completedAt: run.completedAt ?? null,
    }));
  };

  const projectWorkflowStatus = (runId: string): OpStatusView | undefined => {
    const c = controller();
    if (!c) return undefined;
    const detail = c.getRun(runId);
    if (!detail) return undefined;
    const frames = workflowFrames(detail);
    return {
      id: `${WF_PREFIX}${runId}`,
      kind: `workflow:${detail.workflowName}`,
      title: null,
      owner: "workflow",
      status: mapWorkflowStatus(detail.status),
      steerable: false,
      createdAt: detail.startedAt,
      completedAt: detail.completedAt ?? null,
      result: undefined,
      error: detail.error,
      lastSeq: frames.length,
    };
  };

  return {
    register(owner, req) {
      const id = crypto.randomUUID();
      const abort = new AbortController();
      const steerable = typeof req.onSteer === "function";
      // Create the durable row BEFORE publishing the controller into `live`: if the
      // insert throws (e.g. a bad projectId FK), no controller is left stranded.
      store.create({
        id,
        kind: req.kind,
        title: req.title ?? null,
        owner,
        projectId: req.projectId ?? null,
        steerable,
        createdAt: now(),
      });
      live.set(id, { abort, ...(req.onSteer ? { onSteer: req.onSteer } : {}) });

      const append = (kind: OpFrameKind, message?: string, data?: unknown): void => {
        if (!live.has(id)) return;
        store.appendEvent(
          id,
          {
            kind,
            ...(message !== undefined ? { message } : {}),
            ...(data !== undefined ? { data } : {}),
          },
          now(),
        );
      };
      const settle = (
        status: OpStatus,
        kind: OpFrameKind,
        frame: { message?: string; data?: unknown },
        terminal: { result?: unknown; error?: string },
      ): void => {
        if (!live.has(id)) return;
        store.settle(
          id,
          status,
          {
            kind,
            ...(frame.message !== undefined ? { message: frame.message } : {}),
            ...(frame.data !== undefined ? { data: frame.data } : {}),
          },
          now(),
          terminal,
        );
        live.delete(id);
      };

      const handle: OpHandle = {
        id,
        signal: abort.signal,
        log: (message, data) => append("log", message, data),
        progress: (message, data) => append("progress", message, data),
        done: (result) =>
          settle(
            "done",
            "done",
            { message: "done", ...(result !== undefined ? { data: result } : {}) },
            result !== undefined ? { result } : {},
          ),
        error: (message) => settle("error", "error", { message }, { error: message }),
      };
      return handle;
    },

    list() {
      // Active native ops only — a terminal-op history would grow unbounded and
      // flood run_list; matches the workflow side (listRuns = running + paused).
      const native = store.list({ status: "running" }).map(
        (rec): OpSummaryView => ({
          id: rec.id,
          kind: rec.kind,
          title: rec.title,
          owner: rec.owner,
          status: rec.status,
          steerable: rec.steerable,
          createdAt: rec.createdAt,
          completedAt: rec.completedAt,
        }),
      );
      const combined = [...native, ...projectWorkflowSummaries()];
      combined.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return combined;
    },

    status(id) {
      if (id.startsWith(WF_PREFIX)) return projectWorkflowStatus(id.slice(WF_PREFIX.length));
      const rec = store.get(id);
      if (!rec) return undefined;
      const summary = recordToSummary(id);
      if (!summary) return undefined;
      return {
        ...summary,
        result: rec.result,
        error: rec.error,
        lastSeq: store.lastSeq(id),
      };
    },

    events(id, cursor, limit) {
      if (id.startsWith(WF_PREFIX)) {
        const c = controller();
        const detail = c?.getRun(id.slice(WF_PREFIX.length));
        if (!detail) return [];
        const frames = workflowFrames(detail).filter((frame) => frame.seq > cursor);
        return limit === undefined ? frames : frames.slice(0, limit);
      }
      return store.listEvents(id, cursor, limit).map((event) => ({
        seq: event.seq,
        kind: event.kind,
        message: event.message,
        data: event.data,
        createdAt: event.createdAt,
      }));
    },

    cancel(id) {
      if (id.startsWith(WF_PREFIX)) {
        const runId = id.slice(WF_PREFIX.length);
        const aborted = deps.cancelWorkflowRun?.(runId) ?? false;
        return aborted
          ? { ok: true, message: `cancelled workflow run ${runId}` }
          : {
              ok: false,
              message: `workflow run ${runId} has no live execution to cancel (already terminal, or the server restarted).`,
            };
      }
      const rec = store.get(id);
      if (!rec) return { ok: false, message: `op ${id} not found` };
      if (rec.status !== "running") {
        return { ok: false, message: `op ${id} is already ${rec.status}; nothing to cancel` };
      }
      const ctl = live.get(id);
      if (!ctl) {
        return {
          ok: false,
          message: `op ${id} has no live controller (the server restarted); it cannot be cancelled`,
        };
      }
      // Record the terminal state and drop the op from `live` BEFORE firing the
      // signal: AbortController.abort() dispatches listeners synchronously, so a
      // rib that self-settles inside its abort listener would otherwise re-enter
      // settle() while the op still looked live and append a post-terminal frame.
      store.settle(id, "cancelled", { kind: "error", message: "cancelled by run_cancel" }, now(), {
        error: "cancelled",
      });
      live.delete(id);
      ctl.abort.abort();
      return { ok: true, message: `op ${id} cancelled` };
    },

    steer(id, note) {
      if (id.startsWith(WF_PREFIX)) {
        return {
          ok: false,
          message:
            "workflow runs are not steerable; answer an approval pause with workflow_respond instead.",
        };
      }
      const rec = store.get(id);
      if (!rec) return { ok: false, message: `op ${id} not found` };
      if (rec.status !== "running") {
        return { ok: false, message: `op ${id} is ${rec.status}; cannot steer` };
      }
      const ctl = live.get(id);
      if (!ctl?.onSteer) {
        return { ok: false, message: `op ${id} does not accept steering` };
      }
      // Record the steer frame BEFORE invoking the callback: onSteer may settle the
      // op synchronously, and its terminal frame must be causally after this one.
      store.appendEvent(id, { kind: "log", message: `steer: ${note}` }, now());
      ctl.onSteer(note);
      return { ok: true, message: `steer delivered to op ${id}` };
    },

    drain() {
      for (const [id, ctl] of Array.from(live.entries())) {
        // Remove from `live` first so a re-entrant handle call from the abort
        // listener no-ops; then settle the durable row and fire the signal.
        live.delete(id);
        try {
          store.settle(id, "cancelled", { kind: "error", message: "server shutting down" }, now(), {
            error: "server shutting down",
          });
        } catch {
          // best-effort during shutdown
        }
        try {
          ctl.abort.abort();
        } catch {
          // already aborted
        }
      }
    },
  };
}
