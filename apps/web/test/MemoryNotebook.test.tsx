import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as realApi from "../src/api.ts";

let savedContent: string | null = null;

mock.module("../src/api.ts", () => ({
  ...realApi,
  listProjects: async () => [
    { id: "p1", name: "demo", rootPath: "/tmp/demo", createdAt: "2026-01-01T00:00:00Z" },
  ],
  getProjectNotebook: async () => ({ content: "## Gotchas\n- existing note", updatedAt: null }),
  putProjectNotebook: async (_id: string, content: string) => {
    savedContent = content;
    return { content, updatedAt: "2026-06-01T00:00:00Z" };
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
});
