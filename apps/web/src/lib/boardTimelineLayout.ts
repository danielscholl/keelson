import type { CanvasTimelineSection } from "@keelson/shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICK_STEPS = [
  1_000,
  5_000,
  15_000,
  30_000,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  30 * DAY,
  91 * DAY,
  365 * DAY,
];

export function formatTimelineTime(at: number, range: number, interval = range) {
  const iso = new Date(at).toISOString();
  if (interval < 1_000) return iso.slice(11, 23);
  if (range < 5 * MINUTE) return iso.slice(11, 19);
  if (range < DAY) return iso.slice(11, 16);
  if (range < 7 * DAY) return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  return iso.slice(0, 10);
}

export function layoutTimeline(section: CanvasTimelineSection, width: number, now: number) {
  const from = Date.parse(section.window.from);
  const to = Date.parse("clock" in section.window ? section.window.clock.until : section.window.to);
  const plot = {
    left: 160,
    right: Math.max(164, width - 24),
    top: 36,
    bottom: 36 + section.lanes.length * 60,
  };
  const scale = (at: number) => plot.left + ((at - from) / (to - from)) * (plot.right - plot.left);
  const lanes = section.lanes.map((lane, index) => ({
    lane,
    y: plot.top + index * 60 + 30,
    divider: index > 0 && lane.group !== section.lanes[index - 1]?.group,
  }));
  const laneIndexes = new Map(section.lanes.map((lane, index) => [lane.id, index]));
  const spans = section.spans.flatMap((span, index) => {
    const start = Date.parse(span.from);
    const end =
      span.to === undefined
        ? "clock" in section.window
          ? Math.min(now, to)
          : to
        : Date.parse(span.to);
    if (end < start || end < from || start > to) return [];
    const laneIndex = laneIndexes.get(span.lane)!;
    const x = Math.min(scale(Math.max(from, start)), plot.right - 3);
    const right = scale(Math.min(to, end));
    return [
      {
        span,
        index,
        laneIndex,
        x,
        width: Math.min(plot.right - x, Math.max(3, right - x)),
        y: lanes[laneIndex]!.y,
      },
    ];
  });
  const marks = section.marks.flatMap((mark, index) => {
    const at = Date.parse(mark.at);
    if (at < from || at > to) return [];
    const laneIndex = laneIndexes.get(mark.lane)!;
    return [{ mark, index, laneIndex, x: scale(at), y: lanes[laneIndex]!.y }];
  });
  const maxTicks = Math.min(8, Math.max(2, Math.floor((plot.right - plot.left) / 120) + 1));
  const step =
    TICK_STEPS.find((s) => (to - from) / s <= maxTicks - 1) ?? (to - from) / (maxTicks - 1);
  let times: number[] = [];
  for (let at = Math.ceil(from / step) * step; at <= to; at += step) times.push(at);
  if (times.length < 2) times = [from, to];
  const interval = times[1]! - times[0]!;
  const ticks = times.map((at) => ({
    at,
    x: scale(at),
    label: formatTimelineTime(at, to - from, interval),
  }));
  return {
    plot,
    height: plot.bottom + 12,
    lanes,
    spans,
    marks,
    ticks,
    nowX: "clock" in section.window && now >= from && now <= to ? scale(now) : null,
  };
}
