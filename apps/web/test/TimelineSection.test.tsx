import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CanvasTimelineSection } from "@keelson/shared";
import { act, render } from "@testing-library/react";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";
import { CLOCK_TICK_MS } from "../src/lib/relativeClock.ts";
import { timelineFixture } from "./fixtures/boardTimeline.ts";

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalObserver = globalThis.ResizeObserver;
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = originalObserver;
});

function measureAt(initial: number) {
  let width = initial;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("cvb-timeline")
      ? new DOMRect(0, 0, width, 400)
      : originalRect.call(this);
  };
  return (next: number) => {
    width = next;
  };
}

const fixed: CanvasTimelineSection = {
  ...timelineFixture,
  window: { from: timelineFixture.window.from, to: "2026-10-05T13:00:00Z" },
};

describe("timeline section", () => {
  test("renders ordered lanes, groups, ticks, inherited tones, overrides, hatch and open treatments", () => {
    measureAt(1200);
    const { container } = render(<BoardView view={{ view: "board", sections: [fixed] }} />);
    expect(container.querySelector(".cvb-section-title")?.textContent).toBe(fixed.title);
    expect(
      [...container.querySelectorAll(".cvb-timeline-lane-name")].map((el) => el.textContent),
    ).toEqual(fixed.lanes.map((lane) => lane.label));
    expect(
      [...container.querySelectorAll(".cvb-timeline-group")].map((el) => el.textContent),
    ).toEqual(["Assembly", "Verification"]);
    expect(container.querySelectorAll(".cvb-timeline-divider")).toHaveLength(1);
    expect(container.querySelectorAll(".cvb-timeline-tick").length).toBeGreaterThan(2);
    const spans = container.querySelectorAll(".cvb-timeline-span");
    expect(spans).toHaveLength(fixed.spans.length);
    expect([...spans].map((el) => el.getAttribute("data-source-index"))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(spans[0]?.getAttribute("data-tone")).toBe("id-blue");
    expect(spans[2]?.getAttribute("data-tone")).toBe("id-amber");
    expect(spans[3]?.getAttribute("data-tone")).toBe("info");
    expect(spans[3]?.hasAttribute("data-open")).toBe(true);
    expect(spans[3]?.hasAttribute("data-hatched")).toBe(true);
    expect(spans[3]?.querySelector(".cvb-timeline-hatch")).not.toBeNull();
    expect(spans[3]?.getAttribute("aria-label")).toContain("Review, Review in progress:");
    expect(spans[3]?.getAttribute("aria-label")).toContain("open-ended (hatched)");
    expect(container.querySelector(".cvb-timeline-mark title")?.textContent).toBe("Inputs ready");
    expect(container.querySelector(".cvb-timeline-mark text")?.textContent).toBe("\u25c6");
    expect(container.querySelector(".cvb-timeline-legend")?.textContent).toBe(fixed.legend);
    expect(container.querySelector(".cvb-timeline-now")).toBeNull();
  });

  test("uses neutral as the final tone fallback and renders payloads as text", () => {
    measureAt(1200);
    const title = "<script>alert(1)</script>";
    const { container } = render(
      <BoardView
        view={{
          view: "board",
          sections: [
            {
              ...fixed,
              lanes: [{ id: "plain", label: title }],
              spans: [{ lane: "plain", from: fixed.window.from, title }],
              marks: [{ lane: "plain", at: fixed.window.from, glyph: "<", title }],
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".cvb-timeline-span")?.getAttribute("data-tone")).toBe(
      "neutral",
    );
    expect(container.querySelector(".cvb-timeline-span-title")?.textContent).toBe(title);
    expect(container.querySelector("script")).toBeNull();
  });

  test("renders nested timelines and gives each instance distinct hatch and clip ids", () => {
    measureAt(1200);
    const { container } = render(
      <BoardView
        view={{
          view: "board",
          sections: [fixed, { kind: "columns", columns: [{ sections: [fixed] }] }],
        }}
      />,
    );
    expect(container.querySelector(".cvb-column .cvb-timeline")).not.toBeNull();
    expect(container.querySelector(".cvb-column .cvb-section-title")?.textContent).toBe(
      fixed.title,
    );
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(container.querySelectorAll("pattern")).toHaveLength(2);
    for (const hatch of container.querySelectorAll(".cvb-timeline-hatch")) {
      const id = hatch.getAttribute("fill")?.slice(5, -1);
      expect(ids).toContain(id);
    }
  });

  test("switches at 719/720px, lists every repeated or out-of-window item, and disconnects", () => {
    const changeWidth = measureAt(720);
    let resize!: () => void;
    let observed: Element | undefined;
    let disconnected = 0;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe(target: Element) {
        observed = target;
      }
      unobserve() {}
      disconnect() {
        disconnected++;
      }
    };
    const repeated = fixed.spans[0]!;
    const section: CanvasTimelineSection = {
      ...fixed,
      spans: [
        ...fixed.spans,
        repeated,
        { ...repeated, from: "2026-10-05T10:00:00Z", to: "2026-10-05T11:00:00Z" },
      ],
      marks: [...fixed.marks, { ...fixed.marks[0]!, at: "2026-10-05T14:00:00Z" }],
    };
    const { container, unmount } = render(
      <BoardView view={{ view: "board", sections: [section] }} />,
    );
    expect(observed).toBe(container.querySelector(".cvb-timeline")!);
    expect(container.querySelector(".cvb-timeline-plot")).not.toBeNull();
    act(() => {
      changeWidth(719);
      resize();
    });
    expect(container.querySelector(".cvb-timeline-plot")).toBeNull();
    expect(container.querySelector(".cvb-timeline")?.hasAttribute("data-narrow")).toBe(true);
    expect(container.querySelectorAll(".cvb-timeline-list li")).toHaveLength(
      section.spans.length + section.marks.length,
    );
    expect(container.textContent).toContain("open-ended");
    expect(container.textContent).toContain("hatched");
    expect(container.textContent).toContain("No activity");
    expect(container.textContent).toContain("14:00");
    expect(container.textContent).not.toContain("2026-10-05T");
    expect(container.querySelectorAll(".cvb-timeline-list time")).toHaveLength(
      2 * section.spans.length - 1 + section.marks.length,
    );
    expect(
      [...container.querySelectorAll(".cvb-timeline-lane-name")].map((el) => el.textContent),
    ).toEqual(section.lanes.map((lane) => lane.label));
    act(() => {
      changeWidth(720);
      resize();
    });
    expect(container.querySelector(".cvb-timeline-plot")).not.toBeNull();
    expect(container.querySelector(".cvb-timeline-list")).toBeNull();
    unmount();
    expect(disconnected).toBe(1);
  });

  test("moves now and running endpoints with unchanged props using the existing shared clock", () => {
    measureAt(1200);
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-10-05T12:30:00Z"));
    const start = spyOn(globalThis, "setInterval");
    const stop = spyOn(globalThis, "clearInterval");
    const { container, unmount } = render(
      <BoardView
        view={{
          view: "board",
          sections: [
            timelineFixture,
            {
              kind: "stats",
              items: [
                { label: "Elapsed", clock: { at: timelineFixture.window.from, mode: "since" } },
              ],
            },
          ],
        }}
      />,
    );
    try {
      expect(start).toHaveBeenCalledTimes(1);
      const rule = container.querySelector(".cvb-timeline-now line");
      const bar = container.querySelector(".cvb-timeline-span[data-open] .cvb-timeline-bar");
      const beforeX = Number(rule?.getAttribute("x1"));
      const beforeWidth = Number(bar?.getAttribute("width"));
      const tick = start.mock.calls[0]?.[0];
      if (typeof tick !== "function") throw new Error("clock interval was not registered");
      act(() => {
        jest.setSystemTime(Date.now() + CLOCK_TICK_MS);
        tick();
      });
      expect(Number(rule?.getAttribute("x1"))).toBeGreaterThan(beforeX);
      expect(Number(bar?.getAttribute("width"))).toBeGreaterThan(beforeWidth);
      act(() => {
        jest.setSystemTime(Date.parse("2026-10-05T13:01:00Z"));
        tick();
      });
      expect(container.querySelector(".cvb-timeline-now")).toBeNull();
      unmount();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      start.mockRestore();
      stop.mockRestore();
      jest.useRealTimers();
    }
  });

  test("starts no timer for a fixed timeline", () => {
    const start = spyOn(globalThis, "setInterval");
    try {
      render(<BoardView view={{ view: "board", sections: [fixed] }} />);
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });

  test("has no literal colors in the renderer or timeline CSS rules", () => {
    const renderer = readFileSync(
      new URL("../src/components/Canvas/TimelineSection.tsx", import.meta.url),
      "utf8",
    );
    const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
    const rules = css.match(/[^{}]*\.cvb-timeline[^{}]*\{[^}]*\}/g)?.join("\n") ?? "";
    expect(`${renderer}\n${rules}`).not.toMatch(
      /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\s*\(|(?:fill|stroke|color|background)(?:=|:)\s*["']?(?:white|black|red|blue|green|yellow|gray|grey|orange|purple)\b/i,
    );
  });
});
