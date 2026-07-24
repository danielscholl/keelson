// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, mock, test } from "bun:test";
import type { WorkflowDetail } from "@keelson/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NodeView, UseWorkflowRunResult } from "../src/hooks/useWorkflowRun.ts";

let runResult: UseWorkflowRunResult;
let detail: Promise<WorkflowDetail>;
const traceProps: Array<Record<string, unknown>> = [];
const detailCalls: Array<[string, string | undefined]> = [];

// mock.module patches the process-wide registry and bun's file order isn't
// stable, so every stub is handed back in afterAll.
const USE_WORKFLOW_RUN = "../src/hooks/useWorkflowRun.ts";
const RUN_TRACE = "../src/components/Workflows/RunTrace.tsx";
const API = "../src/api.ts";

const actualUseWorkflowRun = { ...(await import(USE_WORKFLOW_RUN)) };
const actualRunTrace = { ...(await import(RUN_TRACE)) };
const actualApi = { ...(await import(API)) };

afterAll(() => {
  mock.module(USE_WORKFLOW_RUN, () => actualUseWorkflowRun);
  mock.module(RUN_TRACE, () => actualRunTrace);
  mock.module(API, () => actualApi);
});

mock.module(USE_WORKFLOW_RUN, () => ({ useWorkflowRun: () => runResult }));

mock.module(RUN_TRACE, () => ({
  fallbackStatusFromRun: () => "pending",
  RunTrace: (props: Record<string, unknown>) => {
    traceProps.push(props);
    return <div data-testid="run-trace" />;
  },
}));

mock.module(API, () => ({
  ...actualApi,
  getWorkflowDetail: (name: string, projectId?: string) => {
    detailCalls.push([name, projectId]);
    return detail;
  },
}));

const { RunDrawer } = await import("../src/components/Workflows/RunDrawer.tsx");

const workflow: WorkflowDetail = {
  name: "osdu-cluster-delete",
  description: "",
  nodes: [{ id: "delete", type: "bash" }],
};

function result(
  overrides: Partial<UseWorkflowRunResult["run"]> = {},
  hook: Partial<UseWorkflowRunResult> = {},
): UseWorkflowRunResult {
  return {
    run: {
      runId: "run-abcdef12",
      workflowName: "osdu-cluster-delete",
      status: "running",
      startedAt: 0,
      error: null,
      warnings: [],
      conversationId: null,
      projectId: null,
      workingDir: null,
      worktreePath: null,
      ...overrides,
    },
    nodes: {} as Record<string, NodeView>,
    status: "ready",
    error: null,
    wsState: "open",
    cancel: async () => {},
    resumeRun: async () => {},
    resume: async () => {},
    ...hook,
  };
}

function mount(props: Partial<Parameters<typeof RunDrawer>[0]> = {}) {
  return render(
    <RunDrawer
      workflowName="osdu-cluster-delete"
      runId="run-abcdef12"
      onClose={() => {}}
      onOpenInWorkflows={() => {}}
      {...props}
    />,
  );
}

describe("RunDrawer", () => {
  test("streams the run's trace once the schema resolves", async () => {
    traceProps.length = 0;
    runResult = result();
    detail = Promise.resolve(workflow);
    mount();

    expect(await screen.findByTestId("run-trace")).toBeTruthy();
    // The trace renders in DAG declaration order, so it must receive the fetched
    // schema — not an empty list that would silently render nothing.
    const last = traceProps[traceProps.length - 1];
    expect(last?.schemaNodes).toEqual(workflow.nodes);
    expect(last?.streaming).toBe(true);
  });

  test("keeps the header usable when the schema fetch fails", async () => {
    runResult = result();
    detail = Promise.reject(new Error("boom"));
    mount();

    expect(await screen.findByText(/Couldn't load the workflow schema: boom/)).toBeTruthy();
    // Status and Cancel still reachable — a schema failure must not strand a
    // running cluster verb with no way to stop it.
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeTruthy();
  });

  test("offers Cancel only while the run is live", async () => {
    runResult = result({ status: "succeeded", completedAt: 4200 });
    detail = Promise.resolve(workflow);
    mount();

    await screen.findByTestId("run-trace");
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
    expect(screen.getByText("completed")).toBeTruthy();
    // startedAt 0 → completedAt 4200 is a settled run, so the elapsed label is frozen.
    expect(screen.getByText("4.2s")).toBeTruthy();
  });

  test("surfaces a failed run's error", async () => {
    runResult = result({ status: "failed", completedAt: 900, error: "cimpl down exited 1" });
    detail = Promise.resolve(workflow);
    mount();

    await screen.findByTestId("run-trace");
    expect(screen.getByRole("alert").textContent).toContain("cimpl down exited 1");
  });

  test("Escape and the close button both dismiss", async () => {
    runResult = result();
    detail = Promise.resolve(workflow);
    let closed = 0;
    mount({ onClose: () => closed++ });
    await screen.findByTestId("run-trace");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(closed).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Close run" }));
    expect(closed).toBe(2);
  });

  test("scopes the schema fetch to the run's own project, not the active one", async () => {
    detailCalls.length = 0;
    runResult = result({ projectId: "proj-run" });
    detail = Promise.resolve(workflow);
    mount({ projectId: "proj-active" });

    await screen.findByTestId("run-trace");
    // A stay launch can resolve a project the surface isn't scoped to; fetching
    // with the surface's id would 404 or return a shadowing global workflow.
    expect(detailCalls).toEqual([["osdu-cluster-delete", "proj-run"]]);
  });

  test("defers the schema fetch until the run has hydrated", async () => {
    detailCalls.length = 0;
    runResult = result({ status: "loading", projectId: null }, { status: "loading" });
    detail = Promise.resolve(workflow);
    const view = mount({ projectId: "proj-active" });
    expect(detailCalls).toEqual([]);

    runResult = result({ projectId: "proj-run" });
    view.rerender(
      <RunDrawer
        workflowName="osdu-cluster-delete"
        runId="run-abcdef12"
        projectId="proj-active"
        onClose={() => {}}
        onOpenInWorkflows={() => {}}
      />,
    );
    await screen.findByTestId("run-trace");
    expect(detailCalls).toEqual([["osdu-cluster-delete", "proj-run"]]);
  });

  test("reports a failed run hydration instead of an idle-looking run", async () => {
    runResult = result({ status: "loading" }, { status: "error", error: "run 404" });
    detail = Promise.resolve(workflow);
    mount();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Failed to load run: run 404");
  });

  test("hands the run to the Workflows tab on request", async () => {
    runResult = result();
    detail = Promise.resolve(workflow);
    const opened: Array<[string, string]> = [];
    mount({ onOpenInWorkflows: (name: string, runId: string) => opened.push([name, runId]) });
    await screen.findByTestId("run-trace");

    fireEvent.click(screen.getByRole("button", { name: "Open in Workflows" }));
    expect(opened).toEqual([["osdu-cluster-delete", "run-abcdef12"]]);
  });
});
