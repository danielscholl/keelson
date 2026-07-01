// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Poll a run that a `stay` launch did NOT hand to the Workflows tab, so its terminal
// outcome still reaches the operator (a toast) instead of only the "started" toast.
// Extracted from App so it can be unit-tested without mounting the app — deps are
// injected (the run fetch, the toast sink, the poll cadence/cap, the sleep), the same
// pattern launchWorkflowRun follows.

export interface WatchStayRunDeps {
  getRun: (runId: string) => Promise<{ status: string; error: string | null }>;
  toast: { push: (t: { kind: "ok" | "error" | "info"; message: string }) => unknown };
  // Poll cadence + cap, injectable so a test needn't wait real time. Defaults poll
  // every 1.5s for ~5 minutes.
  intervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Best-effort and bounded; the run stays inspectable in the Workflows tab and its
// surface panel, so reaching the poll cap simply leaves the outcome to those.
export async function watchStayRun(
  name: string,
  runId: string,
  deps: WatchStayRunDeps,
): Promise<void> {
  const {
    getRun,
    toast,
    intervalMs = 1500,
    maxPolls = 200,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(intervalMs);
    let run: { status: string; error: string | null };
    try {
      run = await getRun(runId);
    } catch {
      // A transient fetch failure shouldn't end the watch — poll again next tick.
      continue;
    }
    if (run.status === "succeeded") {
      toast.push({ kind: "ok", message: `${name} ✓` });
      return;
    }
    if (run.status === "failed" || run.status === "cancelled") {
      toast.push({
        kind: "error",
        message: `${name} ${run.status}${run.error ? `: ${run.error}` : ""}`,
      });
      return;
    }
  }
}
