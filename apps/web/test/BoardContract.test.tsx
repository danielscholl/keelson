import { describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibAction, RibActionResult } from "@keelson/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BoardActionProvider } from "../src/components/Canvas/BoardActionContext.tsx";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";

// Board item contract: unmeasured (null) rendering, the shared card/row bar,
// rows action/selected parity, icon-only corner actions, prose fields, and the
// binding merge order. Dispatch is injected at the provider (no mock.module),
// matching BoardActions.test.tsx.

const okReveal = async (): Promise<RibActionResult> => ({ ok: true });

function board(sections: unknown[]): CanvasBoardView {
  return { view: "board", sections } as CanvasBoardView;
}

describe("unmeasured is not zero", () => {
  test("a null header segment renders a hatched strip slot and a ? legend; zero stays legend-only", () => {
    const view = {
      view: "board",
      header: {
        segments: [
          { label: "ready", n: 4, tone: "ok" },
          { label: "blocked", n: null },
          { label: "review", n: 0 },
        ],
      },
      sections: [],
    } as unknown as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    // The measured segment and the unmeasured slot fill the strip; the zero is
    // taught by the legend alone.
    expect(container.querySelectorAll(".cvb-strip-fill").length).toBe(2);
    expect(container.querySelectorAll(".cvb-strip-fill--unmeasured").length).toBe(1);
    expect(container.textContent).toContain("? blocked");
    expect(container.textContent).toContain("0 review");
  });

  test("a bars item with value null renders the hatch and a ? readout; a real zero reads 0%", () => {
    const { container } = render(
      <BoardView
        view={board([
          {
            kind: "bars",
            items: [
              { label: "api", value: null, total: 12 },
              { label: "web", value: 0, total: 12 },
            ],
          },
        ])}
      />,
    );
    expect(container.querySelectorAll(".cvb-bar-fill--unmeasured").length).toBe(1);
    const trailing = [...container.querySelectorAll(".cvb-bar-trailing")].map(
      (el) => el.textContent,
    );
    expect(trailing).toEqual(["?", "0%"]);
  });

  test("a stat value of null renders a muted ?; a real zero renders 0", () => {
    const { container } = render(
      <BoardView
        view={board([
          {
            kind: "stats",
            items: [
              { label: "Pass rate", value: null },
              { label: "Failures", value: 0 },
            ],
          },
        ])}
      />,
    );
    const values = [...container.querySelectorAll(".cvb-stat-value")];
    expect(values.map((el) => el.textContent)).toEqual(["?", "0"]);
    expect(values[0]?.className).toContain("is-unmeasured");
    expect(values[1]?.className).not.toContain("is-unmeasured");
  });
});

describe("shared item bar on cards and rows", () => {
  test("a card bar renders the plain fill for value/total and an item strip for segments", () => {
    const { container } = render(
      <BoardView
        view={board([
          {
            kind: "cards",
            items: [
              { title: "epic-1", bar: { value: 7, total: 12 } },
              {
                title: "epic-2",
                bar: {
                  segments: [
                    { label: "done", n: 3, tone: "ok" },
                    { label: "left", n: null },
                  ],
                },
              },
            ],
          },
        ])}
      />,
    );
    expect(container.querySelector(".cvb-bar-track.cvb-card-bar .cvb-bar-fill")).toBeTruthy();
    const strip = container.querySelector(".cvb-strip--item");
    // No legend at item scale — the strip carries its reading as an accessible label.
    expect(strip?.getAttribute("aria-label")).toBe("done 3, left unmeasured");
    expect(strip?.querySelectorAll(".cvb-strip-fill").length).toBe(2);
    expect(strip?.querySelectorAll(".cvb-strip-fill--unmeasured").length).toBe(1);
  });

  test("a row bar renders as a compact meter inside the row line", () => {
    const { container } = render(
      <BoardView
        view={board([
          {
            kind: "rows",
            items: [
              { text: "epic-3", bar: { value: 1, total: 2 }, trailing: "1 of 2" },
              { text: "epic-4", bar: { segments: [{ label: "done", n: 2, tone: "ok" }] } },
            ],
          },
        ])}
      />,
    );
    const holders = container.querySelectorAll(".cvb-row-bar");
    expect(holders.length).toBe(2);
    expect(holders[0]?.querySelector(".cvb-bar-fill")).toBeTruthy();
    expect(holders[1]?.querySelector(".cvb-strip--item")).toBeTruthy();
  });
});

describe("rows action/selected parity", () => {
  test("a selectable row dispatches its action and wears the selection state", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView
          view={board([
            {
              kind: "rows",
              items: [
                {
                  text: "bead-1",
                  action: { type: "open-bead", payload: { id: 7 } },
                  selected: true,
                },
                { text: "bead-2" },
              ],
            },
          ])}
        />
      </BoardActionProvider>,
    );
    const rows = container.querySelectorAll(".cvb-row");
    expect(rows[0]?.className).toContain("cvb-row--selectable");
    expect(rows[0]?.className).toContain("is-selected");
    expect(rows[1]?.className).not.toContain("cvb-row--selectable");
    const toggle = screen.getByRole("button", { name: "bead-1" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(calls).toEqual([{ type: "open-bead", payload: { id: 7 } }]));
  });
});

describe("icon-only corner action", () => {
  test("the accessible name is the label, the visible content is the glyph, align end pins the wrapper", () => {
    const run = async (): Promise<RibActionResult> => ({ ok: true });
    render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView
          view={board([
            {
              kind: "cards",
              items: [
                {
                  title: "seat",
                  actions: [
                    { type: "enter", label: "Enter" },
                    {
                      type: "view-charter",
                      label: "Charter",
                      glyph: "▤",
                      iconOnly: true,
                      align: "end",
                    },
                  ],
                },
              ],
            },
          ])}
        />
      </BoardActionProvider>,
    );
    const btn = screen.getByRole("button", { name: "Charter" });
    expect(btn.className).toContain("is-icon-only");
    expect(btn.textContent).toBe("▤");
    // The label backfills the hover title so the affordance is never name-less.
    expect(btn.getAttribute("title")).toBe("Charter");
    expect(btn.closest(".cvb-action")?.className).toContain("cvb-action--end");
    const plain = screen.getByRole("button", { name: "Enter" });
    expect(plain.closest(".cvb-action")?.className).not.toContain("cvb-action--end");
  });
});

describe("binding merge order", () => {
  test("binding merges last — a form field cannot shadow it, but still overrides payload defaults", async () => {
    const calls: RibAction[] = [];
    const run = async (a: RibAction): Promise<RibActionResult> => {
      calls.push(a);
      return { ok: true };
    };
    const { container } = render(
      <BoardActionProvider run={run} reveal={okReveal}>
        <BoardView
          view={board([
            {
              kind: "actions",
              items: [
                {
                  type: "teardown",
                  label: "Teardown",
                  payload: { region: "default" },
                  binding: { fingerprint: "fp-live" },
                  fields: [
                    { name: "region", label: "Region" },
                    { name: "fingerprint", label: "Fingerprint" },
                  ],
                },
              ],
            },
          ])}
        />
      </BoardActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Teardown" }));
    const inputs = container.querySelectorAll(".cvb-action-field-input");
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "west" } });
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: "fp-forged" } });
    fireEvent.submit(container.querySelector(".cvb-action-form") as HTMLFormElement);
    await waitFor(() =>
      expect(calls).toEqual([
        { type: "teardown", payload: { region: "west", fingerprint: "fp-live" } },
      ]),
    );
  });
});

describe("prose card fields", () => {
  test("a prose card renders the prose layout instead of the stacked readout", () => {
    const { container } = render(
      <BoardView
        view={board([
          {
            kind: "cards",
            items: [
              {
                title: "seat",
                prose: true,
                fields: [
                  { label: "Role", value: "Navigator" },
                  { label: "Mission", value: "Chart the reef passage." },
                ],
              },
            ],
          },
        ])}
      />,
    );
    expect(container.querySelector(".cvb-card-fields--prose")).toBeTruthy();
    expect(container.querySelector(".cvb-card-fields--stacked")).toBeFalsy();
  });
});
