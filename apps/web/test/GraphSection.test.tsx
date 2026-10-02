import { describe, expect, test } from "bun:test";
import type { CanvasGraphSection, RibAction, RibActionResult } from "@keelson/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BoardActionProvider } from "../src/components/Canvas/BoardActionContext.tsx";
import { GraphSection } from "../src/components/Canvas/GraphSection.tsx";
import { graphFixture } from "./fixtures/boardGraph.ts";

describe("graph section", () => {
  test("renders ranked columns in input order", () => {
    const { container } = render(<GraphSection section={graphFixture} />);
    const columns = [...container.querySelectorAll(".cvb-graph-col")];
    expect(
      columns.map((column) =>
        [...column.querySelectorAll<HTMLElement>(".cvb-graph-node")].map(
          (node) => node.dataset.nodeId,
        ),
      ),
    ).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f", "g"],
      ["h", "i", "j"],
      ["k", "l", "m"],
    ]);
    expect(
      columns.map((column) => column.querySelector(".cvb-graph-col-title")?.textContent),
    ).toEqual(graphFixture.columns);
  });

  test("dispatches trusted node actions and conveys selection", async () => {
    const calls: RibAction[] = [];
    const run = async (action: RibAction): Promise<RibActionResult> => {
      calls.push(action);
      return { ok: true };
    };
    const section: CanvasGraphSection = {
      kind: "graph",
      nodes: [
        { id: "a", label: "A", selected: true, action: { type: "inspect", payload: { id: "a" } } },
        { id: "b", label: "B" },
      ],
      edges: [],
    };
    const { container } = render(
      <BoardActionProvider run={run} reveal={run}>
        <GraphSection section={section} />
      </BoardActionProvider>,
    );
    const button = screen.getByRole("button", { name: "A" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("is-selected")).toBe(true);
    expect(container.querySelector('[data-node-id="b"]')?.hasAttribute("data-dim")).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(calls).toEqual([{ type: "inspect", payload: { id: "a" } }]));
  });

  test("disables action nodes without a dispatcher", () => {
    render(
      <GraphSection
        section={{
          kind: "graph",
          nodes: [{ id: "a", label: "A", action: { type: "inspect" } }],
          edges: [],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "A" }).hasAttribute("disabled")).toBe(true);
  });
});
