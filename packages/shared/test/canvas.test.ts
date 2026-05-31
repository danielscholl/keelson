import { describe, expect, it } from "bun:test";
import {
  canvasDocumentSchema,
  canvasKindSchema,
  canvasViewSchema,
  getRunArtifactResponseSchema,
} from "../src/canvas.ts";

describe("canvasDocumentSchema", () => {
  it("round-trips an inline markdown document", () => {
    const doc = canvasDocumentSchema.parse({
      kind: "markdown",
      source: { type: "inline", text: "# Plan" },
      title: "plan-ready",
    });
    expect(doc.kind).toBe("markdown");
    expect(doc.source).toEqual({ type: "inline", text: "# Plan" });
    expect(doc.title).toBe("plan-ready");
  });

  it("round-trips an artifact document without a title", () => {
    const doc = canvasDocumentSchema.parse({
      kind: "markdown",
      source: { type: "artifact", runId: "r1", path: "plan.md" },
    });
    expect(doc.source).toEqual({ type: "artifact", runId: "r1", path: "plan.md" });
    expect(doc.title).toBeUndefined();
  });

  it("accepts the reserved view/html kinds and a snapshot source", () => {
    expect(canvasKindSchema.parse("view")).toBe("view");
    expect(canvasKindSchema.parse("html")).toBe("html");
    const doc = canvasDocumentSchema.parse({
      kind: "view",
      source: { type: "snapshot", key: "osdu.record" },
    });
    expect(doc.source).toEqual({ type: "snapshot", key: "osdu.record" });
  });

  it("rejects an unknown kind", () => {
    expect(() => canvasKindSchema.parse("pdf")).toThrow();
  });

  it("rejects an inline source missing text", () => {
    expect(() =>
      canvasDocumentSchema.parse({ kind: "markdown", source: { type: "inline" } }),
    ).toThrow();
  });

  it("rejects an artifact source missing runId or path", () => {
    expect(() =>
      canvasDocumentSchema.parse({
        kind: "markdown",
        source: { type: "artifact", path: "plan.md" },
      }),
    ).toThrow();
    expect(() =>
      canvasDocumentSchema.parse({ kind: "markdown", source: { type: "artifact", runId: "r1" } }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      canvasDocumentSchema.parse({
        kind: "markdown",
        source: { type: "inline", text: "x" },
        foo: "bar",
      }),
    ).toThrow();
  });
});

describe("canvasViewSchema", () => {
  it("parses a table view", () => {
    const v = canvasViewSchema.parse({
      view: "table",
      columns: [{ key: "name", label: "Name" }, { key: "status" }],
      rows: [
        { name: "alpha", status: "ok" },
        { name: "beta", status: null },
      ],
      caption: "records",
    });
    expect(v.view).toBe("table");
  });

  it("parses a graph view", () => {
    const v = canvasViewSchema.parse({
      view: "graph",
      nodes: [{ id: "a", label: "A", kind: "service" }, { id: "b" }],
      edges: [{ source: "a", target: "b", label: "calls" }],
    });
    expect(v.view).toBe("graph");
  });

  it("rejects an unknown view discriminant", () => {
    expect(() => canvasViewSchema.parse({ view: "pie", slices: [] })).toThrow();
  });

  it("rejects a graph with zero nodes and an edge missing a target", () => {
    expect(() => canvasViewSchema.parse({ view: "graph", nodes: [], edges: [] })).toThrow();
    expect(() =>
      canvasViewSchema.parse({ view: "graph", nodes: [{ id: "a" }], edges: [{ source: "a" }] }),
    ).toThrow();
  });

  it("rejects a table with no columns and unknown keys (strict)", () => {
    expect(() => canvasViewSchema.parse({ view: "table", columns: [], rows: [] })).toThrow();
    expect(() =>
      canvasViewSchema.parse({ view: "table", columns: [{ key: "a" }], rows: [], extra: 1 }),
    ).toThrow();
  });

  it("rejects duplicate column keys", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "table",
        columns: [{ key: "a" }, { key: "a" }],
        rows: [],
      }),
    ).toThrow(/unique/);
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      canvasViewSchema.parse({
        view: "graph",
        nodes: [{ id: "a" }, { id: "a" }],
        edges: [],
      }),
    ).toThrow(/unique/);
  });
});

describe("getRunArtifactResponseSchema", () => {
  it("round-trips a path + content pair", () => {
    const res = getRunArtifactResponseSchema.parse({ path: "plan.md", content: "# Plan\n" });
    expect(res).toEqual({ path: "plan.md", content: "# Plan\n" });
  });
});
