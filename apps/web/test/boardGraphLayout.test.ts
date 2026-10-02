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
import { graphFixture } from "./fixtures/boardGraph.ts";

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
    expect(
      routeEdge("a", "b", {
        columns: [
          {
            ...geometry.columns[0]!,
            nodes: [...geometry.columns[0]!.nodes, ...geometry.columns[1]!.nodes],
          },
        ],
      }),
    ).toBeNull();
  });

  test("honors explicit ranks and uses them for unranked descendants", () => {
    expect([
      ...computeRanks(
        [{ ...nodes[0]!, rank: 5 }, nodes[1]!, { id: "c", label: "C", rank: 0 }],
        [...edges, { source: "b", target: "c" }],
      ),
    ]).toEqual([
      ["a", 5],
      ["b", 6],
      ["c", 0],
    ]);
  });

  test("uses longest paths for a diamond with a shortcut", () => {
    const diamond = ["a", "b", "c", "d"].map((id) => ({ id, label: id }));
    const ranks = computeRanks(diamond, [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "b", target: "d" },
      { source: "c", target: "d" },
      { source: "a", target: "d" },
    ]);
    expect([...ranks.values()]).toEqual([0, 1, 1, 2]);
  });

  test("terminates on cycles and preserves processed predecessor depths", () => {
    const cycle = ["a", "b", "c", "d"].map((id) => ({ id, label: id }));
    const ranks = computeRanks(cycle, [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "b" },
      { source: "d", target: "d" },
    ]);
    expect([...ranks.values()]).toEqual([0, 1, 0, 0]);
    expect([...ranks.values()].every(Number.isFinite)).toBe(true);
    expect(
      chainOf("b", [
        { source: "b", target: "c" },
        { source: "c", target: "b" },
      ]),
    ).toEqual({ up: new Set(["c"]), down: new Set(["c"]) });
  });

  test("preserves input order and compacts sparse ranks while retaining title indices", () => {
    const sparse = [
      { id: "b", label: "B", rank: 5 },
      { id: "a", label: "A", rank: 0 },
      { id: "c", label: "C", rank: 5 },
    ];
    const columns = buildColumns(sparse, computeRanks(sparse, []), [
      "Source",
      "",
      "",
      "",
      "",
      "Ship",
    ]);
    expect(
      columns.map((column) => [column.rank, column.title, column.nodes.map((node) => node.id)]),
    ).toEqual([
      [0, "Source", ["a"]],
      [5, "Ship", ["b", "c"]],
    ]);
  });

  test("finds only upstream and downstream chains, not sibling branches", () => {
    const { up, down } = chainOf("e", graphFixture.edges);
    expect(up).toEqual(new Set(["a", "b"]));
    expect(down).toEqual(new Set(["h", "i", "k", "l", "m"]));
    expect(litSet(["e", "d"], graphFixture.edges)).toEqual(
      new Set(["a", "b", "d", "e", "h", "i", "k", "l", "m"]),
    );
    expect(litSet([], graphFixture.edges)).toEqual(new Set());
    expect(waitsOn("h", graphFixture.nodes, graphFixture.edges)).toEqual(["D", "E", "A"]);
  });

  test("threads every skip edge in the 13-node, 4-rank, 22-edge fixture through gaps", () => {
    const columns = buildColumns(
      graphFixture.nodes,
      computeRanks(graphFixture.nodes, graphFixture.edges),
    );
    const geometry: GraphGeometry = {
      columns: columns.map((column, i) => ({
        left: i * 300,
        right: i * 300 + 244,
        nodes: column.nodes.map((node, j) => ({
          id: node.id,
          left: i * 300,
          right: i * 300 + 244,
          top: 40 + j * 76,
          bottom: 96 + j * 76,
        })),
      })),
    };
    expect(graphFixture.nodes).toHaveLength(13);
    expect(graphFixture.edges).toHaveLength(22);
    expect(columns).toHaveLength(4);
    let skipped = 0;
    for (const edge of graphFixture.edges) {
      const sourceColumn = columns.findIndex((column) =>
        column.nodes.some((node) => node.id === edge.source),
      );
      const targetColumn = columns.findIndex((column) =>
        column.nodes.some((node) => node.id === edge.target),
      );
      if (targetColumn - sourceColumn < 2) continue;
      skipped++;
      const route = routeEdge(edge.source, edge.target, geometry)!;
      expect(route.waypoints).toHaveLength(2 + 2 * (targetColumn - sourceColumn - 1));
      for (let i = 1; i < route.waypoints.length - 1; i += 2) {
        const start = route.waypoints[i]!;
        const end = route.waypoints[i + 1]!;
        const column = geometry.columns[sourceColumn + (i + 1) / 2]!;
        expect([start.x, end.x]).toEqual([column.left, column.right]);
        expect(start.y).toBe(end.y);
        for (const box of column.nodes) {
          expect(start.y < box.top || start.y > box.bottom).toBe(true);
        }
      }
      const curves = [
        ...route.d.matchAll(/C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g),
      ];
      expect(curves).toHaveLength(targetColumn - sourceColumn);
      curves.forEach((curve, i) => {
        const gutterLeft = geometry.columns[sourceColumn + i]!.right;
        const gutterRight = geometry.columns[sourceColumn + i + 1]!.left;
        for (const x of [Number(curve[1]), Number(curve[3])]) {
          expect(x).toBeGreaterThanOrEqual(gutterLeft);
          expect(x).toBeLessThanOrEqual(gutterRight);
        }
      });
    }
    expect(skipped).toBe(7);
  });

  test("chooses the gap nearest interpolated y, including exterior gaps", () => {
    const geometry: GraphGeometry = {
      columns: [
        { left: 0, right: 100, nodes: [{ id: "a", left: 0, right: 100, top: 90, bottom: 110 }] },
        {
          left: 156,
          right: 256,
          nodes: [
            { id: "x", left: 156, right: 256, top: 20, bottom: 80 },
            { id: "y", left: 156, right: 256, top: 120, bottom: 180 },
          ],
        },
        {
          left: 312,
          right: 412,
          nodes: [{ id: "b", left: 312, right: 412, top: 90, bottom: 110 }],
        },
      ],
    };
    expect(routeEdge("a", "b", geometry)?.waypoints[1]?.y).toBe(100);
    geometry.columns[0]!.nodes[0]!.top = geometry.columns[2]!.nodes[0]!.top = 0;
    geometry.columns[0]!.nodes[0]!.bottom = geometry.columns[2]!.nodes[0]!.bottom = 20;
    expect(routeEdge("a", "b", geometry)?.waypoints[1]?.y).toBe(12);
    geometry.columns[0]!.nodes[0]!.top = geometry.columns[2]!.nodes[0]!.top = 200;
    geometry.columns[0]!.nodes[0]!.bottom = geometry.columns[2]!.nodes[0]!.bottom = 220;
    expect(routeEdge("a", "b", geometry)?.waypoints[1]?.y).toBe(188);
  });
});
