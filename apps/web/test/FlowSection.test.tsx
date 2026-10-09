import { describe, expect, test } from "bun:test";
import type { CanvasBoardView, CanvasFlowSection } from "@keelson/shared";
import { fireEvent, render } from "@testing-library/react";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";

function flowBoard(patch?: Partial<CanvasFlowSection>): CanvasBoardView {
  return {
    view: "board",
    sections: [
      {
        kind: "flow",
        left: "Legal tag",
        right: "Who can read",
        nodes: [
          { id: "usa", side: "left", label: "usa-dataset", sublabel: "61,204 · 45%" },
          { id: "pilot", side: "left", label: "pilot-trial", selected: true },
          {
            id: "more",
            side: "left",
            label: "6 more tags",
            folded: [
              { label: "segy", n: 1688 },
              { label: "vendor", n: 905 },
              { label: "reservoir", n: 412 },
              { label: "schema", n: 188 },
              { label: "tag-01", n: 96 },
              { label: "tag-02", n: 71 },
            ],
          },
          { id: "default", side: "right", label: "data.default.viewers" },
          { id: "pilotv", side: "right", label: "data.pilot.viewers" },
        ],
        links: [
          { source: "usa", target: "default", n: 61204 },
          { source: "pilot", target: "pilotv", n: 4410 },
          { source: "more", target: "default", n: 3360 },
        ],
        ...patch,
      },
    ],
  };
}

describe("flow board section", () => {
  test("ribbons wear their left node's --s slot and a folded node takes --s-other", () => {
    const { container } = render(<BoardView view={flowBoard()} />);
    const ribbons = [...container.querySelectorAll("path.cvb-flow-ribbon")];
    expect(ribbons.map((r) => r.getAttribute("stroke"))).toEqual([
      "var(--s1)",
      "var(--s2)",
      "var(--s-other)",
    ]);
    expect(container.querySelectorAll(".cvb-flow-node").length).toBe(5);
    expect(container.querySelector(".cvb-flow-sublabel")?.textContent).toBe("61,204 · 45%");
  });

  test("a selected node lights its ribbons and dims the rest", () => {
    const { container } = render(<BoardView view={flowBoard()} />);
    const ribbons = [...container.querySelectorAll<SVGPathElement>("path.cvb-flow-ribbon")];
    expect(ribbons.map((r) => r.hasAttribute("data-lit"))).toEqual([false, true, false]);
    expect(ribbons[0]?.style.opacity).toBe("0.14");
    expect(ribbons[1]?.style.opacity).toBe("0.85");
  });

  test("hovering a folded node lists its members, then +N more, then its links", () => {
    const { container } = render(<BoardView view={flowBoard()} />);
    const more = container.querySelectorAll(".cvb-flow-node")[2] as Element;
    fireEvent.pointerEnter(more);
    const card = container.querySelector(".cvb-flow-card");
    expect(card?.getAttribute("role")).toBe("tooltip");
    expect(card?.querySelector(".cvb-flow-title")?.textContent).toBe("6 more tags3,360");
    const subs = [...(card?.querySelectorAll(".cvb-flow-sub") ?? [])].map((r) => r.textContent);
    expect(subs).toEqual([
      "segy1,68850%",
      "vendor90527%",
      "reservoir41212%",
      "schema1886%",
      "+2 more",
    ]);
    expect(card?.querySelector(".cvb-flow-heading")?.textContent).toBe("Who can read");
    expect(card?.textContent).toContain("data.default.viewers3,360100%");
  });

  test("hovering a ribbon shows its share of both ends, and Escape closes the card", () => {
    const { container } = render(<BoardView view={flowBoard()} />);
    const ribbon = container.querySelectorAll("path.cvb-flow-ribbon")[0] as Element;
    fireEvent.pointerEnter(ribbon);
    const card = container.querySelector(".cvb-flow-card");
    expect(card?.querySelector(".cvb-flow-title")?.textContent).toBe(
      "usa-dataset → data.default.viewers61,204",
    );
    expect(card?.textContent).toContain("of usa-dataset100%");
    expect(card?.textContent).toContain("of data.default.viewers95%");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".cvb-flow-card")).toBeNull();
  });

  test("keyboard focus on a node opens its card", () => {
    const { container } = render(<BoardView view={flowBoard()} />);
    const usa = container.querySelectorAll(".cvb-flow-node")[0] as Element;
    fireEvent.focus(usa);
    expect(container.querySelector(".cvb-flow-card .cvb-flow-title")?.textContent).toBe(
      "usa-dataset61,204",
    );
    expect(usa.getAttribute("aria-describedby")).toBe(
      container.querySelector(".cvb-flow-card")?.id ?? "missing",
    );
  });
});
