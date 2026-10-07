import type {
  CanvasTimelineMark,
  CanvasTimelineSection,
  CanvasTimelineSpan,
} from "@keelson/shared";
import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  formatTimelineTimestamp,
  formatTimelineZone,
  layoutTimeline,
} from "../../lib/boardTimelineLayout.ts";
import { useClockNow } from "../../lib/relativeClock.ts";

// A bar narrower than this shows only a sliver of its title, so it keeps the
// title in its tooltip and accessible name instead.
const MIN_TITLE_WIDTH = 48;

function timeText(iso: string) {
  return formatTimelineTimestamp(Date.parse(iso));
}

function spanDescription(span: CanvasTimelineSpan) {
  const end = span.to ? timeText(span.to) : "open-ended";
  return `${span.title}: ${timeText(span.from)} to ${end}${span.hatched ? " (hatched)" : ""}`;
}

function markDescription(mark: CanvasTimelineMark) {
  return `${mark.title}: ${timeText(mark.at)}`;
}

function TimelineContents({
  section,
  width,
  now,
}: {
  section: CanvasTimelineSection;
  width: number;
  now: number;
}) {
  const id = useId();
  const layout = layoutTimeline(section, width, now);
  const until = "clock" in section.window ? section.window.clock.until : section.window.to;
  const zone = formatTimelineZone(Date.parse(section.window.from));
  return (
    <>
      <div className="cvb-timeline-window">
        <time dateTime={section.window.from}>{timeText(section.window.from)}</time>
        {" to "}
        <time dateTime={until}>{timeText(until)}</time>
        {` · axis in ${zone}`}
      </div>
      {width < 720 ? (
        <div className="cvb-timeline-list">
          {layout.lanes.map(({ lane, divider }, laneIndex) => {
            const spans = section.spans
              .map((span, index) => ({ span, index }))
              .filter(({ span }) => span.lane === lane.id);
            const marks = section.marks
              .map((mark, index) => ({ mark, index }))
              .filter(({ mark }) => mark.lane === lane.id);
            return (
              <div
                className="cvb-timeline-list-lane"
                key={lane.id}
                data-divider={divider || undefined}
              >
                {(laneIndex === 0 || divider) && lane.group && (
                  <div className="cvb-timeline-group">{lane.group}</div>
                )}
                <h3 className="cvb-timeline-lane-name" data-tone={lane.tone ?? "neutral"}>
                  {lane.label}
                </h3>
                {spans.length + marks.length === 0 ? (
                  <p className="cvb-timeline-empty">No activity</p>
                ) : (
                  <ul>
                    {spans.map(({ span, index }) => (
                      <li key={`span-${index}`} data-source-index={index}>
                        <strong>{span.title}</strong>
                        {" · "}
                        <time dateTime={span.from}>{timeText(span.from)}</time>
                        {" to "}
                        {span.to ? (
                          <time dateTime={span.to}>{timeText(span.to)}</time>
                        ) : (
                          "open-ended"
                        )}
                        {span.hatched && " · hatched"}
                      </li>
                    ))}
                    {marks.map(({ mark, index }) => (
                      <li key={`mark-${index}`} data-source-index={index}>
                        {mark.glyph} <strong>{mark.title}</strong>
                        {" · "}
                        <time dateTime={mark.at}>{timeText(mark.at)}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <svg
          className="cvb-timeline-plot"
          width="100%"
          viewBox={`0 0 ${width} ${layout.height}`}
          aria-label={`${section.title ?? "Timeline"}; time axis in ${zone}`}
        >
          <title>{section.title ?? "Timeline"}</title>
          <defs>
            <pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse">
              <path className="cvb-timeline-hatch-line" d="M -1 1 L 1 -1 M 0 6 L 6 0 M 5 7 L 7 5" />
            </pattern>
            <clipPath id={`${id}-plot`}>
              <rect
                x={layout.plot.left - 10}
                y={layout.plot.top}
                width={layout.plot.right - layout.plot.left + 20}
                height={layout.plot.bottom - layout.plot.top}
              />
            </clipPath>
            {layout.spans.map(({ index, x, y, width: spanWidth }) => (
              <clipPath key={index} id={`${id}-span-${index}`}>
                <rect x={x} y={y - 13} width={spanWidth} height="26" rx="5" />
              </clipPath>
            ))}
          </defs>
          {layout.ticks.map((tick, index) => (
            <g key={tick.at}>
              <line
                className="cvb-timeline-grid"
                x1={tick.x}
                x2={tick.x}
                y1={layout.plot.top}
                y2={layout.plot.bottom}
              />
              <text
                className="cvb-timeline-tick"
                x={tick.x}
                y="16"
                textAnchor={
                  index === 0 ? "start" : index === layout.ticks.length - 1 ? "end" : "middle"
                }
              >
                {tick.label}
              </text>
            </g>
          ))}
          {layout.lanes.map(({ lane, y, divider }, index) => (
            <g key={lane.id} data-lane={lane.id}>
              {divider && (
                <line className="cvb-timeline-divider" x1="0" x2={width} y1={y - 30} y2={y - 30} />
              )}
              <foreignObject x="0" y={y - 27} width="148" height="54">
                <div className="cvb-timeline-lane-label">
                  {(index === 0 || divider) && lane.group && (
                    <div className="cvb-timeline-group">{lane.group}</div>
                  )}
                  <div
                    className="cvb-timeline-lane-name"
                    data-tone={lane.tone ?? "neutral"}
                    title={lane.label}
                  >
                    {lane.label}
                  </div>
                </div>
              </foreignObject>
            </g>
          ))}
          <g clipPath={`url(#${id}-plot)`}>
            {layout.spans.map(({ span, index, laneIndex, x, y, width: spanWidth }) => (
              <g
                key={index}
                className="cvb-timeline-span"
                data-source-index={index}
                data-tone={span.tone ?? section.lanes[laneIndex]!.tone ?? "neutral"}
                data-open={span.to === undefined || undefined}
                data-hatched={span.hatched || undefined}
                aria-label={`${section.lanes[laneIndex]!.label}, ${spanDescription(span)}`}
              >
                <title>{spanDescription(span)}</title>
                <rect
                  className="cvb-timeline-bar"
                  x={x}
                  y={y - 13}
                  width={spanWidth}
                  height="26"
                  rx="5"
                />
                {span.hatched && (
                  <rect
                    className="cvb-timeline-hatch"
                    x={x}
                    y={y - 13}
                    width={spanWidth}
                    height="26"
                    rx="5"
                    fill={`url(#${id}-hatch)`}
                  />
                )}
                {spanWidth >= MIN_TITLE_WIDTH && (
                  <text
                    className="cvb-timeline-span-title"
                    x={x + 8}
                    y={y + 4}
                    clipPath={`url(#${id}-span-${index})`}
                  >
                    {span.title}
                  </text>
                )}
              </g>
            ))}
            {layout.marks.map(({ mark, index, laneIndex, x, y }) => (
              <g
                key={index}
                className="cvb-timeline-mark"
                data-source-index={index}
                aria-label={`${section.lanes[laneIndex]!.label}, ${markDescription(mark)}`}
              >
                <title>{markDescription(mark)}</title>
                <text x={x} y={y + 28} textAnchor="middle">
                  {mark.glyph}
                </text>
              </g>
            ))}
          </g>
          {layout.nowX !== null && (
            <g className="cvb-timeline-now" aria-label="Now">
              <line
                x1={layout.nowX}
                x2={layout.nowX}
                y1={layout.plot.top}
                y2={layout.plot.bottom}
              />
              <text x={layout.nowX} y="30" textAnchor="middle">
                now
              </text>
            </g>
          )}
        </svg>
      )}
      {section.legend && <div className="cvb-timeline-legend">{section.legend}</div>}
    </>
  );
}

function LiveTimeline({ section, width }: { section: CanvasTimelineSection; width: number }) {
  return <TimelineContents section={section} width={width} now={useClockNow()} />;
}

export function TimelineSection({ section }: { section: CanvasTimelineSection }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const measured = root.getBoundingClientRect().width;
      if (measured > 0) setWidth(measured);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={rootRef} className="cvb-timeline" data-narrow={width < 720 || undefined}>
      {"clock" in section.window ? (
        <LiveTimeline section={section} width={width} />
      ) : (
        <TimelineContents section={section} width={width} now={0} />
      )}
    </div>
  );
}
