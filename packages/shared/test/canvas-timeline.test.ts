import { describe, expect, it } from "bun:test";
import {
  type CanvasTimelineLane,
  type CanvasTimelineMark,
  type CanvasTimelineSection,
  type CanvasTimelineSpan,
  type CanvasTimelineWindow,
  canvasToneSchema,
  canvasViewSchema,
  expectView,
} from "../src/index.ts";

const from = "2026-10-05T12:00:00Z";
const to = "2026-10-05T13:00:00Z";
const window: CanvasTimelineWindow = { from, to };
const lane: CanvasTimelineLane = { id: "a", label: "Alpha" };
const span: CanvasTimelineSpan = { lane: "a", from, to, title: "Work" };
const mark: CanvasTimelineMark = { lane: "a", at: from, glyph: "*", title: "Start" };
const section: CanvasTimelineSection = {
  kind: "timeline",
  window,
  lanes: [lane],
  spans: [],
  marks: [],
};
const board = (value: unknown, nested = false) => ({
  view: "board",
  sections: nested ? [{ kind: "columns", columns: [{ sections: [value] }] }] : [value],
});
const validate = expectView("rib:sample:timeline", "board");

function accepts(value: unknown, nested: boolean) {
  expect(canvasViewSchema.safeParse(board(value, nested)).success).toBe(true);
  expect(validate(board(value, nested)).view).toBe("board");
}

function rejects(value: unknown, nested: boolean, path?: (string | number)[]) {
  const result = canvasViewSchema.safeParse(board(value, nested));
  expect(result.success).toBe(false);
  expect(() => validate(board(value, nested))).toThrow();
  if (path && !result.success) {
    const prefix = nested ? ["sections", 0, "columns", 0, "sections", 0] : ["sections", 0];
    expect(
      result.error.issues.some(
        (issue) => JSON.stringify(issue.path) === JSON.stringify([...prefix, ...path]),
      ),
    ).toBe(true);
  }
}

for (const nested of [false, true]) {
  describe(`timeline contract (${nested ? "columns" : "top-level"})`, () => {
    it("accepts both minimal windows and every optional field with offsets", () => {
      accepts(section, nested);
      accepts({ ...section, window: { from, clock: { until: to } } }, nested);
      accepts(
        {
          ...section,
          title: "Activity",
          legend: "Dashed spans are open",
          window: {
            from: "2026-10-05T07:00:00-05:00",
            clock: { until: "2026-10-05T15:00:00+02:00" },
          },
          lanes: [{ ...lane, tone: "id-blue", group: "Team" }],
          spans: [
            { ...span, tone: "warn", hatched: true },
            { lane: "a", from, title: "Running" },
          ],
          marks: [mark],
        },
        nested,
      );
    });

    it("accepts exact caps and rejects each cap plus one and no lanes", () => {
      const lanes = Array.from({ length: 12 }, (_, i) => ({ id: `lane-${i}`, label: `Lane ${i}` }));
      const spans = Array.from({ length: 400 }, () => ({ ...span, lane: "lane-0" }));
      const marks = Array.from({ length: 200 }, () => ({ ...mark, lane: "lane-0" }));
      accepts({ ...section, lanes, spans, marks }, nested);
      rejects({ ...section, lanes: [] }, nested);
      rejects({ ...section, lanes: [...lanes, { id: "extra", label: "Extra" }] }, nested);
      rejects({ ...section, spans: Array.from({ length: 401 }, () => span) }, nested);
      rejects({ ...section, marks: Array.from({ length: 201 }, () => mark) }, nested);
      for (const key of ["lanes", "spans", "marks"] as const) {
        const { [key]: _, ...missing } = section;
        rejects(missing, nested);
      }
    });

    it("accepts the lane subset and all span overrides without narrowing CanvasTone", () => {
      const allowed = [
        "id-blue",
        "id-amber",
        "id-teal",
        "id-rose",
        "id-olive",
        "brand",
        "neutral",
        "info",
      ];
      for (const tone of canvasToneSchema.options) {
        accepts({ ...section, spans: [{ ...span, tone }] }, nested);
        const value = { ...section, lanes: [{ ...lane, tone }] };
        if (allowed.includes(tone)) accepts(value, nested);
        else rejects(value, nested);
      }
    });

    it("requires one Unicode code point per glyph", () => {
      for (const glyph of ["*", "\u25c6", "\u{1f680}"])
        accepts({ ...section, marks: [{ ...mark, glyph }] }, nested);
      for (const glyph of ["", "ab", "e\u0301", "\u{1f1fa}\u{1f1f8}"])
        rejects({ ...section, marks: [{ ...mark, glyph }] }, nested, ["marks", 0, "glyph"]);
    });

    it("rejects mixed or missing window forms and strict extra keys", () => {
      for (const invalid of [
        { from },
        { from, to, clock: { until: to } },
        { from, to, extra: true },
        { from, clock: { until: to, extra: true } },
      ]) {
        rejects({ ...section, window: invalid }, nested);
      }
      rejects({ ...section, extra: true }, nested);
      rejects({ ...section, lanes: [{ ...lane, extra: true }] }, nested);
      rejects({ ...section, spans: [{ ...span, extra: true }] }, nested);
      rejects({ ...section, marks: [{ ...mark, extra: true }] }, nested);
    });

    it("rejects invalid timestamps and empty required text", () => {
      for (const timestamp of ["yesterday", "2026-10-05T12:00:00", "2026-02-30T12:00:00Z"]) {
        rejects({ ...section, window: { from: timestamp, to } }, nested);
        rejects({ ...section, window: { from, to: timestamp } }, nested);
        rejects({ ...section, window: { from, clock: { until: timestamp } } }, nested);
        rejects({ ...section, spans: [{ ...span, from: timestamp }] }, nested);
        rejects({ ...section, spans: [{ ...span, to: timestamp }] }, nested);
        rejects({ ...section, marks: [{ ...mark, at: timestamp }] }, nested);
      }
      for (const key of ["id", "label"])
        rejects({ ...section, lanes: [{ ...lane, [key]: "" }] }, nested);
      rejects({ ...section, spans: [{ ...span, title: "" }] }, nested);
      rejects({ ...section, marks: [{ ...mark, title: "" }] }, nested);
    });

    it("enforces time ordering while permitting zero duration and broader history", () => {
      for (const end of [from, "2026-10-05T11:00:00Z"]) {
        rejects({ ...section, window: { from, to: end } }, nested);
        rejects({ ...section, window: { from, clock: { until: end } } }, nested);
      }
      rejects({ ...section, spans: [{ ...span, from: to, to: from }] }, nested, ["spans", 0, "to"]);
      accepts(
        {
          ...section,
          spans: [
            { ...span, to: from },
            { ...span, from: "2026-10-05T11:00:00Z" },
          ],
          marks: [{ ...mark, at: "2026-10-05T14:00:00Z" }],
        },
        nested,
      );
    });

    it("reports precise duplicate and dangling-reference paths", () => {
      rejects({ ...section, lanes: [lane, lane] }, nested, ["lanes", 1, "id"]);
      rejects({ ...section, spans: [{ ...span, lane: "missing" }] }, nested, ["spans", 0, "lane"]);
      rejects({ ...section, marks: [{ ...mark, lane: "missing" }] }, nested, ["marks", 0, "lane"]);
    });
  });
}
