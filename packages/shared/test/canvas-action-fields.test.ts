import { describe, expect, it } from "bun:test";
import { canvasViewSchema } from "../src/canvas.ts";

describe("conditional action fields", () => {
  const parse = (fields: unknown[]) =>
    canvasViewSchema.parse({
      view: "board",
      sections: [{ kind: "actions", items: [{ type: "launch", label: "Launch", fields }] }],
    });

  it("parses showWhen naming a sibling field, with or without equals", () => {
    expect(
      parse([
        { name: "project", label: "Project" },
        { name: "workflow", label: "Workflow", showWhen: { field: "project" } },
        { name: "branch", label: "Branch", showWhen: { field: "project", equals: "p2" } },
      ]).view,
    ).toBe("board");
  });

  it("rejects showWhen naming itself or a field the action doesn't have", () => {
    expect(() => parse([{ name: "a", label: "A", showWhen: { field: "a" } }])).toThrow();
    expect(() =>
      parse([
        { name: "a", label: "A" },
        { name: "b", label: "B", showWhen: { field: "missing" } },
      ]),
    ).toThrow();
  });
});
