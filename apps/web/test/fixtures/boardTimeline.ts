import type { CanvasTimelineSection } from "@keelson/shared";

export const timelineFixture: CanvasTimelineSection = {
  kind: "timeline",
  title: "Activity window",
  window: { from: "2026-10-05T12:00:00Z", clock: { until: "2026-10-05T13:00:00Z" } },
  lanes: [
    { id: "north", label: "North", tone: "id-blue", group: "Assembly" },
    { id: "south", label: "South", tone: "id-amber", group: "Assembly" },
    { id: "review", label: "Review", tone: "id-teal", group: "Verification" },
    { id: "release", label: "Release", tone: "id-rose", group: "Verification" },
    { id: "idle", label: "Standby", tone: "id-olive", group: "Verification" },
  ],
  spans: [
    {
      lane: "north",
      from: "2026-10-05T12:00:00Z",
      to: "2026-10-05T12:12:00Z",
      title: "Prepare inputs",
    },
    { lane: "north", from: "2026-10-05T12:15:00Z", to: "2026-10-05T12:29:00Z", title: "Assemble" },
    {
      lane: "south",
      from: "2026-10-05T12:04:00Z",
      to: "2026-10-05T12:24:00Z",
      title: "Explore alternatives",
      hatched: true,
    },
    {
      lane: "review",
      from: "2026-10-05T12:20:00Z",
      title: "Review in progress",
      tone: "info",
      hatched: true,
    },
    {
      lane: "release",
      from: "2026-10-05T12:38:00Z",
      to: "2026-10-05T12:48:00Z",
      title: "Publish result",
    },
  ],
  marks: [
    { lane: "north", at: "2026-10-05T12:12:00Z", glyph: "\u25c6", title: "Inputs ready" },
    { lane: "review", at: "2026-10-05T12:26:00Z", glyph: "*", title: "Checkpoint" },
  ],
  legend: "Hatched: exploratory work. Dashed outline: open-ended. Marks: checkpoints.",
};
