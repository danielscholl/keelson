import { describe, expect, it } from "bun:test";
import { canvasViewSchema } from "../src/canvas.ts";

describe("relative clock", () => {
  const at = "2026-09-23T12:00:00Z";
  const parse = (sections: unknown[]) => canvasViewSchema.parse({ view: "board", sections });

  it("parses a clock on a stat item and a card field", () => {
    expect(
      parse([
        { kind: "stats", items: [{ label: "Started", clock: { at, mode: "since" } }] },
        {
          kind: "cards",
          items: [
            { title: "c", fields: [{ label: "gate", tone: "warn", clock: { at, mode: "until" } }] },
          ],
        },
      ]).view,
    ).toBe("board");
  });

  it("rejects a clock alongside a value, a missing value and clock, a bad timestamp, and link/copy on a clock", () => {
    const bad = [
      [{ kind: "stats", items: [{ label: "x", value: 1, clock: { at, mode: "since" } }] }],
      [{ kind: "stats", items: [{ label: "x" }] }],
      [{ kind: "stats", items: [{ label: "x", clock: { at: "yesterday", mode: "since" } }] }],
      [
        {
          kind: "cards",
          items: [{ title: "c", fields: [{ value: 1, clock: { at, mode: "since" } }] }],
        },
      ],
      [
        {
          kind: "cards",
          items: [{ title: "c", fields: [{ clock: { at, mode: "since" }, copyable: true }] }],
        },
      ],
      [{ kind: "cards", items: [{ title: "c", fields: [{ clock: { at, mode: "later" } }] }] }],
      [
        {
          kind: "cards",
          items: [{ title: "c", fields: [{ clock: { at, mode: "since" }, copyable: false }] }],
        },
      ],
    ];
    for (const sections of bad) expect(() => parse(sections)).toThrow();
  });
});
