import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import * as realApi from "../src/api.ts";

let appendCalls: Array<{ projectId: string; entry: string; section?: string }> = [];
let putCalls: Array<{ projectId: string; content: string }> = [];

mock.module("../src/api.ts", () => ({
  ...realApi,
  appendProjectNotebook: async (projectId: string, entry: string, section?: string) => {
    appendCalls.push({ projectId, entry, section });
    return { content: "## Log\n- 2026-06-01: a note\n", updatedAt: "t1", previousContent: "PREV" };
  },
  putProjectNotebook: async (projectId: string, content: string) => {
    putCalls.push({ projectId, content });
    return { content, updatedAt: "t2" };
  },
}));

async function renderHarness(projectId: string | null) {
  const { ToastHost } = await import("../src/components/Toast.tsx");
  const { useNotebookAppend } = await import("../src/hooks/useNotebookAppend.ts");
  function Harness() {
    const { appendWithUndo, saving } = useNotebookAppend(projectId);
    return (
      <button type="button" disabled={saving} onClick={() => void appendWithUndo("a note")}>
        add
      </button>
    );
  }
  return render(
    <ToastHost>
      <Harness />
    </ToastHost>,
  );
}

describe("useNotebookAppend", () => {
  beforeEach(() => {
    appendCalls = [];
    putCalls = [];
  });

  test("one-click append calls the API and shows an Undo toast", async () => {
    await renderHarness("p1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "add" }));
    });
    expect(appendCalls).toEqual([{ projectId: "p1", entry: "a note", section: undefined }]);
    expect(await screen.findByText("Added to notebook.")).toBeDefined();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeDefined();
  });

  test("Undo restores the pre-append content via PUT", async () => {
    await renderHarness("p1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "add" }));
    });
    const undo = await screen.findByRole("button", { name: "Undo" });
    await act(async () => {
      fireEvent.click(undo);
    });
    expect(putCalls).toEqual([{ projectId: "p1", content: "PREV" }]);
  });

  test("no active project → error toast, no append", async () => {
    await renderHarness(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "add" }));
    });
    expect(appendCalls).toEqual([]);
    expect(await screen.findByText(/Pick a project/)).toBeDefined();
  });
});

async function renderModal(onSubmit: (entry: string, section: string) => Promise<void>) {
  const { AddToNotebookModal } = await import("../src/components/Memory/AddToNotebookModal.tsx");
  function Wrapper() {
    const [open, setOpen] = useState(true);
    return (
      <AddToNotebookModal
        open={open}
        initialEntry="the durable fact"
        submitting={false}
        onClose={() => setOpen(false)}
        onSubmit={onSubmit}
      />
    );
  }
  return render(<Wrapper />);
}

describe("AddToNotebookModal", () => {
  test("prefills the entry and submits entry + section", async () => {
    const submissions: Array<[string, string]> = [];
    await renderModal(async (entry, section) => {
      submissions.push([entry, section]);
    });
    const entry = (await screen.findByLabelText("Entry")) as HTMLTextAreaElement;
    expect(entry.value).toBe("the durable fact");

    const section = screen.getByLabelText("Section") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(section, { target: { value: "Conventions" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(submissions).toEqual([["the durable fact", "Conventions"]]);
  });
});
