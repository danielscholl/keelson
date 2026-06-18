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

  test("dispatches an action's payload when present", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [{ type: "reconcile", label: "Reconcile", payload: { context: "ctx-a" } }],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() =>
      expect(calls).toEqual([{ type: "reconcile", payload: { context: "ctx-a" } }]),
    );
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

describe("board actions with input fields", () => {
  function fieldsBoard(): CanvasBoardView {
    return {
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            {
              type: "room-start",
              label: "Start room",
              fields: [{ name: "topic", label: "Topic", placeholder: "What to discuss?" }],
            },
          ],
        },
      ],
    } as CanvasBoardView;
  }

  test("clicking the action opens an inline form instead of dispatching", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={fieldsBoard()} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    // The form's labelled input appears; nothing dispatched yet.
    expect(screen.getByText("Topic")).toBeDefined();
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  test("submitting the form merges collected values into the dispatched payload", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={fieldsBoard()} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    const input = container.querySelector(".cvb-action-field-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ship the rib" } });
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls).toEqual([{ type: "room-start", payload: { topic: "ship the rib" } }]),
    );
  });

  test("a required field blocks dispatch until filled", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            {
              type: "room-start",
              label: "Start room",
              fields: [{ name: "topic", label: "Topic", required: true }],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(screen.getByText("Topic is required")).toBeDefined();
  });

  test("a failed submit keeps the form open, preserves input, and shows the error inline", async () => {
    const run = async (): Promise<RibActionResult> => ({ ok: false, error: "boom" });
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={fieldsBoard()} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    const input = container.querySelector(".cvb-action-field-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ship the rib" } });
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);

    await waitFor(() =>
      expect(container.querySelector(".cvb-action-form-error")?.textContent).toBe("boom"),
    );
    // The form stays open with the typed value intact so the user can retry.
    expect(container.querySelector(".cvb-action-form")).not.toBeNull();
    expect((container.querySelector(".cvb-action-field-input") as HTMLInputElement).value).toBe(
      "ship the rib",
    );
  });

  test("a successful submit closes the form and clears the input", async () => {
    const run = async (): Promise<RibActionResult> => ({ ok: true });
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={fieldsBoard()} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    fireEvent.change(container.querySelector(".cvb-action-field-input") as HTMLInputElement, {
      target: { value: "ship the rib" },
    });
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);

    await waitFor(() => expect(container.querySelector(".cvb-action-form")).toBeNull());
    // Reopening starts from a cleared input — success reset the collected values.
    fireEvent.click(screen.getByRole("button", { name: "Start room" }));
    expect((container.querySelector(".cvb-action-field-input") as HTMLInputElement).value).toBe("");
  });
});

describe("copy-on-reveal field", () => {
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (realClipboard) {
      Object.defineProperty(navigator, "clipboard", realClipboard);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
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

  test("boxed rows and boxed cards render their modifier classes", () => {
    const view = {
      view: "board",
      sections: [
        { kind: "rows", boxed: true, items: [{ text: "Context", glyph: "ok", trailing: "kind" }] },
        {
          kind: "cards",
          boxed: true,
          items: [{ title: "PostgreSQL", fields: [{ value: "postgres", copyable: true }] }],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    expect(container.querySelector(".cvb-rows.cvb-rows--boxed")).not.toBeNull();
    expect(container.querySelector(".cvb-cards.cvb-cards--boxed")).not.toBeNull();
    // A boxed credential field copies via an icon button, addressed by its value.
    expect(screen.getByRole("button", { name: "Copy postgres" })).toBeDefined();
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
