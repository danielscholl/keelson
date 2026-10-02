import { describe, expect, test } from "bun:test";
import {
  buildColumns,
  chainOf,
  computeRanks,
  type GraphGeometry,
  litSet,
  routeEdge,
  waitsOn,
} from "../src/lib/boardGraphLayout.ts";

describe("board graph layout", () => {
  const nodes = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ];
  const edges = [{ source: "a", target: "b" }];

  test("ranks and groups nodes along dependencies", () => {
    const ranks = computeRanks(nodes, edges);
    expect([...ranks]).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expect(
      buildColumns(nodes, ranks, ["Start", "End"]).map((column) => ({
        rank: column.rank,
        title: column.title,
        ids: column.nodes.map((node) => node.id),
      })),
    ).toEqual([
      { rank: 0, title: "Start", ids: ["a"] },
      { rank: 1, title: "End", ids: ["b"] },
    ]);
  });

  test("finds chains, highlights and dependency labels", () => {
    expect(chainOf("b", edges)).toEqual({ up: new Set(["a"]), down: new Set() });
    expect(litSet(["b"], edges)).toEqual(new Set(["a", "b"]));
    expect(waitsOn("b", nodes, edges)).toEqual(["Alpha"]);
  });

  test("routes adjacent columns and skips unmeasured or unsupported edges", () => {
    const geometry: GraphGeometry = {
      columns: [
        { left: 0, right: 100, nodes: [{ id: "a", left: 0, right: 100, top: 16, bottom: 56 }] },
        { left: 156, right: 256, nodes: [{ id: "b", left: 156, right: 256, top: 32, bottom: 72 }] },
      ],
    };
    expect(routeEdge("a", "b", geometry)).toEqual({
      d: "M 100 36 C 128 36 128 52 156 52",
      waypoints: [
        { x: 100, y: 36 },
        { x: 156, y: 52 },
      ],
    });
    expect(routeEdge("a", "ghost", geometry)).toBeNull();
    expect(routeEdge("ghost", "b", geometry)).toBeNull();
    expect(routeEdge("a", "a", geometry)).toBeNull();
    expect(routeEdge("b", "a", geometry)).toBeNull();
  });
});
