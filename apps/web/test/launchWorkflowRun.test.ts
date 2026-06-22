import { describe, expect, test } from "bun:test";
import { DEFAULT_PROJECT_NAME, type Project } from "@keelson/shared";
import { type LaunchWorkflowRunDeps, launchWorkflowRun } from "../src/lib/launchWorkflowRun.ts";

function project(id: string, name: string): Project {
  return { id, name, rootPath: `/p/${id}`, createdAt: "2026-01-01T00:00:00Z" };
}

interface Harness {
  deps: LaunchWorkflowRunDeps;
  startCalls: Array<{
    workflow: string;
    options: { projectId: string; inputs?: Record<string, string> };
  }>;
  opened: Array<{ workflowName: string; runId: string }>;
  toasts: Array<{ kind: string; message: string }>;
  listProjectsCalls: number;
}

function harness(over?: {
  activeProjectId?: string | null;
  listProjects?: () => Promise<Project[]>;
  startWorkflowRun?: LaunchWorkflowRunDeps["startWorkflowRun"];
}): Harness {
  const startCalls: Harness["startCalls"] = [];
  const opened: Harness["opened"] = [];
  const toasts: Harness["toasts"] = [];
  let listProjectsCalls = 0;
  const baseList = over?.listProjects ?? (async () => [project("p1", DEFAULT_PROJECT_NAME)]);
  const deps: LaunchWorkflowRunDeps = {
    activeProjectId: over?.activeProjectId ?? null,
    listProjects: () => {
      listProjectsCalls++;
      return baseList();
    },
    startWorkflowRun:
      over?.startWorkflowRun ??
      (async (workflow, options) => {
        startCalls.push({ workflow, options });
        return { runId: "run-1", workflowName: `${workflow}-resolved` };
      }),
    onOpened: (workflowName, runId) => opened.push({ workflowName, runId }),
    toast: { push: (t) => toasts.push(t) },
  };
  return {
    deps,
    startCalls,
    opened,
    toasts,
    get listProjectsCalls() {
      return listProjectsCalls;
    },
  };
}

describe("launchWorkflowRun", () => {
  test("omits inputs when args is empty", async () => {
    const h = harness({ activeProjectId: "p1" });
    await launchWorkflowRun(h.deps, "chamber-genesis", {});
    expect(h.startCalls).toEqual([{ workflow: "chamber-genesis", options: { projectId: "p1" } }]);
    // The empty-args branch must NOT carry an inputs key.
    expect("inputs" in h.startCalls[0].options).toBe(false);
  });

  test("passes inputs: args when args is non-empty", async () => {
    const h = harness({ activeProjectId: "p1" });
    await launchWorkflowRun(h.deps, "chamber-genesis", { topic: "nav" });
    expect(h.startCalls).toEqual([
      { workflow: "chamber-genesis", options: { projectId: "p1", inputs: { topic: "nav" } } },
    ]);
  });

  test("resolves the default project when activeProjectId is null (DEFAULT_PROJECT_NAME wins)", async () => {
    const h = harness({
      activeProjectId: null,
      listProjects: async () => [project("other", "other"), project("def", DEFAULT_PROJECT_NAME)],
    });
    await launchWorkflowRun(h.deps, "wf", {});
    expect(h.listProjectsCalls).toBe(1);
    expect(h.startCalls[0].options.projectId).toBe("def");
  });

  test("falls back to list[0] when no project is named DEFAULT_PROJECT_NAME", async () => {
    const h = harness({
      activeProjectId: null,
      listProjects: async () => [project("first", "alpha"), project("second", "beta")],
    });
    await launchWorkflowRun(h.deps, "wf", {});
    expect(h.startCalls[0].options.projectId).toBe("first");
  });

  test("a listProjects rejection toasts 'Couldn't load projects' and does not launch", async () => {
    const h = harness({
      activeProjectId: null,
      listProjects: async () => {
        throw new Error("offline");
      },
    });
    await launchWorkflowRun(h.deps, "wf", {});
    expect(h.toasts).toEqual([{ kind: "error", message: "Couldn't load projects: offline" }]);
    expect(h.startCalls).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test("an empty project list toasts 'No project available yet' and does not launch", async () => {
    const h = harness({ activeProjectId: null, listProjects: async () => [] });
    await launchWorkflowRun(h.deps, "wf", {});
    expect(h.toasts).toEqual([
      { kind: "error", message: "No project available yet — try again shortly." },
    ]);
    expect(h.startCalls).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test("a startWorkflowRun rejection toasts 'Couldn't start {workflow}' and does not open", async () => {
    const h = harness({
      activeProjectId: "p1",
      startWorkflowRun: async () => {
        throw new Error("boom");
      },
    });
    await launchWorkflowRun(h.deps, "chamber-genesis", {});
    expect(h.toasts).toEqual([{ kind: "error", message: "Couldn't start chamber-genesis: boom" }]);
    expect(h.opened).toEqual([]);
  });

  test("on success calls onOpened with the resolved workflow name and run id", async () => {
    const h = harness({ activeProjectId: "p1" });
    await launchWorkflowRun(h.deps, "chamber-genesis", {});
    expect(h.opened).toEqual([{ workflowName: "chamber-genesis-resolved", runId: "run-1" }]);
    expect(h.toasts).toEqual([]);
  });

  test("falls back to the requested workflow name when startWorkflowRun omits workflowName", async () => {
    const h = harness({
      activeProjectId: "p1",
      startWorkflowRun: async () => ({ runId: "run-9" }),
    });
    await launchWorkflowRun(h.deps, "bare", {});
    expect(h.opened).toEqual([{ workflowName: "bare", runId: "run-9" }]);
  });

  test("uses activeProjectId directly without calling listProjects", async () => {
    const h = harness({ activeProjectId: "preset" });
    await launchWorkflowRun(h.deps, "wf", {});
    expect(h.listProjectsCalls).toBe(0);
    expect(h.startCalls[0].options.projectId).toBe("preset");
  });
});
