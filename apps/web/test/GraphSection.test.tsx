import { afterEach, describe, expect, test } from "bun:test";
import type { CanvasGraphSection, RibAction, RibActionResult } from "@keelson/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BoardActionProvider } from "../src/components/Canvas/BoardActionContext.tsx";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";
import { graphFixture } from "./fixtures/boardGraph.ts";

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalObserver = globalThis.ResizeObserver;
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = originalObserver;
});

function measureAt(initialWidth: number) {
  let width = initialWidth;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("cvb-graph")) return new DOMRect(20, 10, width, 400);
    const column = this.classList.contains("cvb-graph-col") ? this : this.closest(".cvb-graph-col");
    if (!column?.parentElement) return originalRect.call(this);
    const columns = [...column.parentElement.children];
    const columnWidth = (width - (columns.length - 1) * 56) / columns.length;
    const x = 20 + columns.indexOf(column) * (columnWidth + 56);
    if (this === column) return new DOMRect(x, 26, columnWidth, 340);
    if (this.classList.contains("cvb-graph-node")) {
      const siblings = [...column.querySelectorAll(".cvb-graph-node")];
      return new DOMRect(x, 50 + siblings.indexOf(this) * 76, columnWidth, 56);
    }
    return originalRect.call(this);
  };
  return (next: number) => {
    width = next;
  };
}

function selectedFixture(): CanvasGraphSection {
  return {
    ...graphFixture,
    nodes: graphFixture.nodes.map((node) =>
      node.id === "e"
        ? { ...node, selected: true, action: { type: "inspect", payload: { id: node.id } } }
        : node,
    ),
  };
}

function litNodes(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".cvb-graph-node:not([data-dim])")].map(
    (node) => node.dataset.nodeId,
  );
}

describe("graph section", () => {
  test("renders ranked columns in input order", () => {
    const { container } = render(<BoardView view={{ view: "board", sections: [graphFixture] }} />);
    expect(container.querySelector(".cvb-section-title")?.textContent).toBe("Dependencies");
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
        <BoardView view={{ view: "board", sections: [section] }} />
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
      <BoardView
        view={{
          view: "board",
          sections: [
            {
              kind: "graph",
              nodes: [{ id: "a", label: "A", action: { type: "inspect" } }],
              edges: [],
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "A" }).hasAttribute("disabled")).toBe(true);
  });

  test("derives longest-path columns when ranks are omitted", () => {
    const { container } = render(
      <BoardView
        view={{
          view: "board",
          sections: [
            {
              kind: "graph",
              nodes: ["a", "b", "c", "d"].map((id) => ({ id, label: id })),
              edges: [
                { source: "a", target: "b" },
                { source: "a", target: "c" },
                { source: "b", target: "d" },
                { source: "c", target: "d" },
                { source: "a", target: "d" },
              ],
            },
          ],
        }}
      />,
    );
    expect(
      [...container.querySelectorAll(".cvb-graph-col")].map((column) =>
        [...column.querySelectorAll<HTMLElement>(".cvb-graph-node")].map(
          (node) => node.dataset.nodeId,
        ),
      ),
    ).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  test("keeps selected chains lit at rest and dims edges outside them", () => {
    measureAt(1600);
    const { container } = render(
      <BoardView view={{ view: "board", sections: [selectedFixture()] }} />,
    );
    expect(litNodes(container)).toEqual(["a", "b", "e", "h", "i", "k", "l", "m"]);
    expect(
      container.querySelector('[data-source="c"][data-target="g"]')?.hasAttribute("data-dim"),
    ).toBe(true);
    expect(
      container.querySelector('[data-source="e"][data-target="h"]')?.hasAttribute("data-dim"),
    ).toBe(false);
  });

  test("hover and focus highlight chains independently and restore selection on exit", () => {
    const { container } = render(
      <BoardView view={{ view: "board", sections: [selectedFixture()] }} />,
    );
    const d = container.querySelector('[data-node-id="d"]')!;
    const g = container.querySelector('[data-node-id="g"]')!;
    expect(d.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(d);
    expect(litNodes(container)).toEqual(["a", "d", "h", "k", "l", "m"]);
    fireEvent.mouseEnter(g);
    expect(litNodes(container)).toEqual(["c", "g", "j", "m"]);
    fireEvent.mouseLeave(g);
    expect(litNodes(container)).toEqual(["a", "d", "h", "k", "l", "m"]);
    fireEvent.blur(d);
    expect(litNodes(container)).toEqual(["a", "b", "e", "h", "i", "k", "l", "m"]);
  });

  test("with no active or selected node nothing is dimmed", () => {
    const { container } = render(<BoardView view={{ view: "board", sections: [graphFixture] }} />);
    const node = container.querySelector('[data-node-id="e"]')!;
    fireEvent.mouseEnter(node);
    expect(container.querySelectorAll("[data-dim]").length).toBeGreaterThan(0);
    fireEvent.mouseLeave(node);
    expect(container.querySelectorAll("[data-dim]").length).toBe(0);
  });

  test("unions the chains of multiple selected nodes", () => {
    const section = selectedFixture();
    section.nodes = section.nodes.map((node) =>
      node.id === "g" ? { ...node, selected: true, action: { type: "inspect" } } : node,
    );
    const { container } = render(<BoardView view={{ view: "board", sections: [section] }} />);
    expect(litNodes(container)).toEqual(["a", "b", "c", "e", "g", "h", "i", "j", "k", "l", "m"]);
  });

  test("uses native button activation without origin or an absent payload key", async () => {
    const calls: RibAction[] = [];
    const run = async (action: RibAction): Promise<RibActionResult> => {
      calls.push(action);
      return { ok: true };
    };
    render(
      <BoardActionProvider run={run} reveal={run}>
        <BoardView
          view={{
            view: "board",
            sections: [
              {
                kind: "graph",
                nodes: [{ id: "a", label: "A", action: { type: "inspect" } }],
                edges: [],
              },
            ],
          }}
        />
      </BoardActionProvider>,
    );
    const button = screen.getByRole("button", { name: "A" });
    expect(button.tagName).toBe("BUTTON");
    fireEvent.keyDown(button, { key: "Enter" });
    // happy-dom lacks default keyboard activation; browsers emit this detail=0 click for Enter.
    fireEvent.click(button, { detail: 0 });
    await waitFor(() => expect(calls).toEqual([{ type: "inspect" }]));
    expect(Object.hasOwn(calls[0]!, "origin")).toBe(false);
    expect(Object.hasOwn(calls[0]!, "payload")).toBe(false);
  });

  test("guards repeated dispatch while pending and re-enables after a failed reply", async () => {
    let resolve!: (value: RibActionResult) => void;
    let calls = 0;
    const run = (): Promise<RibActionResult> => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    };
    render(
      <BoardActionProvider run={run} reveal={run}>
        <BoardView view={{ view: "board", sections: [selectedFixture()] }} />
      </BoardActionProvider>,
    );
    const button = screen.getByRole("button", { name: "E" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(calls).toBe(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => resolve({ ok: false, error: { code: "FAILED", message: "Failed" } }));
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  test("stacks narrow graphs, omits SVG and lists incoming labels", () => {
    measureAt(600);
    const { container } = render(<BoardView view={{ view: "board", sections: [graphFixture] }} />);
    expect(container.querySelector(".cvb-graph")?.hasAttribute("data-narrow")).toBe(true);
    expect(container.querySelector("svg.cvb-graph-edges")).toBeNull();
    expect(container.querySelector('[data-node-id="h"] .cvb-graph-waits')?.textContent).toBe(
      "waits on D, E, A",
    );
    expect(container.querySelector('[data-node-id="a"] .cvb-graph-waits')).toBeNull();
  });

  test("renders one path per measured edge with tone, dash and tooltip", () => {
    measureAt(1600);
    const section: CanvasGraphSection = {
      ...graphFixture,
      nodes: graphFixture.nodes.map((node) =>
        node.id === "a"
          ? {
              ...node,
              tone: "ok",
              sublabel: "Owner",
              badges: [{ text: "P1", tone: "warn" }],
            }
          : node,
      ),
      edges: graphFixture.edges.map((edge, i) =>
        i === 0 ? { ...edge, tone: "warn", dashed: true, label: "blocks" } : edge,
      ),
    };
    const { container } = render(<BoardView view={{ view: "board", sections: [section] }} />);
    expect(container.querySelectorAll("svg.cvb-graph-edges")).toHaveLength(1);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(22);
    expect(paths[0]?.getAttribute("data-tone")).toBe("warn");
    expect(paths[0]?.hasAttribute("data-dashed")).toBe(true);
    expect(paths[0]?.querySelector("title")?.textContent).toBe("blocks");
    expect(container.querySelector('[data-node-id="a"]')?.getAttribute("data-tone")).toBe("ok");
    expect(container.querySelector(".cvb-graph-sublabel")?.textContent).toBe("Owner");
    expect(container.querySelector(".canvas-cell-badge")?.getAttribute("data-tone")).toBe("warn");
  });

  test("renders nested graph sections with their title", () => {
    const { container } = render(
      <BoardView
        view={{
          view: "board",
          sections: [
            {
              kind: "columns",
              columns: [{ sections: [graphFixture] }],
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".cvb-column .cvb-graph")).not.toBeNull();
    expect(container.querySelector(".cvb-column .cvb-section-title")?.textContent).toBe(
      "Dependencies",
    );
  });

  test("redraws edges and toggles the fallback on observed resize", () => {
    const changeWidth = measureAt(1600);
    let resize!: () => void;
    let observed: Element | undefined;
    let disconnected = 0;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe(target: Element) {
        observed = target;
      }
      unobserve() {}
      disconnect() {
        disconnected++;
      }
    };
    const { container, unmount } = render(
      <BoardView view={{ view: "board", sections: [graphFixture] }} />,
    );
    expect(observed).toBe(container.querySelector(".cvb-graph")!);
    const before = container.querySelector("path")?.getAttribute("d");
    expect(before).toBeDefined();
    act(() => {
      changeWidth(1000);
      resize();
    });
    expect(container.querySelector("path")?.getAttribute("d")).not.toBe(before);
    act(() => {
      changeWidth(600);
      resize();
    });
    expect(container.querySelector("svg")).toBeNull();
    act(() => {
      changeWidth(1600);
      resize();
    });
    expect(container.querySelectorAll("path")).toHaveLength(22);
    unmount();
    expect(disconnected).toBeGreaterThan(0);
  });

  test("remeasures live graph updates and skips self-loops", () => {
    measureAt(1600);
    const { container, rerender } = render(
      <BoardView view={{ view: "board", sections: [graphFixture] }} />,
    );
    const section = {
      ...graphFixture,
      edges: [
        { source: "m", target: "a" },
        { source: "a", target: "b" },
        { source: "a", target: "a" },
      ],
    };
    rerender(<BoardView view={{ view: "board", sections: [section] }} />);
    expect(container.querySelectorAll("path")).toHaveLength(2);
    expect(
      container.querySelector('[data-source="m"][data-target="a"]')?.getAttribute("d"),
    ).toContain(" C ");
    expect(
      container.querySelector('[data-source="a"][data-target="b"]')?.getAttribute("d"),
    ).toContain(" C ");
  });
});
