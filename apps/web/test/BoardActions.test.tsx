import { afterEach, describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibAction, RibActionResult } from "@keelson/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BoardActionProvider } from "../src/components/Canvas/BoardActionContext.tsx";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";

// Dispatch is injected at the provider, so these tests never touch api.ts —
// sidestepping bun's process-global mock.module leakage that other web suites
// (Canvas/Surface) are sensitive to.

function actionsBoard(
  items: { type: string; label: string; tone?: string; destructive?: boolean }[],
): CanvasBoardView {
  return {
    view: "board",
    title: "Cluster",
    sections: [{ kind: "actions", items }],
  } as CanvasBoardView;
}

const realConfirm = globalThis.confirm;
afterEach(() => {
  globalThis.confirm = realConfirm;
});

describe("board actions", () => {
  test("renders a button per item and dispatches its type on click", async () => {
    const calls: RibAction[] = [];
    const dispatch = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    render(
      <BoardActionProvider dispatch={dispatch}>
        <BoardView view={actionsBoard([{ type: "reconcile", label: "Reconcile" }])} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() => expect(calls).toEqual([{ type: "reconcile" }]));
  });

  test("a destructive action confirms before dispatching", async () => {
    const calls: RibAction[] = [];
    const dispatch = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = actionsBoard([{ type: "delete", label: "Delete", destructive: true }]);

    globalThis.confirm = () => false;
    render(
      <BoardActionProvider dispatch={dispatch}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    globalThis.confirm = () => true;
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toEqual([{ type: "delete" }]));
  });

  test("buttons render disabled when no provider is in scope", () => {
    render(<BoardView view={actionsBoard([{ type: "reconcile", label: "Reconcile" }])} />);
    expect(screen.getByRole("button", { name: "Reconcile" })).toHaveProperty("disabled", true);
  });

  test("a button disables while its dispatch is in flight", async () => {
    let resolve: ((r: RibActionResult) => void) | null = null;
    const dispatch = (_a: RibAction): Promise<RibActionResult> =>
      new Promise((r) => {
        resolve = r;
      });
    render(
      <BoardActionProvider dispatch={dispatch}>
        <BoardView view={actionsBoard([{ type: "reconcile", label: "Reconcile" }])} />
      </BoardActionProvider>,
    );
    const btn = screen.getByRole("button", { name: "Reconcile" });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveProperty("disabled", true));
    resolve?.({ ok: true });
    await waitFor(() => expect(btn).toHaveProperty("disabled", false));
  });
});
