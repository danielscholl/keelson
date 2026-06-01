import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realApi from "../src/api.ts";
import { __resetProjectStoreForTests } from "../src/hooks/useActiveProject.ts";

let savedContent: string | null = null;
let loadedContent = "## Gotchas\n- existing note";
let getNotebookImpl: () => Promise<{ content: string; updatedAt: string | null }> = async () => ({
  content: loadedContent,
  updatedAt: null,
});
let tidyCalls: string[] = [];
let putCalls: Array<{ id: string; content: string }> = [];
let tidyResponse = {
  content: "## Log\n- recent\n\n## Archive\n- old\n",
  updatedAt: "2026-06-01T00:00:00Z",
  previousContent: "PREV_CONTENT",
  archivedCount: 3,
};

mock.module("../src/api.ts", () => ({
  ...realApi,
  listProjects: async () => [
    { id: "p1", name: "demo", rootPath: "/tmp/demo", createdAt: "2026-01-01T00:00:00Z" },
  ],
  getProjectNotebook: async () => getNotebookImpl(),
  putProjectNotebook: async (id: string, content: string) => {
    savedContent = content;
    putCalls.push({ id, content });
    return { content, updatedAt: "2026-06-01T00:00:00Z" };
  },
  tidyProjectNotebook: async (id: string) => {
    tidyCalls.push(id);
    return tidyResponse;
  },
}));

async function renderMemory() {
  const { ToastHost } = await import("../src/components/Toast.tsx");
  const { Memory } = await import("../src/views/Memory.tsx");
  return render(
    <ToastHost>
      <Memory />
    </ToastHost>,
  );
}

describe("Memory notebook panel", () => {
  beforeEach(() => {
    savedContent = null;
    loadedContent = "## Gotchas\n- existing note";
    getNotebookImpl = async () => ({ content: loadedContent, updatedAt: null });
    tidyCalls = [];
    putCalls = [];
    tidyResponse = {
      content: "## Log\n- recent\n\n## Archive\n- old\n",
      updatedAt: "2026-06-01T00:00:00Z",
      previousContent: "PREV_CONTENT",
      archivedCount: 3,
    };
    localStorage.clear();
    __resetProjectStoreForTests();
  });

  afterEach(() => {
    __resetProjectStoreForTests();
  });

  test("loads the active project's notebook into the editor", async () => {
    await renderMemory();
    const editor = (await screen.findByLabelText("Project notebook")) as HTMLTextAreaElement;
    expect(editor.value).toContain("existing note");
  });

  test("Save persists edited content via putProjectNotebook", async () => {
    await renderMemory();
    const editor = (await screen.findByLabelText("Project notebook")) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(editor, { target: { value: "## Gotchas\n- edited" } });
    });
    const save = screen.getByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(savedContent).toBe("## Gotchas\n- edited");
  });

  test("the governed ledger is demoted behind an advanced tab", async () => {
    await renderMemory();
    expect(screen.getByRole("tab", { name: "Ledger (advanced)" })).toBeDefined();
    // Notebook is the default surface.
    expect(await screen.findByLabelText("Project notebook")).toBeDefined();
  });

  test("Tidy archives entries, shows a toast, and Undo restores previous content", async () => {
    await renderMemory();
    await screen.findByLabelText("Project notebook");
    const tidy = screen.getByRole("button", { name: "Tidy" });
    await act(async () => {
      fireEvent.click(tidy);
    });
    expect(tidyCalls).toEqual(["p1"]);
    expect(await screen.findByText(/moved 3 entries to Archive/)).toBeDefined();

    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => {
      fireEvent.click(undo);
    });
    const editor = (await screen.findByLabelText("Project notebook")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("PREV_CONTENT"));
    expect(putCalls).toContainEqual({ id: "p1", content: "PREV_CONTENT" });
  });

  test("Tidy with nothing to archive shows an info toast and no Undo", async () => {
    tidyResponse = {
      content: loadedContent,
      updatedAt: "2026-06-01T00:00:00Z",
      previousContent: loadedContent,
      archivedCount: 0,
    };
    await renderMemory();
    await screen.findByLabelText("Project notebook");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tidy" }));
    });
    expect(await screen.findByText(/nothing to tidy/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  test("over-budget notebook shows the Tidy-recommended flag", async () => {
    loadedContent = `## Log\n${Array.from(
      { length: 400 },
      () => `- 2026-06-01: ${"y".repeat(20)}`,
    ).join("\n")}\n`;
    await renderMemory();
    await screen.findByLabelText("Project notebook");
    expect(screen.getByText(/Over budget/)).toBeDefined();
  });

  test("within-budget notebook hides the over-budget flag", async () => {
    await renderMemory();
    await screen.findByLabelText("Project notebook");
    expect(screen.queryByText(/Over budget/)).toBeNull();
  });

  test("Tidy that can't archive anything but stays over budget warns instead of claiming success", async () => {
    const big = `## Log\n- 2026-06-01: ${"y".repeat(7000)}\n`;
    loadedContent = big;
    tidyResponse = {
      content: big,
      updatedAt: "2026-06-01T00:00:00Z",
      previousContent: big,
      archivedCount: 0,
    };
    await renderMemory();
    await screen.findByLabelText("Project notebook");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tidy" }));
    });
    expect(await screen.findByText(/still over budget/)).toBeDefined();
    expect(screen.queryByText(/Already within budget/)).toBeNull();
  });

  test("Tidy is disabled while the notebook is still loading, then enables", async () => {
    let resolveGet: (nb: { content: string; updatedAt: string | null }) => void = () => {};
    getNotebookImpl = () =>
      new Promise((resolve) => {
        resolveGet = resolve;
      });
    await renderMemory();
    const tidy = (await screen.findByRole("button", { name: "Tidy" })) as HTMLButtonElement;
    expect(tidy.disabled).toBe(true);
    await act(async () => {
      resolveGet({ content: "## Log\n- ok", updatedAt: null });
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Tidy" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  test("every ## Archive section is excluded from the over-budget calc", async () => {
    const big = "y".repeat(7000);
    loadedContent = `## Log\n- 2026-06-01: small\n\n## Archive\n- ${big}\n\n## Archive\n- ${big}\n`;
    await renderMemory();
    await screen.findByLabelText("Project notebook");
    expect(screen.queryByText(/Over budget/)).toBeNull();
  });
});
