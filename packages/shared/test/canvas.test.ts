import { describe, expect, it } from "bun:test";
import {
  canvasDocumentSchema,
  canvasKindSchema,
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

describe("getRunArtifactResponseSchema", () => {
  it("round-trips a path + content pair", () => {
    const res = getRunArtifactResponseSchema.parse({ path: "plan.md", content: "# Plan\n" });
    expect(res).toEqual({ path: "plan.md", content: "# Plan\n" });
  });
});
