import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibAction, RibActionResult } from "@keelson/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BoardActionProvider } from "../src/components/Canvas/BoardActionContext.tsx";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";
import { configureModelCatalog } from "../src/lib/modelCatalog.ts";

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

  test("the form's submit button prefers submitLabel over the action's label", async () => {
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
              type: "convene-debate",
              label: "Debate",
              submitLabel: "Convene",
              fields: [{ name: "motion", label: "Motion" }],
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
    // The disclosure button still reads the label; only the submit renames.
    fireEvent.click(screen.getByRole("button", { name: "Debate" }));
    const submit = screen.getByRole("button", { name: "Convene" });
    expect(submit.getAttribute("type")).toBe("submit");
    fireEvent.change(container.querySelector(".cvb-action-field-input") as HTMLInputElement, {
      target: { value: "ship it" },
    });
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls).toEqual([{ type: "convene-debate", payload: { motion: "ship it" } }]),
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

  test("a tabs item renders its subtitle as a second line under the label", () => {
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={tabsBoard({ subtitle: "Explore ideas together." })} />
      </BoardActionProvider>,
    );
    const subtitle = container.querySelector(".cvb-action-subtitle");
    expect(subtitle?.textContent).toBe("Explore ideas together.");
    // The subtitle rides inside the tab button, under its label.
    const button = subtitle?.closest("button");
    expect(button?.textContent).toBe("DiscussionExplore ideas together.");
  });

  test("non-tabs layouts ignore an item's subtitle", () => {
    const view = {
      view: "board",
      sections: [
        { kind: "actions", items: [{ type: "a", label: "A", subtitle: "Stacked line." }] },
        { kind: "actions", wrap: true, items: [{ type: "b", label: "B", subtitle: "Chip line." }] },
      ],
    } as CanvasBoardView;
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    expect(container.querySelector(".cvb-action-subtitle")).toBeNull();
    expect(screen.getByRole("button", { name: "A" }).textContent).toBe("A");
    expect(screen.getByRole("button", { name: "B" }).textContent).toBe("B");
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

  test("a grid cards section renders the grid class and a ghost open seat", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "cards",
          grid: true,
          items: [
            { title: "Jarvis", dot: "id-teal" },
            {
              title: "Author a Mind",
              ghost: true,
              actions: [
                { type: "author", label: "Author", fields: [{ name: "brief", label: "Brief" }] },
              ],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    expect(container.querySelector(".cvb-cards.cvb-cards--grid")).not.toBeNull();
    const ghost = container.querySelector(".cvb-card.cvb-card--ghost");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toContain("Author a Mind");
    // A non-ghost sibling stays a plain card.
    expect(container.querySelectorAll(".cvb-card:not(.cvb-card--ghost)").length).toBe(1);
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
    const menu = screen.getByRole("menu", { name: "PostgreSQL actions" });
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
    const menu = screen.getByRole("menu", { name: "Aurora actions" });
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

describe("board actions — select fields and capability gating", () => {
  test("a select field renders a combobox and dispatches the chosen option value", async () => {
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
              type: "convene",
              label: "Discussion",
              payload: { strategy: "sequential" },
              fields: [
                {
                  name: "project",
                  label: "Project",
                  placeholder: "No project (shared)",
                  options: [
                    { value: "keelson", label: "keelson" },
                    { value: "chamber", label: "keelson-rib-chamber" },
                  ],
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
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    const select = container.querySelector("select.cvb-action-field-select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    fireEvent.change(select, { target: { value: "chamber" } });
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls).toEqual([
        { type: "convene", payload: { strategy: "sequential", project: "chamber" } },
      ]),
    );
  });

  test("a select opens on its defaultValue and an idle submit re-affirms it, not a clear", async () => {
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
              type: "set-model",
              label: "Model — sonnet",
              payload: { slug: "aria" },
              fields: [
                {
                  name: "model",
                  label: "Model",
                  defaultValue: "sonnet",
                  options: [
                    { value: "opus", label: "opus" },
                    { value: "sonnet", label: "sonnet" },
                  ],
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
    fireEvent.click(screen.getByRole("button", { name: "Model — sonnet" }));
    const select = container.querySelector("select.cvb-action-field-select") as HTMLSelectElement;
    // Opens on the pinned model, not the empty "clear" option.
    expect(select.value).toBe("sonnet");
    // Submitting an untouched form re-affirms the pin; without the seed this would
    // dispatch no model, which a producer reading absent-as-clear treats as a wipe.
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls).toEqual([{ type: "set-model", payload: { slug: "aria", model: "sonnet" } }]),
    );
  });

  test("a changed default re-seeds a closed form, but never clobbers an open one", async () => {
    // Sections are keyed positionally (a live board's tick must not remount a
    // sibling's open form), so a moved pin reaches the form via the closed-form
    // re-seed effect: an OPEN form keeps its state, a closed one reopens on the
    // new default.
    const modelView = (defaultValue: string): CanvasBoardView =>
      ({
        view: "board",
        sections: [
          {
            kind: "actions",
            items: [
              {
                type: "set-model",
                label: `Model — ${defaultValue}`,
                payload: { slug: "aria" },
                fields: [
                  {
                    name: "model",
                    label: "Model",
                    defaultValue,
                    options: [
                      { value: "opus", label: "opus" },
                      { value: "sonnet", label: "sonnet" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }) as CanvasBoardView;
    const { container, rerender } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={modelView("sonnet")} />
      </BoardActionProvider>,
    );
    const sel = () =>
      container.querySelector("select.cvb-action-field-select") as HTMLSelectElement;
    fireEvent.click(screen.getByRole("button", { name: "Model — sonnet" }));
    expect(sel().value).toBe("sonnet");
    rerender(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={modelView("opus")} />
      </BoardActionProvider>,
    );
    // The open form keeps its state — a background frame never clobbers input.
    expect(sel().value).toBe("sonnet");
    // Closed and reopened, the form seeds from the new default. The submit
    // button shares the label while the form is open, so target the disclosure
    // (the .cvb-action's direct child).
    const disclosure = () =>
      container.querySelector(".cvb-action > button.cvb-action-button") as HTMLButtonElement;
    fireEvent.click(disclosure());
    fireEvent.click(disclosure());
    expect(sel().value).toBe("opus");
  });

  test("an open form keeps its typing while a sibling card ticks", async () => {
    // The chamber bench shape: a boot card whose elapsed count re-publishes
    // every few seconds beside the open seat's always-open brief. The tick must
    // not remount the section (positional key) or the seat's card (its own JSON
    // is unchanged) — typing survives the frame.
    const bench = (elapsed: number): CanvasBoardView =>
      ({
        view: "board",
        sections: [
          {
            kind: "cards",
            grid: true,
            columns: 4,
            items: [
              {
                title: "Moneypenny",
                stacked: true,
                fields: [{ value: `voice: calibrating… · ${elapsed}s` }],
              },
              {
                title: "Open seat",
                ghost: true,
                actions: [
                  {
                    type: "describe-own",
                    label: "Author",
                    expanded: true,
                    fields: [{ name: "brief", label: "Brief", multiline: true }],
                  },
                ],
              },
            ],
          },
        ],
      }) as CanvasBoardView;
    const { container, rerender } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={bench(5)} />
      </BoardActionProvider>,
    );
    const box = () => container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: "Athena — guards the architecture" } });
    expect(box().value).toBe("Athena — guards the architecture");
    rerender(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={bench(7)} />
      </BoardActionProvider>,
    );
    expect(box().value).toBe("Athena — guards the architecture");
  });

  test("an open form keeps its typing while its OWN card's status ticks", async () => {
    // The same-card variant: one seat carrying both an always-open brief and a
    // status field that re-publishes each frame. Keying the card by its stable
    // title (not its JSON) keeps the form mounted through the card's own tick —
    // a JSON key would remount the whole card and wipe the textarea.
    const seat = (elapsed: number): CanvasBoardView =>
      ({
        view: "board",
        sections: [
          {
            kind: "cards",
            grid: true,
            columns: 4,
            items: [
              {
                title: "Open seat",
                ghost: true,
                stacked: true,
                fields: [{ value: `booting… · ${elapsed}s` }],
                actions: [
                  {
                    type: "describe-own",
                    label: "Author",
                    expanded: true,
                    fields: [{ name: "brief", label: "Brief", multiline: true }],
                  },
                ],
              },
            ],
          },
        ],
      }) as CanvasBoardView;
    const { container, rerender } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={seat(5)} />
      </BoardActionProvider>,
    );
    const box = () => container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: "Athena — guards the architecture" } });
    expect(box().value).toBe("Athena — guards the architecture");
    rerender(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={seat(7)} />
      </BoardActionProvider>,
    );
    expect(box().value).toBe("Athena — guards the architecture");
  });

  test("a text field opens pre-filled from its defaultValue", async () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            {
              type: "rename",
              label: "Rename",
              fields: [{ name: "name", label: "Name", defaultValue: "Aria" }],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect((container.querySelector(".cvb-action-field-input") as HTMLInputElement).value).toBe(
      "Aria",
    );
  });

  test("a disabled action item is non-clickable and carries its reason as a tooltip", async () => {
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
          tabs: true,
          items: [
            { type: "convene", label: "Debate", disabled: true, reason: "Free a Mind to chair." },
            { type: "convene", label: "Discussion" },
          ],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    const debate = screen.getByRole("button", { name: "Debate" });
    // aria-disabled (not native disabled) so hover survives and the reason tooltip
    // actually shows in a real browser; the dispatch stays guarded to a no-op.
    expect(debate).toHaveProperty("disabled", false);
    expect(debate.getAttribute("aria-disabled")).toBe("true");
    expect(debate.getAttribute("title")).toBe("Free a Mind to chair.");
    fireEvent.click(debate);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    // The enabled sibling still dispatches on click.
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    await waitFor(() => expect(calls).toEqual([{ type: "convene" }]));
  });

  test("an action `hint` renders as a hover tooltip; a disabled action shows hint then reason", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          tabs: true,
          items: [
            { type: "convene", label: "Review", hint: "Two-Mind cross-vendor critique." },
            {
              type: "convene",
              label: "Debate",
              hint: "Chaired multi-Mind debate.",
              disabled: true,
              reason: "Free a Mind to chair.",
            },
          ],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    expect(screen.getByRole("button", { name: "Review" }).getAttribute("title")).toBe(
      "Two-Mind cross-vendor critique.",
    );
    expect(screen.getByRole("button", { name: "Debate" }).getAttribute("title")).toBe(
      "Chaired multi-Mind debate. — Free a Mind to chair.",
    );
  });

  test("a sealed (disabled) action's open form can't dispatch — controls disabled, submit guarded", async () => {
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
              type: "build",
              label: "Build",
              expanded: true,
              disabled: true,
              hint: "Manager-led build.",
              reason: "Free a Mind to manage.",
              fields: [{ name: "topic", label: "Topic" }],
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
    const input = container.querySelector(".cvb-action-field-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const submit = screen.getByRole("button", { name: "Build" });
    expect(submit).toHaveProperty("disabled", false);
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.classList.contains("is-disabled")).toBe(true);
    expect(submit.getAttribute("title")).toBe("Manager-led build. — Free a Mind to manage.");
    // An Enter-key / programmatic submit on the open form is guarded — nothing dispatches.
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  test("a disabled card overflow action carries its combined tooltip and stays inert", async () => {
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
              actions: [
                {
                  type: "delete",
                  label: "Delete",
                  destructive: true,
                  hint: "Drop the cluster.",
                  disabled: true,
                  reason: "Cluster is suspended.",
                },
              ],
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
    const menu = screen.getByRole("menu", { name: "PostgreSQL actions" });
    const item = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe("Drop the cluster. — Cluster is suspended.");
    fireEvent.click(item);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });
});

describe("model picker action fields", () => {
  // The catalog is injected through configureModelCatalog rather than
  // mock.module(api.ts) — several suites mock that module process-globally,
  // and this seam keeps these tests hermetic regardless of file order.
  beforeEach(() => {
    stubCatalog();
  });
  afterEach(() => {
    configureModelCatalog();
  });

  function stubCatalog() {
    configureModelCatalog({
      fetchProviders: async () => ({
        providers: [
          {
            id: "pi",
            displayName: "Pi (community)",
            capabilities: {
              sessionResume: false,
              streaming: true,
              tools: false,
              models: [],
              defaultModel: "",
            },
            builtIn: true,
          },
        ],
        defaultProvider: null,
      }),
      fetchProviderModels: async () => [
        { id: "anthropic/claude-opus-4.5", displayName: "Claude Opus 4.5" },
        { id: "google/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      ],
    });
  }

  // The popover body's rows mount only while genuinely open, and happy-dom
  // doesn't implement the declarative Popover API well enough for a plain
  // click to fire a real "toggle" event — so tests open a picker by
  // dispatching that event themselves, exactly like the browser would on a
  // real popovertarget click.
  function openPicker(trigger: HTMLElement): HTMLElement {
    const targetId = trigger.getAttribute("popovertarget");
    if (!targetId) throw new Error("trigger has no popovertarget");
    const popoverEl = document.getElementById(targetId);
    if (!popoverEl) throw new Error(`no element with id ${targetId}`);
    const evt = new Event("toggle");
    Object.defineProperty(evt, "newState", { value: "open", configurable: true });
    act(() => {
      popoverEl.dispatchEvent(evt);
    });
    return popoverEl;
  }

  function soloPickerItem(slug: string, defaults?: { model?: string; provider?: string }) {
    return {
      type: "set-model",
      label: `Model — ${defaults?.model ?? "default"} (${slug})`,
      payload: { slug },
      fields: [
        {
          name: "model",
          label: "Model",
          placeholder: "default (inherit)",
          modelPicker: {
            providerField: "provider",
            ...(defaults?.provider ? { providerDefault: defaults.provider } : {}),
          },
          ...(defaults?.model ? { defaultValue: defaults.model } : {}),
        },
      ],
    };
  }

  test("an action whose only field is a picker skips the form and dispatches model + provider on pick", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView view={actionsBoard([soloPickerItem("ada") as never])} />
      </BoardActionProvider>,
    );
    // No intermediate form renders — the button is the picker trigger.
    expect(container.querySelector(".cvb-action-form")).toBeNull();
    // Rows lazy-mount only while the popover is open — nothing to find yet.
    expect(screen.queryByText("Claude Opus 4.5")).toBeNull();
    openPicker(screen.getByRole("button", { name: "Model — default (ada)" }));
    fireEvent.click(await screen.findByText("Claude Opus 4.5"));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          type: "set-model",
          payload: { slug: "ada", model: "anthropic/claude-opus-4.5", provider: "pi" },
        },
      ]),
    );
  });

  test("the clear row dispatches empty model and provider over the seeded defaults", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView
          view={actionsBoard([
            soloPickerItem("ada", { model: "anthropic/claude-opus-4.5", provider: "pi" }) as never,
          ])}
        />
      </BoardActionProvider>,
    );
    openPicker(screen.getByRole("button", { name: "Model — anthropic/claude-opus-4.5 (ada)" }));
    fireEvent.click(await screen.findByText("default (inherit)"));
    await waitFor(() =>
      expect(calls).toEqual([
        { type: "set-model", payload: { slug: "ada", model: "", provider: "" } },
      ]),
    );
  });

  test("repeated picker actions anchor and dispatch per card, with unique popover ids", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView
          view={actionsBoard([soloPickerItem("ada") as never, soloPickerItem("bo") as never])}
        />
      </BoardActionProvider>,
    );
    const anchors = [...container.querySelectorAll(".cvb-action-button[popovertarget]")];
    const targets = anchors.map((a) => a.getAttribute("popovertarget"));
    expect(targets).toHaveLength(2);
    expect(new Set(targets).size).toBe(2);
    // Nothing is mounted before either popover opens.
    expect(screen.queryByText("Gemini 2.5 Pro")).toBeNull();
    // Opening the SECOND card's popover surfaces only its own row (proof the
    // unique ids actually anchor each card to its own catalog, not a shared
    // or the first card's), and picking it dispatches the second card's payload.
    openPicker(screen.getByRole("button", { name: "Model — default (bo)" }));
    const rows = await screen.findAllByText("Gemini 2.5 Pro");
    expect(rows).toHaveLength(1);
    fireEvent.click(rows[0] as HTMLElement);
    await waitFor(() =>
      expect(calls).toEqual([
        {
          type: "set-model",
          payload: { slug: "bo", model: "google/gemini-2.5-pro", provider: "pi" },
        },
      ]),
    );
  });

  test("a picker alongside another field keeps the form, and an untouched submit re-affirms the defaults", async () => {
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
              type: "set-model",
              label: "Configure",
              payload: { slug: "ada" },
              fields: [
                {
                  name: "model",
                  label: "Model",
                  defaultValue: "anthropic/claude-opus-4.5",
                  modelPicker: { providerField: "provider", providerDefault: "pi" },
                },
                { name: "note", label: "Note" },
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
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    const form = container.querySelector(".cvb-action-form") as HTMLFormElement;
    expect(form).not.toBeNull();
    fireEvent.submit(form);
    // The provider companion seeds from providerDefault, so an idle submit
    // re-affirms the current provider/model pair instead of wiping the pin.
    await waitFor(() =>
      expect(calls).toEqual([
        {
          type: "set-model",
          payload: { slug: "ada", model: "anthropic/claude-opus-4.5", provider: "pi" },
        },
      ]),
    );
  });
});

describe("create-form affordances", () => {
  test("a tabs strip opens the first enabled defaultOpen item's form; the operator's toggle wins after", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          tabs: true,
          items: [
            {
              type: "create",
              label: "aws",
              disabled: true,
              reason: "coming soon",
              defaultOpen: true,
              fields: [{ name: "env", label: "AWS env" }],
            },
            {
              // A solo model-picker opens a popover, not an inline form — it
              // must not claim the open slot ahead of a form-bearing sibling.
              type: "set-model",
              label: "Model",
              defaultOpen: true,
              fields: [{ name: "model", label: "Model", modelPicker: {} }],
            },
            {
              type: "create",
              label: "kind",
              defaultOpen: true,
              // Distinct from the tab label so getByRole("kind") stays unique
              // while the form (whose submit defaults to the label) is open.
              submitLabel: "Create cluster",
              fields: [{ name: "env", label: "Environment" }],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    // The disabled defaultOpen item is skipped; the first enabled one opens.
    expect(screen.getByLabelText("Environment")).not.toBeNull();
    expect(screen.queryByLabelText("AWS env")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "kind" }));
    expect(screen.queryByLabelText("Environment")).toBeNull();
  });

  test("a segmented field selects by press and dispatches the chosen option value", async () => {
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
              type: "create",
              label: "Create",
              expanded: true,
              fields: [
                {
                  name: "profile",
                  label: "Profile",
                  segmented: true,
                  placeholder: "cimpl default",
                  options: [
                    { value: "core", label: "core" },
                    { value: "full", label: "full" },
                  ],
                },
              ],
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
    // The optional field leads with a clear segment, pressed while unset.
    const clear = screen.getByRole("button", { name: "cimpl default" });
    expect(clear.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "full" }));
    expect(screen.getByRole("button", { name: "full" }).getAttribute("aria-pressed")).toBe("true");
    expect(clear.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls).toEqual([{ type: "create", payload: { profile: "full" } }]));
  });

  test("half fields carry the two-up class; full-width fields do not", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          items: [
            {
              type: "create",
              label: "Create",
              expanded: true,
              fields: [
                { name: "env", label: "Environment", half: true },
                { name: "partition", label: "Partition" },
              ],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    const fields = container.querySelectorAll(".cvb-action-field");
    expect(fields[0]?.classList.contains("cvb-action-field--half")).toBe(true);
    expect(fields[1]?.classList.contains("cvb-action-field--half")).toBe(false);
  });

  test("submitTone styles the submit without tinting the tab, and falls back to tone", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          tabs: true,
          items: [
            {
              type: "create",
              label: "kind",
              submitTone: "brand",
              submitLabel: "Create cluster",
              defaultOpen: true,
              fields: [{ name: "env", label: "Environment" }],
            },
          ],
        },
        {
          kind: "actions",
          items: [
            {
              type: "author",
              label: "Author",
              tone: "brand",
              expanded: true,
              fields: [{ name: "brief", label: "Brief" }],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    expect(screen.getByRole("button", { name: "kind" }).getAttribute("data-tone")).toBeNull();
    expect(screen.getByRole("button", { name: "Create cluster" }).getAttribute("data-tone")).toBe(
      "brand",
    );
    // Without submitTone the submit keeps wearing the item's own tone.
    expect(screen.getByRole("button", { name: "Author" }).getAttribute("data-tone")).toBe("brand");
  });

  test("a selected toggle carries its state to assistive tech, not just to the eye", async () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "actions",
          wrap: true,
          items: [
            { type: "set-tier", label: "Can edit", selected: true },
            { type: "set-tier", label: "Can publish", selected: false },
            { type: "convene", label: "Convene" },
          ],
        },
      ],
    } as CanvasBoardView;
    render(
      <BoardActionProvider run={okRun} reveal={okReveal}>
        <BoardView view={view} />
      </BoardActionProvider>,
    );
    const on = screen.getByRole("button", { name: "Can edit" });
    const off = screen.getByRole("button", { name: "Can publish" });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(off.getAttribute("aria-pressed")).toBe("false");
    expect(on.className).toContain("is-selected");
    expect(off.className).not.toContain("is-selected");
    // A plain verb action declares no toggle, so it announces no pressed state at all.
    expect(screen.getByRole("button", { name: "Convene" }).getAttribute("aria-pressed")).toBeNull();
  });

  test("a selected toggle still dispatches on click", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView
          view={
            {
              view: "board",
              sections: [
                {
                  kind: "actions",
                  items: [
                    {
                      type: "scope-set",
                      label: "Can edit",
                      selected: true,
                      payload: { on: false },
                    },
                  ],
                },
              ],
            } as CanvasBoardView
          }
        />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Can edit" }));
    await waitFor(() => expect(calls).toEqual([{ type: "scope-set", payload: { on: false } }]));
  });
});
