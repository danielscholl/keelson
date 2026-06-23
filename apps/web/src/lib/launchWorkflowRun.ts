// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { DEFAULT_PROJECT_NAME, type Project } from "@keelson/shared";

// The project-resolution + launch body behind a board action's run-workflow
// directive, extracted from App so it can be unit-tested without mounting the
// app. Deps are injected (the two api calls, the current active project, the
// navigate-away handoff, the toast sink); App wires its real ones.
export interface LaunchWorkflowRunDeps {
  activeProjectId: string | null;
  listProjects: () => Promise<Project[]>;
  startWorkflowRun: (
    workflow: string,
    options: { projectId: string; inputs?: Record<string, string> },
  ) => Promise<{ runId: string; workflowName?: string }>;
  onOpened: (workflowName: string, runId: string) => void;
  toast: { push: (toast: { kind: "ok" | "error" | "info"; message: string }) => unknown };
}

// Launches `workflow` through the same primitive /workflow run uses, then hands
// the run to the Workflows-tab handoff. Self-handles every failure into a toast
// and never rejects, so callers can fire it without awaiting a possible throw.
export async function launchWorkflowRun(
  deps: LaunchWorkflowRunDeps,
  workflow: string,
  args: Record<string, string>,
): Promise<void> {
  const { activeProjectId, listProjects, startWorkflowRun, onOpened, toast } = deps;
  // activeProjectId is null until the catalog loads; resolve the default the way
  // startRun does so a fresh load still starts a run.
  let projectId = activeProjectId;
  if (!projectId) {
    try {
      const list = await listProjects();
      projectId = (list.find((p) => p.name === DEFAULT_PROJECT_NAME) ?? list[0])?.id ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.push({ kind: "error", message: `Couldn't load projects: ${message}` });
      return;
    }
  }
  if (!projectId) {
    toast.push({ kind: "error", message: "No project available yet — try again shortly." });
    return;
  }
  try {
    const { runId, workflowName } = await startWorkflowRun(workflow, {
      projectId,
      ...(Object.keys(args).length ? { inputs: args } : {}),
    });
    onOpened(workflowName ?? workflow, runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast.push({ kind: "error", message: `Couldn't start ${workflow}: ${message}` });
  }
}
