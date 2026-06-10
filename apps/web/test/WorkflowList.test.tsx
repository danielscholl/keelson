import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowDetail, WorkflowSummary } from "@keelson/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkflowList } from "../src/components/Workflows/WorkflowList.tsx";

const STORAGE_KEY = "keelson.settings.v1";
function resetSettings(): void {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

function wf(name: string, source: WorkflowSummary["source"], background = false): WorkflowSummary {
  return { name, description: `desc for ${name}`, nodeCount: 1, source, background };
}

const WORKFLOWS: WorkflowSummary[] = [
  wf("local-one", { kind: "local" }),
  wf("osdu-cluster", { kind: "rib", ribId: "osdu", ribName: "OSDU" }),
  wf("osdu-lane", { kind: "rib", ribId: "osdu", ribName: "OSDU" }, true),
];
const DETAILS = new Map<string, WorkflowDetail>();

describe("WorkflowList — provenance filtering", () => {
  beforeEach(() => resetSettings());

  test("renders a rib badge and hides background producers by default", () => {
    render(<WorkflowList workflows={WORKFLOWS} details={DETAILS} onRun={() => {}} />);
    // The rib badge labels the OSDU workflow.
    expect(screen.getAllByText("OSDU").length).toBeGreaterThan(0);
    // Foreground workflows are shown…
    expect(screen.getByText("local-one")).toBeTruthy();
    expect(screen.getByText("osdu-cluster")).toBeTruthy();
    // …but the background producer (osdu-lane) is hidden until toggled on.
    expect(screen.queryByText("osdu-lane")).toBeNull();
  });

  test("'Show background' reveals producer workflows", () => {
    render(<WorkflowList workflows={WORKFLOWS} details={DETAILS} onRun={() => {}} />);
    fireEvent.click(screen.getByText("Show background"));
    expect(screen.queryByText("osdu-lane")).toBeTruthy();
  });

  test("the source filter narrows the grid to one source", () => {
    render(<WorkflowList workflows={WORKFLOWS} details={DETAILS} onRun={() => {}} />);
    // Click the "local" source chip → only the local workflow remains.
    fireEvent.click(screen.getByText("local"));
    expect(screen.getByText("local-one")).toBeTruthy();
    expect(screen.queryByText("osdu-cluster")).toBeNull();
  });

  test("hiding a rib drops its workflows from the catalog (view-only)", () => {
    render(<WorkflowList workflows={WORKFLOWS} details={DETAILS} onRun={() => {}} />);
    expect(screen.getByText("osdu-cluster")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Hide OSDU workflows"));
    expect(screen.queryByText("osdu-cluster")).toBeNull();
    // The local workflow is unaffected.
    expect(screen.getByText("local-one")).toBeTruthy();
  });
});
