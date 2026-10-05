import type { CanvasTimelineSection } from "@keelson/shared";

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
  const count = Math.min(8, Math.max(2, Math.floor((plot.right - plot.left) / 120) + 1));
  const interval = (to - from) / (count - 1);
  const ticks = Array.from({ length: count }, (_, index) => {
    const at = from + interval * index;
    const iso = new Date(at).toISOString();
    const label =
      interval < 60_000
        ? iso.slice(11, 19)
        : to - from < 86_400_000
          ? iso.slice(11, 16)
          : interval < 604_800_000
            ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
            : iso.slice(0, 10);
    return { at, x: scale(at), label };
  });
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
