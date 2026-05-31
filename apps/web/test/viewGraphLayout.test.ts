import { describe, expect, test } from "bun:test";
import { viewGraphLayout } from "../src/lib/viewGraphLayout.ts";

describe("viewGraphLayout", () => {
  test("maps nodes (label falls back to id) and positions them", () => {
    const { nodes } = viewGraphLayout({
      view: "graph",
      nodes: [{ id: "a", label: "Alpha", kind: "service" }, { id: "b" }],
      edges: [{ source: "a", target: "b" }],
    });
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(nodes[0]?.data).toEqual({ label: "Alpha", kind: "service" });
    // label defaults to the id when omitted
    expect(nodes[1]?.data.label).toBe("b");
    // dagre populated finite positions
    expect(Number.isFinite(nodes[0]?.position.x)).toBe(true);
    expect(Number.isFinite(nodes[0]?.position.y)).toBe(true);
  });

  test("drops edges that reference an unknown node id", () => {
    const { edges } = viewGraphLayout({
      view: "graph",
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "ghost" },
      ],
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe("a");
    expect(edges[0]?.target).toBe("b");
  });

  test("gives every edge a unique id even between the same pair", () => {
    const { edges } = viewGraphLayout({
      view: "graph",
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "b" },
      ],
    });
    const ids = edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
