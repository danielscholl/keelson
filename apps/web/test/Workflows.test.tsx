import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import * as realApi from "../src/api.ts";

// Stub the mount-time network so the view renders offline. RecentRuns does
// its own fetch, so replace it with a no-op — the "Recent runs" heading we
// assert on is rendered by Workflows itself, not by RecentRuns.
mock.module("../src/api.ts", () => ({
  ...realApi,
  listWorkflows: async () => ({ workflows: [], discoveryNotices: [] }),
  listProjects: async () => [],
}));
mock.module("../src/components/Workflows/RecentRuns.tsx", () => ({
  RecentRuns: () => null,
}));

const STORAGE_KEY = "keelson.settings.v1";
const CATALOG_MARKER = "No workflows discovered";
const RUNS_MARKER = "Recent runs";

function seedViewMode(mode?: string): void {
  localStorage.clear();
  if (mode) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ favorites: [], lastUsed: null, workflowsViewMode: mode }),
    );
  }
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

async function renderWorkflows() {
  const { ToastHost } = await import("../src/components/Toast.tsx");
  const { Workflows } = await import("../src/views/Workflows.tsx");
  const utils = render(
    <ToastHost>
      <Workflows />
    </ToastHost>,
  );
  // Wait for the mount fetch to resolve so the toggle/panels replace the skeleton.
  await screen.findByRole("radiogroup");
  return utils;
}

function radio(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll('[role="radio"]')].find(
    (r) => r.textContent === label,
  );
  if (!found) throw new Error(`radio "${label}" not found`);
  return found as HTMLElement;
}

describe("Workflows view-mode rendering", () => {
  // Warm the heavy module graph (xyflow/dagre/shiki via RunView) once so the
  // first test doesn't pay the import cost inside its per-test timeout.
  beforeAll(async () => {
    await import("../src/components/Toast.tsx");
    await import("../src/views/Workflows.tsx");
  }, 30000);

  beforeEach(() => {
    seedViewMode();
  });

  test("defaults to 'both': three radios, Both active, both panels shown", async () => {
    const { container } = await renderWorkflows();
    const radios = [...container.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(["Both", "Workflows", "Runs"]);
    expect(radio(container, "Both").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(CATALOG_MARKER)).not.toBeNull();
    expect(screen.queryByText(RUNS_MARKER)).not.toBeNull();
  });

  test("selecting 'Workflows' shows the catalog and hides Recent runs", async () => {
    const { container } = await renderWorkflows();
    await act(async () => {
      radio(container, "Workflows").click();
    });
    expect(radio(container, "Workflows").getAttribute("aria-checked")).toBe("true");
    expect(radio(container, "Both").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(CATALOG_MARKER)).not.toBeNull();
    expect(screen.queryByText(RUNS_MARKER)).toBeNull();
  });

  test("selecting 'Runs' hides the catalog and keeps Recent runs", async () => {
    const { container } = await renderWorkflows();
    await act(async () => {
      radio(container, "Runs").click();
    });
    expect(radio(container, "Runs").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(CATALOG_MARKER)).toBeNull();
    expect(screen.queryByText(RUNS_MARKER)).not.toBeNull();
  });
});
