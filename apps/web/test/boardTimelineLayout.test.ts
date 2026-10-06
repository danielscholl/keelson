import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { CanvasTimelineSection } from "@keelson/shared";
import {
  formatTimelineTimestamp,
  formatTimelineZone,
  layoutTimeline,
} from "../src/lib/boardTimelineLayout.ts";

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
  const originalTZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Chicago";
  });
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  it("formats full local timestamps with dates and millisecond precision", () => {
    expect(formatTimelineTimestamp(Date.parse("2026-10-05T22:36:07.360Z"))).toBe(
      "2026-10-05 17:36:07.360",
    );
    expect(formatTimelineTimestamp(Date.parse("2026-10-06T00:00:00.005Z"))).toBe(
      "2026-10-05 19:00:00.005",
    );
    expect(() => formatTimelineTimestamp(Number.NaN)).toThrow(RangeError);
  });

  it.each(["2026-01-05T12:00:00Z", "2026-10-05T12:00:00Z"])(
    "derives the short local zone at %s",
    (iso) => {
      const at = Date.parse(iso);
      const expected = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value;
      expect(expected).toBeDefined();
      expect(formatTimelineZone(at)).toBe(expected!);
    },
  );

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
      { from, to: "2026-10-05T12:00:00.500Z" },
      { from, to: "2026-10-05T12:00:05Z" },
      { from, to },
      { from: "2026-11-01T05:00:00Z", to: "2026-11-01T08:00:00Z" },
      { from, to: "2026-10-09T12:00:00Z" },
      { from, to: "2027-10-05T12:00:00Z" },
    ]) {
      for (const width of [720, 1200, 10000]) {
        const layout = layoutTimeline({ ...section, window }, width, now);
        expect(layout.ticks.length).toBeGreaterThanOrEqual(2);
        expect(layout.ticks.length).toBeLessThanOrEqual(8);
        expect(new Set(layout.ticks.map((tick) => tick.label)).size).toBe(layout.ticks.length);
        for (const tick of layout.ticks) {
          expect(Number.isFinite(tick.at) && Number.isFinite(tick.x)).toBe(true);
          expect(tick.label).not.toBe("");
          expect(tick.x).toBeGreaterThanOrEqual(layout.plot.left);
          expect(tick.x).toBeLessThanOrEqual(layout.plot.right);
        }
      }
    }
  });

  it.each([
    {
      from: "2026-10-05T12:00:00.100Z",
      to: "2026-10-05T12:00:00.900Z",
      labels: ["07:00:00.100", "07:00:00.900"],
    },
    {
      from: "2026-10-05T07:00:00.900-05:00",
      to: "2026-10-05T14:00:01.100+02:00",
      labels: ["07:00:00.900", "07:00:01.100"],
    },
  ])("includes milliseconds for sub-second tick intervals from $from", ({ from, to, labels }) => {
    for (const window of [
      { from, to },
      { from, clock: { until: to } },
    ]) {
      for (const width of [720, 1200, 10000]) {
        const layout = layoutTimeline({ ...section, window }, width, now);
        expect(layout.ticks.map((tick) => tick.label)).toEqual(labels);
        expect(layout.ticks.map((tick) => tick.at)).toEqual([Date.parse(from), Date.parse(to)]);
        expect(layout.ticks.map((tick) => tick.x)).toEqual([160, width - 24]);
      }
    }
  });

  it("keeps whole-second ticks compact and distinct in a five-second window", () => {
    const layout = layoutTimeline(
      { ...section, window: { from, to: "2026-10-05T12:00:05Z" } },
      1200,
      now,
    );
    expect(layout.ticks.map((tick) => tick.label)).toEqual([
      "07:00:00",
      "07:00:01",
      "07:00:02",
      "07:00:03",
      "07:00:04",
      "07:00:05",
    ]);
  });

  it("places ticks on round times", () => {
    const layout = layoutTimeline({ ...section, window: { from, to } }, 1200, now);
    expect(layout.ticks.map((tick) => tick.label)).toEqual([
      "07:00",
      "07:10",
      "07:20",
      "07:30",
      "07:40",
      "07:50",
      "08:00",
    ]);
    expect(layout.ticks.map((tick) => tick.at)).toEqual(
      [
        "2026-10-05T12:00:00Z",
        "2026-10-05T12:10:00Z",
        "2026-10-05T12:20:00Z",
        "2026-10-05T12:30:00Z",
        "2026-10-05T12:40:00Z",
        "2026-10-05T12:50:00Z",
        "2026-10-05T13:00:00Z",
      ].map((iso) => Date.parse(iso)),
    );
    layout.ticks.forEach((tick, index) => {
      expect(tick.x).toBeCloseTo(160 + (1016 * index) / 6);
    });
  });

  it.each([false, true])("dates ticks across local midnight (live=%s)", (live) => {
    const from = "2026-10-06T04:59:30Z";
    const to = "2026-10-06T05:00:30Z";
    const layout = layoutTimeline(
      {
        ...section,
        window: live ? { from, clock: { until: to } } : { from, to },
      },
      1200,
      now,
    );
    expect(layout.ticks.map((tick) => tick.label)).toEqual([
      "10-05 23:59:30",
      "10-05 23:59:45",
      "10-06 00:00:00",
      "10-06 00:00:15",
      "10-06 00:00:30",
    ]);
    expect(layout.ticks.map((tick) => tick.at)).toEqual(
      [
        "2026-10-06T04:59:30Z",
        "2026-10-06T04:59:45Z",
        "2026-10-06T05:00:00Z",
        "2026-10-06T05:00:15Z",
        "2026-10-06T05:00:30Z",
      ].map((iso) => Date.parse(iso)),
    );
    expect(layout.ticks.map((tick) => tick.x)).toEqual([160, 414, 668, 922, 1176]);
  });

  it.each([
    {
      from: "2026-10-05T23:59:59.900-05:00",
      to: "2026-10-06T07:00:00.100+02:00",
      labels: ["10-05 23:59:59.900", "10-06 00:00:00.100"],
    },
    {
      from: "2027-01-01T05:59:59.900Z",
      to: "2027-01-01T06:00:00.100Z",
      labels: ["12-31 23:59:59.900", "01-01 00:00:00.100"],
    },
    {
      from: "2026-10-06T04:30:00Z",
      to: "2026-10-06T05:30:00Z",
      labels: [
        "10-05 23:30",
        "10-05 23:40",
        "10-05 23:50",
        "10-06 00:00",
        "10-06 00:10",
        "10-06 00:20",
        "10-06 00:30",
      ],
    },
  ])("retains tick precision with dates across midnight from $from", ({ from, to, labels }) => {
    for (const window of [
      { from, to },
      { from, clock: { until: to } },
    ]) {
      const layout = layoutTimeline({ ...section, window }, 1200, now);
      expect(layout.ticks.map((tick) => tick.label)).toEqual(labels);
    }
  });

  it.each([false, true])(
    "disambiguates repeated fall-back ticks without moving them (live=%s)",
    (live) => {
      const from = "2026-11-01T05:00:00Z";
      const to = "2026-11-01T08:00:00Z";
      const layout = layoutTimeline(
        { ...section, window: live ? { from, clock: { until: to } } : { from, to } },
        1200,
        now,
      );
      expect(layout.ticks.map((tick) => tick.label)).toEqual([
        "00:00",
        "00:30",
        "01:00 GMT-5",
        "01:30 GMT-5",
        "01:00 GMT-6",
        "01:30 GMT-6",
        "02:00",
      ]);
      expect(layout.ticks.map((tick) => tick.at)).toEqual(
        [
          "2026-11-01T05:00:00Z",
          "2026-11-01T05:30:00Z",
          "2026-11-01T06:00:00Z",
          "2026-11-01T06:30:00Z",
          "2026-11-01T07:00:00Z",
          "2026-11-01T07:30:00Z",
          "2026-11-01T08:00:00Z",
        ].map((iso) => Date.parse(iso)),
      );
      layout.ticks.forEach((tick, index) => {
        expect(tick.x).toBeCloseTo(160 + (1016 * index) / 6);
      });
    },
  );

  it("keeps elapsed tick epochs and positions across spring-forward DST", () => {
    const layout = layoutTimeline(
      {
        ...section,
        window: { from: "2026-03-08T07:00:00Z", to: "2026-03-08T10:00:00Z" },
      },
      1200,
      now,
    );
    expect(layout.ticks.map((tick) => tick.label)).toEqual([
      "01:00",
      "01:30",
      "03:00",
      "03:30",
      "04:00",
      "04:30",
      "05:00",
    ]);
    expect(layout.ticks.map((tick) => tick.at)).toEqual(
      [
        "2026-03-08T07:00:00Z",
        "2026-03-08T07:30:00Z",
        "2026-03-08T08:00:00Z",
        "2026-03-08T08:30:00Z",
        "2026-03-08T09:00:00Z",
        "2026-03-08T09:30:00Z",
        "2026-03-08T10:00:00Z",
      ].map((iso) => Date.parse(iso)),
    );
    layout.ticks.forEach((tick, index) => {
      expect(tick.x).toBeCloseTo(160 + (1016 * index) / 6);
    });
  });

  it("projects multi-day tick dates locally without re-anchoring at local midnight", () => {
    const layout = layoutTimeline(
      {
        ...section,
        window: { from: "2026-10-05T00:00:00Z", to: "2026-10-07T00:00:00Z" },
      },
      1200,
      now,
    );
    expect(layout.ticks.map((tick) => tick.label)).toEqual([
      "10-04 19:00",
      "10-05 07:00",
      "10-05 19:00",
      "10-06 07:00",
      "10-06 19:00",
    ]);
    expect(layout.ticks.map((tick) => tick.at)).toEqual(
      [
        "2026-10-05T00:00:00Z",
        "2026-10-05T12:00:00Z",
        "2026-10-06T00:00:00Z",
        "2026-10-06T12:00:00Z",
        "2026-10-07T00:00:00Z",
      ].map((iso) => Date.parse(iso)),
    );
    expect(layout.ticks.map((tick) => tick.x)).toEqual([160, 414, 668, 922, 1176]);
  });

  it("gives equivalent ISO offsets identical epochs, labels, and geometry", () => {
    const utc = layoutTimeline(section, 1200, now);
    for (const window of [
      { from: "2026-10-05T07:00:00-05:00", to: "2026-10-05T15:00:00+02:00" },
      {
        from: "2026-10-05T07:00:00-05:00",
        clock: { until: "2026-10-05T15:00:00+02:00" },
      },
    ]) {
      expect(layoutTimeline({ ...section, window }, 1200, now).ticks).toEqual(utc.ticks);
    }
  });
});
