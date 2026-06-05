// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkflowRun, refreshWorkflow } from "../api.ts";

const POLL_MS = 1500;
// Cap the poll so a paused/stuck run can't spin the icon forever; collectors are
// one-shot bash nodes, so a few minutes is generous (security is the slowest).
const MAX_POLLS = 240;

export interface WorkflowTriggerState {
  running: boolean;
  error: string | null;
  trigger: () => void;
}

// Starts a catalog workflow by name and tracks it to a terminal state so a
// caller can show "running" UI. The run repopulates its bound snapshot key
// server-side; the caller's own snapshot subscription swaps in the new frame —
// this hook only owns the in-flight signal, not the data. `workflowName`
// undefined makes `trigger` a no-op (a region with no refresh workflow).
export function useWorkflowTrigger(workflowName: string | undefined): WorkflowTriggerState {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const trigger = useCallback(() => {
    if (!workflowName || running) return;
    setRunning(true);
    setError(null);
    void (async () => {
      try {
        const { runId } = await refreshWorkflow(workflowName);
        for (let i = 0; i < MAX_POLLS; i++) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          if (cancelledRef.current) return;
          const run = await getWorkflowRun(runId);
          if (run.status === "succeeded") break;
          if (run.status === "failed" || run.status === "cancelled") {
            if (!cancelledRef.current) setError(run.error ?? `workflow ${run.status}`);
            break;
          }
        }
      } catch (e) {
        if (!cancelledRef.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelledRef.current) setRunning(false);
      }
    })();
  }, [workflowName, running]);

  return { running, error, trigger };
}
