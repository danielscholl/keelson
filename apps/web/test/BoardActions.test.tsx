import { afterEach, describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibAction, RibActionResult } from "@keelson/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BoardActionProvider } from "../src/components/Canvas/BoardActionContext.tsx";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";

// Dispatch is injected at the provider, so these tests never touch api.ts —
// sidestepping bun's process-global mock.module leakage that other web suites
// (Canvas/Surface) are sensitive to.

const okRun = async (): Promise<RibActionResult> => ({ ok: true });
const okReveal = async (): Promise<RibActionResult> => ({ ok: true });

function actionsBoard(
  items: { type: string; label: string; glyph?: string; tone?: string; destructive?: boolean }[],
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
  test("renders a button per item and dispatches its type via run on click", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={actionsBoard([{ type: "reconcile", label: "Reconcile" }])} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() => expect(calls).toEqual([{ type: "reconcile" }]));
  });

  test("renders a leading glyph before the action label", () => {
    render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={actionsBoard([{ type: "reconcile", label: "Reconcile", glyph: "↻" }])} />
      </BoardActionProvider>,
    );
    const button = screen.getByRole("button", { name: "Reconcile" });
    expect(button.querySelector(".cvb-action-glyph")?.textContent).toBe("↻");
  });

  test("a destructive action confirms before dispatching", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = actionsBoard([{ type: "delete", label: "Delete", destructive: true }]);

    globalThis.confirm = () => false;
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
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
    const run = (_a: RibAction): Promise<RibActionResult> =>
      new Promise((r) => {
        resolve = r;
      });
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
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

describe("copy-on-reveal field", () => {
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  });

  function credentialBoard(): CanvasBoardView {
    return {
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "PostgreSQL",
              dot: "neutral",
              fields: [
                {
                  label: "admin",
                  value: "postgres",
                  copyAction: { type: "reveal-credential", payload: { service: "postgresql" } },
                },
              ],
            },
          ],
        },
      ],
    } as CanvasBoardView;
  }

  test("reveals via the rib and copies the returned data, never the value", async () => {
    const calls: RibAction[] = [];
    const reveal = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true, data: "s3cr3t-from-rib" };
    };
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });

    render(
      <BoardActionProvider run={okRun} reveal={reveal}>
        <BoardView view={credentialBoard()} />
      </BoardActionProvider>,
    );
    // The username (value) is shown; the password is not in the payload at all.
    expect(screen.getByText("postgres")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy admin" }));

    await waitFor(() =>
      expect(calls).toEqual([{ type: "reveal-credential", payload: { service: "postgresql" } }]),
    );
    await waitFor(() => expect(written).toEqual(["s3cr3t-from-rib"]));
  });

  test("the copy button renders disabled with no provider in scope", () => {
    render(<BoardView view={credentialBoard()} />);
    expect(screen.getByRole("button", { name: "Copy admin" })).toHaveProperty("disabled", true);
  });
});

describe("board layout primitives", () => {
  test("a columns section renders each column's nested sections", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "columns",
          columns: [
            {
              weight: 1.4,
              sections: [
                {
                  kind: "rows",
                  title: "Lifecycle",
                  items: [{ text: "Flux reconciled", glyph: "ok" }],
                },
              ],
            },
            {
              weight: 1,
              sections: [
                {
                  kind: "actions",
                  title: "Actions",
                  items: [{ type: "reconcile", label: "Reconcile" }],
                },
              ],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    render(<BoardView view={view} />);
    expect(screen.getByText("Lifecycle")).toBeDefined();
    expect(screen.getByText("Flux reconciled")).toBeDefined();
    expect(screen.getByText("Actions")).toBeDefined();
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeDefined();
  });

  test("a card renders a toned status dot", () => {
    const view = {
      view: "board",
      sections: [{ kind: "cards", items: [{ title: "Airflow", dot: "ok" }] }],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    expect(container.querySelector('.cvb-card-dot[data-tone="ok"]')).not.toBeNull();
  });

  test("the header renders a toned status pill", () => {
    const view = {
      view: "board",
      header: { status: { label: "✓ Healthy", tone: "ok" } },
      sections: [],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const pill = container.querySelector('.cvb-header-status[data-tone="ok"]');
    expect(pill?.textContent).toBe("✓ Healthy");
  });
});
