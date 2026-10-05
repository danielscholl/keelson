import { describe, expect, it } from "bun:test";
import type { CanvasTimelineSection } from "@keelson/shared";
import { layoutTimeline } from "../src/lib/boardTimelineLayout.ts";

const from = "2026-10-05T12:00:00Z";
const to = "2026-10-05T13:00:00Z";
const now = Date.parse("2026-10-05T12:30:00Z");
const section: CanvasTimelineSection = {
  kind: "timeline",
  window: { from, to },
  lanes: [
    { id: "b", label: "Beta", group: "One" },
    { id: "a", label: "Alpha", group: "One" },
    { id: "c", label: "Gamma", group: "Two" },
  ],
  spans: [],
  marks: [],
};

describe("timeline layout", () => {
  it("keeps lane order and divides only adjacent group transitions", () => {
    const layout = layoutTimeline(section, 1200, now);
    expect(layout.lanes.map(({ lane }) => lane.id)).toEqual(["b", "a", "c"]);
    expect(layout.lanes.map(({ divider }) => divider)).toEqual([false, false, true]);
    expect(layout.lanes.map(({ y }) => y)).toEqual([66, 126, 186]);
    expect(layout.nowX).toBeNull();
  });

  it("clips intersections, omits outside items, and gives endpoint zero durations a bounded width", () => {
    const layout = layoutTimeline(
      {
        ...section,
        spans: [
          {
            lane: "b",
            title: "Both ends",
            from: "2026-10-05T11:00:00Z",
            to: "2026-10-05T14:00:00Z",
          },
          { lane: "b", title: "Before", from: "2026-10-05T10:00:00Z", to: "2026-10-05T11:00:00Z" },
          { lane: "b", title: "After", from: "2026-10-05T14:00:00Z", to: "2026-10-05T15:00:00Z" },
          { lane: "a", title: "Zero", from, to: from },
          { lane: "a", title: "Zero", from: to, to },
        ],
        marks: [from, to, "2026-10-05T11:00:00Z", "2026-10-05T14:00:00Z"].map((at) => ({
          lane: "a",
          at,
          glyph: "*",
          title: "Mark",
        })),
      },
      1200,
      now,
    );
    expect(layout.spans.map(({ index }) => index)).toEqual([0, 3, 4]);
    expect(layout.spans[0]?.x).toBe(layout.plot.left);
    expect(layout.spans[0]?.width).toBe(layout.plot.right - layout.plot.left);
    for (const item of layout.spans) {
      expect(item.width).toBeGreaterThan(0);
      expect(item.x).toBeGreaterThanOrEqual(layout.plot.left);
      expect(item.x + item.width).toBeLessThanOrEqual(layout.plot.right);
    }
    expect(layout.marks.map(({ index }) => index)).toEqual([0, 1]);
    expect(layout.marks.map(({ x }) => x)).toEqual([layout.plot.left, layout.plot.right]);
  });

  it("preserves source indexes and paint order for overlapping, identical spans", () => {
    const span = { lane: "a", from, to, title: "Same" };
    const layout = layoutTimeline(
      { ...section, spans: [span, span, { ...span, lane: "b" }] },
      1000,
      now,
    );
    expect(layout.spans.map(({ index }) => index)).toEqual([0, 1, 2]);
    expect(layout.spans.map(({ laneIndex }) => laneIndex)).toEqual([1, 1, 0]);
    expect(layout.spans[0]?.y).toBe(layout.spans[1]?.y);
  });

  it("extends fixed open spans to the upper bound, regardless of now", () => {
    const value = { ...section, spans: [{ lane: "b", from, title: "Open" }] };
    const layout = layoutTimeline(value, 1000, Date.parse(from) - 1000);
    expect(layout.spans[0]?.width).toBe(layout.plot.right - layout.plot.left);
  });

  it("uses offsets and stops clock-open spans at now or until without negative widths", () => {
    const live: CanvasTimelineSection = {
      ...section,
      window: { from: "2026-10-05T07:00:00-05:00", clock: { until: "2026-10-05T15:00:00+02:00" } },
      spans: [
        { lane: "b", from, title: "Open" },
        { lane: "a", from: "2026-10-05T12:45:00Z", title: "Future" },
      ],
    };
    const before = layoutTimeline(live, 1000, Date.parse(from) - 1);
    expect(before.spans).toEqual([]);
    expect(before.nowX).toBeNull();
    const inside = layoutTimeline(live, 1000, now);
    expect(inside.spans.map(({ index }) => index)).toEqual([0]);
    expect(inside.spans[0]?.width).toBe((inside.plot.right - inside.plot.left) / 2);
    expect(inside.nowX).toBe((inside.plot.left + inside.plot.right) / 2);
    const after = layoutTimeline(live, 1000, Date.parse(to) + 1);
    expect(after.spans[0]?.width).toBe(after.plot.right - after.plot.left);
    expect(after.nowX).toBeNull();
    expect(layoutTimeline(live, 1000, Date.parse(from)).nowX).toBe(after.plot.left);
    expect(layoutTimeline(live, 1000, Date.parse(to)).nowX).toBe(after.plot.right);
  });

  it("generates finite, bounded ticks suited to plot width and short or long ranges", () => {
    for (const window of [
      { from, to: "2026-10-05T12:00:05Z" },
      { from, to },
      { from, to: "2026-10-09T12:00:00Z" },
      { from, to: "2027-10-05T12:00:00Z" },
    ]) {
      for (const width of [720, 1200, 10000]) {
        const layout = layoutTimeline({ ...section, window }, width, now);
        expect(layout.ticks.length).toBeGreaterThanOrEqual(2);
        expect(layout.ticks.length).toBeLessThanOrEqual(8);
        expect(layout.ticks[0]?.x).toBe(layout.plot.left);
        expect(layout.ticks.at(-1)?.x).toBe(layout.plot.right);
        for (const tick of layout.ticks) {
          expect(Number.isFinite(tick.at) && Number.isFinite(tick.x)).toBe(true);
          expect(tick.label).not.toBe("");
          expect(tick.x).toBeGreaterThanOrEqual(layout.plot.left);
          expect(tick.x).toBeLessThanOrEqual(layout.plot.right);
        }
      }
    }
  });
});
