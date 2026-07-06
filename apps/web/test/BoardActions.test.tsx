import { afterEach, describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibAction, RibActionResult } from "@keelson/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  test("a wrap actions section renders the wrap layout class", () => {
    const view = {
      view: "board",
      sections: [
        { kind: "actions", wrap: true, items: [{ type: "a", label: "A" }] },
        { kind: "actions", items: [{ type: "b", label: "B" }] },
      ],
    } as CanvasBoardView;
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    const sections = container.querySelectorAll(".cvb-actions");
    expect(sections[0]?.classList.contains("cvb-actions--wrap")).toBe(true);
    expect(sections[1]?.classList.contains("cvb-actions--wrap")).toBe(false);
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

  test("a destructive action routes through ConfirmModal before dispatching", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = actionsBoard([{ type: "delete", label: "Delete", destructive: true }]);

    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.querySelector(".confirm-modal-cancel") as HTMLButtonElement);
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmDialog = screen.getByRole("dialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toEqual([{ type: "delete" }]));
  });

  test("typed confirmation keeps confirm disabled until the subject matches exactly", async () => {
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
              type: "retire",
              label: "Retire",
              destructive: true,
              confirm: {
                irreversible: true,
                subject: "cluster-a",
                label: "Type cluster name",
                confirmLabel: "Retire",
              },
            },
          ],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Retire" });
    const input = within(dialog).getByRole("textbox", { name: "Type cluster name" });

    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "cluster-b" } });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "cluster-a" } });
    expect(confirm).toHaveProperty("disabled", false);

    fireEvent.click(confirm);
    await waitFor(() => expect(calls).toEqual([{ type: "retire" }]));
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

  test("an expanded action renders its form open with the label as submit", async () => {
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
              type: "describe-own",
              label: "Author",
              glyph: "✦",
              tone: "brand",
              expanded: true,
              fields: [
                { name: "brief", label: "Who should this Mind feel like?", multiline: true },
              ],
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
    // The form is open on mount — no disclosure toggle, no Cancel.
    expect(container.querySelector(".cvb-action-form")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const buttons = screen.getAllByRole("button", { name: /Author/ });
    expect(buttons).toHaveLength(1);
    const input = container.querySelector(".cvb-action-field-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "a skeptical staff engineer" } });
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls).toEqual([
        { type: "describe-own", payload: { brief: "a skeptical staff engineer" } },
      ]),
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
    // This render → submit → reopen flow runs ~5.2s on the Windows CI runner,
    // marginally over Bun's 5000ms default; give it headroom so it stops flaking.
  }, 15000);
});

describe("tabs actions section", () => {
  function tabsBoard(extra?: Record<string, unknown>): CanvasBoardView {
    return {
      view: "board",
      sections: [
        {
          kind: "actions",
          tabs: true,
          items: [
            {
              type: "convene-discussion",
              label: "Discussion",
              fields: [{ name: "topic", label: "Topic" }],
              ...(extra ?? {}),
            },
            {
              type: "convene-debate",
              label: "Debate",
              fields: [{ name: "motion", label: "Motion" }],
            },
            { type: "refresh", label: "Refresh" },
          ],
        },
      ],
    } as CanvasBoardView;
  }

  test("a tabs section renders the tabs layout class and takes precedence over wrap", () => {
    const view = {
      view: "board",
      sections: [{ kind: "actions", tabs: true, wrap: true, items: [{ type: "a", label: "A" }] }],
    } as CanvasBoardView;
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    const section = container.querySelector(".cvb-actions");
    expect(section?.classList.contains("cvb-actions--tabs")).toBe(true);
    expect(section?.classList.contains("cvb-actions--wrap")).toBe(false);
  });

  test("opening one tab closes the other — exactly one form exists at a time", () => {
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={tabsBoard()} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Debate" }));
    expect(screen.getByText("Motion")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    expect(screen.getByText("Topic")).toBeDefined();
    expect(screen.queryByText("Motion")).toBeNull();
    expect(container.querySelectorAll(".cvb-action-form")).toHaveLength(1);
  });

  test("clicking the active tab closes its form", () => {
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={tabsBoard()} />
      </BoardActionProvider>,
    );
    const tab = screen.getByRole("button", { name: "Debate" });
    fireEvent.click(tab);
    expect(container.querySelector(".cvb-action-form")).not.toBeNull();
    fireEvent.click(tab);
    expect(container.querySelector(".cvb-action-form")).toBeNull();
  });

  test("expanded is inert inside a tabs section — the form stays closed until opened", () => {
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={tabsBoard({ expanded: true })} />
      </BoardActionProvider>,
    );
    expect(container.querySelector(".cvb-action-form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    expect(container.querySelector(".cvb-action-form")).not.toBeNull();
  });

  test("an item without fields still dispatches on click, leaving the open tab alone", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={tabsBoard()} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Debate" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls).toEqual([{ type: "refresh" }]));
    expect(container.querySelectorAll(".cvb-action-form")).toHaveLength(1);
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

  test("card destructive actions are available from the overflow menu with keyboard open", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = {
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "PostgreSQL",
              actions: [{ type: "delete", label: "Delete", destructive: true }],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );

    const trigger = screen.getByRole("button", { name: "PostgreSQL actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "PostgreSQL destructive actions" });
    const item = within(menu).getByRole("menuitem", { name: "Delete" });
    fireEvent.click(item);

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toEqual([{ type: "delete" }]));
  });
});

describe("inline card actions", () => {
  test("a non-destructive card action renders as an inline button that dispatches", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = {
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "Aurora",
              actions: [{ type: "enter", label: "Enter", payload: { mind: "aurora" } }],
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

    const row = container.querySelector(".cvb-card-actions");
    expect(row).not.toBeNull();
    const button = within(row as HTMLElement).getByRole("button", { name: "Enter" });
    fireEvent.click(button);
    await waitFor(() => expect(calls).toEqual([{ type: "enter", payload: { mind: "aurora" } }]));
  });

  test("a destructive card action stays in the overflow, not an inline button", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = {
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "Aurora",
              actions: [{ type: "delete", label: "Delete", destructive: true }],
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

    // No inline action row — the destructive verb lives only in the overflow.
    expect(container.querySelector(".cvb-card-actions")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Aurora actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Aurora destructive actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toEqual([{ type: "delete" }]));
  });

  test("an inline action with fields toggles a form and dispatches collected values", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const view = {
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "Rooms",
              actions: [
                {
                  type: "room-start",
                  label: "Open",
                  fields: [{ name: "topic", label: "Topic", placeholder: "What to discuss?" }],
                },
              ],
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

    const row = container.querySelector(".cvb-card-actions") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Open" }));
    // The form opens without dispatching; filling + submitting carries the value.
    const input = row.querySelector(".cvb-action-field-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(calls).toHaveLength(0);
    fireEvent.change(input, { target: { value: "ship the rib" } });
    fireEvent.submit(row.querySelector(".cvb-action-form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls).toEqual([{ type: "room-start", payload: { topic: "ship the rib" } }]),
    );
  });

  test("a card with both kinds renders non-destructive inline and destructive in the overflow", () => {
    const run = async (): Promise<RibActionResult> => ({ ok: true });
    const view = {
      view: "board",
      sections: [
        {
          kind: "cards",
          items: [
            {
              title: "Aurora",
              actions: [
                { type: "enter", label: "Enter", payload: { mind: "aurora" } },
                { type: "retire", label: "Retire", destructive: true, payload: { mind: "aurora" } },
              ],
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

    const row = within(container.querySelector(".cvb-card-actions") as HTMLElement);
    expect(row.getByRole("button", { name: "Enter" })).not.toBeNull();
    expect(row.queryByRole("button", { name: "Retire" })).toBeNull();
    expect(screen.getByRole("button", { name: "Aurora actions" })).not.toBeNull();
  });
});
