// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { buildTopologicalLayers, validateDagShape } from "./graph.ts";
import type { DagNode } from "./schema/index.ts";

function p(id: string, depends_on?: string[]): DagNode {
	return { id, prompt: "x", ...(depends_on ? { depends_on } : {}) } as DagNode;
}

describe("validateDagShape — well-formed", () => {
	test("empty node list is valid", () => {
		expect(validateDagShape([])).toEqual([]);
	});

	test("single node, no deps", () => {
		expect(validateDagShape([p("a")])).toEqual([]);
	});

	test("linear chain a → b → c", () => {
		expect(validateDagShape([p("a"), p("b", ["a"]), p("c", ["b"])])).toEqual([]);
	});

	test("diamond: a → b, c → d", () => {
		expect(validateDagShape([p("a"), p("b", ["a"]), p("c", ["a"]), p("d", ["b", "c"])])).toEqual([]);
	});
});

describe("validateDagShape — error cases", () => {
	test("duplicate id reported once", () => {
		const errs = validateDagShape([p("a"), p("a"), p("a")]);
		expect(errs).toEqual([{ kind: "duplicate_id", id: "a" }]);
	});

	test("unknown dependency reported with both ids", () => {
		const errs = validateDagShape([p("a", ["missing"])]);
		expect(errs).toEqual([{ kind: "unknown_dependency", nodeId: "a", missing: "missing" }]);
	});

	test("self-dependency reported", () => {
		const errs = validateDagShape([p("a", ["a"])]);
		expect(errs).toEqual([{ kind: "self_dependency", nodeId: "a" }]);
	});

	test("two-node cycle", () => {
		const errs = validateDagShape([p("a", ["b"]), p("b", ["a"])]);
		expect(errs).toContainEqual({ kind: "cycle", nodeIds: ["a", "b"] });
	});

	test("three-node cycle", () => {
		const errs = validateDagShape([p("a", ["c"]), p("b", ["a"]), p("c", ["b"])]);
		const cycleErr = errs.find((e) => e.kind === "cycle");
		expect(cycleErr).toBeDefined();
		expect(new Set((cycleErr as { nodeIds: string[] }).nodeIds)).toEqual(new Set(["a", "b", "c"]));
	});

	test("multiple errors collected together", () => {
		const errs = validateDagShape([
			p("a"),
			p("a"), // duplicate
			p("b", ["missing"]), // unknown dep
			p("c", ["c"]), // self-dep
		]);
		const kinds = errs.map((e) => e.kind);
		expect(kinds).toContain("duplicate_id");
		expect(kinds).toContain("unknown_dependency");
		expect(kinds).toContain("self_dependency");
	});
});

describe("buildTopologicalLayers", () => {
	test("empty input → empty layers", () => {
		expect(buildTopologicalLayers([])).toEqual([]);
	});

	test("no-dependency nodes go in layer 0", () => {
		const nodes = [p("a"), p("b"), p("c")];
		const layers = buildTopologicalLayers(nodes);
		expect(layers.length).toBe(1);
		expect(layers[0].map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
	});

	test("linear chain produces one node per layer", () => {
		const nodes = [p("a"), p("b", ["a"]), p("c", ["b"])];
		const layers = buildTopologicalLayers(nodes);
		expect(layers.map((l) => l.map((n) => n.id))).toEqual([["a"], ["b"], ["c"]]);
	});

	test("diamond DAG produces 3 layers (parallel middle)", () => {
		// a → b, a → c, then d depends on both
		const nodes = [p("a"), p("b", ["a"]), p("c", ["a"]), p("d", ["b", "c"])];
		const layers = buildTopologicalLayers(nodes);
		expect(layers.length).toBe(3);
		expect(layers[0].map((n) => n.id)).toEqual(["a"]);
		expect(layers[1].map((n) => n.id).sort()).toEqual(["b", "c"]);
		expect(layers[2].map((n) => n.id)).toEqual(["d"]);
	});

	test("preserves declared input order within a layer", () => {
		const nodes = [p("z"), p("a"), p("m")];
		const layers = buildTopologicalLayers(nodes);
		expect(layers[0].map((n) => n.id)).toEqual(["z", "a", "m"]);
	});

	test("throws on a runtime cycle (loader should reject earlier)", () => {
		const nodes = [p("a", ["b"]), p("b", ["a"])];
		expect(() => buildTopologicalLayers(nodes)).toThrow(/cycle/i);
	});
});
