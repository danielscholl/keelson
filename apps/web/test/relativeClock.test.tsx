import { describe, expect, jest, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { act, render, renderHook } from "@testing-library/react";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";
import { CLOCK_TICK_MS, formatClock, useClockNow } from "../src/lib/relativeClock.ts";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const min = (n: number) => n * 60_000;

describe("formatClock", () => {
  test("since reads elapsed time, with a just-now floor that absorbs small skew", () => {
    expect(formatClock(NOW - 20_000, NOW, "since")).toBe("just now");
    expect(formatClock(NOW + 5_000, NOW, "since")).toBe("just now");
    expect(formatClock(NOW - min(4), NOW, "since")).toBe("4 min ago");
    expect(formatClock(NOW - min(60), NOW, "since")).toBe("1 h ago");
    expect(formatClock(NOW - min(125), NOW, "since")).toBe("2 h 5 min ago");
    expect(formatClock(NOW - min(60 * 26), NOW, "since")).toBe("1 d 2 h ago");
  });

  test("until reads remaining time, then due, then overrun", () => {
    expect(formatClock(NOW + min(53), NOW, "until")).toBe("53 min left");
    expect(formatClock(NOW + 30_000, NOW, "until")).toBe("due now");
    expect(formatClock(NOW - 30_000, NOW, "until")).toBe("due now");
    expect(formatClock(NOW - min(3), NOW, "until")).toBe("3 min over");
  });
});

describe("useClockNow", () => {
  test("every mounted clock shares one interval, which stops after the last unmount", () => {
    jest.useFakeTimers();
    try {
      const a = renderHook(() => useClockNow());
      const b = renderHook(() => useClockNow());
      expect(jest.getTimerCount()).toBe(1);
      const first = a.result.current;
      act(() => {
        jest.advanceTimersByTime(CLOCK_TICK_MS);
      });
      expect(a.result.current).toBeGreaterThan(first);
      expect(b.result.current).toBe(a.result.current);
      a.unmount();
      expect(jest.getTimerCount()).toBe(1);
      b.unmount();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

function board(sections: unknown[]): CanvasBoardView {
  return { view: "board", sections } as CanvasBoardView;
}

describe("relative clock on a board", () => {
  test("a stat and a card field render a <time> relative to now", () => {
    // Mid-minute offsets: the idle clock snapshot may lag real time by up to a tick.
    const fourMinAgo = new Date(Date.now() - 4 * 60_000 - 30_000).toISOString();
    const inAnHour = new Date(Date.now() + 60 * 60_000 + 10_000).toISOString();
    const { container } = render(
      <BoardView
        view={board([
          {
            kind: "stats",
            items: [{ label: "Started", clock: { at: fourMinAgo, mode: "since" } }],
          },
          {
            kind: "cards",
            items: [
              {
                title: "lead",
                fields: [{ label: "gate", clock: { at: inAnHour, mode: "until" } }],
              },
            ],
          },
        ])}
      />,
    );
    const times = [...container.querySelectorAll("time")];
    expect(times.map((t) => t.textContent)).toEqual(["4 min ago", "1 h left"]);
    expect(times[0]?.getAttribute("datetime")).toBe(fourMinAgo);
    expect(times[0]?.classList.contains("cvb-stat-value")).toBe(true);
    expect(times[1]?.classList.contains("cvb-field-value")).toBe(true);
  });
});
