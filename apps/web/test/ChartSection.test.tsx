import { describe, expect, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { BoardView } from "../src/components/Canvas/BoardView.tsx";

type ChartSeries = { label: string; points: { x: number | string; y: number }[] };

function chartBoard(series: ChartSeries[], extra?: { title?: string; yLabel?: string }) {
  return {
    view: "board",
    sections: [{ kind: "chart", ...extra, series }],
  } as CanvasBoardView;
}

function ramp(label: string, offset: number): ChartSeries {
  return {
    label,
    points: [
      { x: 1, y: 100 + offset },
      { x: 2, y: 220 + offset },
      { x: 3, y: 180 + offset },
    ],
  };
}

// The svg is viewBox-scaled; hover math needs a real on-screen rect, which
// happy-dom doesn't lay out — pin one matching the viewBox aspect.
function pinRect(svg: SVGSVGElement) {
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 720, height: 240, right: 720, bottom: 240, x: 0, y: 0 }) as DOMRect;
}

describe("chart board section", () => {
  test("renders one line per series in fixed --s* palette order", () => {
    const { container } = render(
      <BoardView view={chartBoard([ramp("input", 0), ramp("output", 50), ramp("cache", 90)])} />,
    );
    const paths = container.querySelectorAll("path.cvb-chart-line");
    expect(paths.length).toBe(3);
    expect(paths[0]?.getAttribute("stroke")).toBe("var(--s1)");
    expect(paths[1]?.getAttribute("stroke")).toBe("var(--s2)");
    expect(paths[2]?.getAttribute("stroke")).toBe("var(--s3)");
  });

  test("legend renders for two series and not for one", () => {
    const two = render(<BoardView view={chartBoard([ramp("a", 0), ramp("b", 10)])} />);
    expect(two.container.querySelectorAll(".cvb-chart-legend-item").length).toBe(2);
    two.unmount();
    const one = render(<BoardView view={chartBoard([ramp("solo", 0)])} />);
    expect(one.container.querySelector(".cvb-chart-legend")).toBeNull();
  });

  test("direct endpoint labels appear up to four series and drop at five", () => {
    const four = render(
      <BoardView view={chartBoard([ramp("a", 0), ramp("b", 10), ramp("c", 20), ramp("d", 30)])} />,
    );
    expect(four.container.querySelectorAll(".cvb-chart-endpoint-label").length).toBe(4);
    four.unmount();
    const five = render(
      <BoardView
        view={chartBoard([
          ramp("a", 0),
          ramp("b", 10),
          ramp("c", 20),
          ramp("d", 30),
          ramp("e", 40),
        ])}
      />,
    );
    expect(five.container.querySelectorAll(".cvb-chart-endpoint-label").length).toBe(0);
    // Identity still lands: the legend carries all five.
    expect(five.container.querySelectorAll(".cvb-chart-legend-item").length).toBe(5);
  });

  test("string x values become categories in first-appearance order across series", () => {
    const { container } = render(
      <BoardView
        view={chartBoard([
          {
            label: "runs",
            points: [
              { x: "Mon", y: 3 },
              { x: "Tue", y: 5 },
            ],
          },
          {
            label: "fails",
            points: [
              { x: "Tue", y: 1 },
              { x: "Wed", y: 2 },
            ],
          },
        ])}
      />,
    );
    const labels = [...container.querySelectorAll("text.cvb-chart-axis-label")]
      .map((t) => t.textContent)
      .filter((t) => t === "Mon" || t === "Tue" || t === "Wed");
    expect(labels).toEqual(["Mon", "Tue", "Wed"]);
  });

  test("a single-point series renders a marker dot instead of a path", () => {
    const { container } = render(
      <BoardView view={chartBoard([{ label: "once", points: [{ x: "now", y: 7 }] }])} />,
    );
    expect(container.querySelector("path.cvb-chart-line")).toBeNull();
    expect(container.querySelectorAll("circle").length).toBe(1);
  });

  test("the title lands in the svg's accessible name, with a fallback for empty titles", () => {
    const { container } = render(
      <BoardView view={chartBoard([ramp("input", 0)], { title: "Tokens per round" })} />,
    );
    const svg = container.querySelector("svg.cvb-chart-svg");
    expect(svg?.getAttribute("aria-label")).toBe("Tokens per round: input");
    const untitled = render(<BoardView view={chartBoard([ramp("input", 0)], { title: "" })} />);
    const fallbackSvg = untitled.container.querySelector("svg.cvb-chart-svg");
    expect(fallbackSvg?.getAttribute("aria-label")).toBe("Line chart: input");
  });

  test("endpoint labels ending near the plot bottom shift up instead of piling on the clamp", () => {
    const bottomRamp = (label: string, y: number): ChartSeries => ({
      label,
      points: [
        { x: 1, y: 1000 },
        { x: 2, y },
      ],
    });
    const { container } = render(
      <BoardView
        view={chartBoard([
          bottomRamp("a", 5),
          bottomRamp("b", 6),
          bottomRamp("c", 7),
          bottomRamp("d", 8),
        ])}
      />,
    );
    const ys = [...container.querySelectorAll("text.cvb-chart-endpoint-label")]
      .map((t) => Number(t.getAttribute("y")))
      .sort((a, b) => a - b);
    expect(ys.length).toBe(4);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(12);
    }
  });

  test("a mixed-sign domain draws a zero baseline; a non-negative one does not", () => {
    const mixed = render(
      <BoardView
        view={chartBoard([
          {
            label: "delta",
            points: [
              { x: 1, y: -300 },
              { x: 2, y: 800 },
            ],
          },
        ])}
      />,
    );
    expect(mixed.container.querySelector(".cvb-chart-zero-line")).not.toBeNull();
    mixed.unmount();
    const positive = render(<BoardView view={chartBoard([ramp("up", 0)])} />);
    expect(positive.container.querySelector(".cvb-chart-zero-line")).toBeNull();
  });

  test("numeric x labels bump to the next magnitude tier at the rounding boundary", () => {
    const { container } = render(
      <BoardView
        view={chartBoard([
          {
            label: "wide",
            points: [
              { x: 999999, y: 1 },
              { x: 2000000, y: 2 },
            ],
          },
        ])}
      />,
    );
    const labels = [...container.querySelectorAll("text.cvb-chart-axis-label")].map(
      (t) => t.textContent,
    );
    expect(labels).toContain("1M");
    expect(labels).toContain("2M");
    expect(labels).not.toContain("1000k");
  });

  test("a sub-unit y domain keeps its grid labels distinct", () => {
    const { container } = render(
      <BoardView
        view={chartBoard([
          {
            label: "rate",
            points: [
              { x: 1, y: 0.05 },
              { x: 2, y: 0.15 },
            ],
          },
        ])}
      />,
    );
    // Grid labels are the text elements anchored at the y axis (x = 40).
    const gridLabels = [...container.querySelectorAll("text.cvb-chart-axis-label")]
      .filter((t) => t.getAttribute("x") === "40")
      .map((t) => t.textContent);
    expect(new Set(gridLabels).size).toBe(gridLabels.length);
  });

  test("hover shows a crosshair and a tooltip with per-series values, and leave clears it", () => {
    const { container } = render(
      <BoardView view={chartBoard([ramp("input", 0), ramp("output", 50)], { yLabel: "tokens" })} />,
    );
    const svg = container.querySelector("svg.cvb-chart-svg") as SVGSVGElement;
    pinRect(svg);
    // x=2 is the middle slot; aim at the plot's horizontal center.
    fireEvent.pointerMove(svg, { clientX: 340, clientY: 100 });
    expect(container.querySelector(".cvb-chart-crosshair")).not.toBeNull();
    const tooltip = container.querySelector(".cvb-chart-tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain("input");
    expect(tooltip?.textContent).toContain("220");
    expect(tooltip?.textContent).toContain("output");
    expect(tooltip?.textContent).toContain("270");
    fireEvent.pointerLeave(svg);
    expect(container.querySelector(".cvb-chart-tooltip")).toBeNull();
    expect(container.querySelector(".cvb-chart-crosshair")).toBeNull();
  });

  test("a chart nested inside columns renders", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "columns",
          columns: [{ sections: [{ kind: "chart", series: [ramp("nested", 0)] }] }],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    expect(container.querySelectorAll("path.cvb-chart-line").length).toBe(1);
  });

  test("the area mark adds a fill path under each line; line mark does not", () => {
    const area = {
      view: "board",
      sections: [{ kind: "chart", mark: "area", series: [ramp("a", 0), ramp("b", 40)] }],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={area} />);
    const fills = container.querySelectorAll("path.cvb-chart-area");
    expect(fills.length).toBe(2);
    expect(fills[0]?.getAttribute("fill")).toBe("var(--s1)");
    // The fill closes to the baseline and the stroke line still renders above it.
    expect(fills[0]?.getAttribute("d")).toContain("Z");
    expect(container.querySelectorAll("path.cvb-chart-line").length).toBe(2);
    const line = render(<BoardView view={chartBoard([ramp("a", 0)])} />);
    expect(line.container.querySelectorAll("path.cvb-chart-area").length).toBe(0);
  });

  test("the bar mark renders grouped zero-anchored bars and no lines or endpoint labels", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "chart",
          mark: "bar",
          series: [
            {
              label: "unit",
              points: [
                { x: "core", y: 12 },
                { x: "web", y: 7 },
              ],
            },
            {
              label: "e2e",
              points: [
                { x: "core", y: 3 },
                { x: "web", y: 5 },
              ],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    // 2 slots × 2 series.
    const bars = container.querySelectorAll("path.cvb-chart-bar");
    expect(bars.length).toBe(4);
    expect(bars[0]?.getAttribute("fill")).toBe("var(--s1)");
    expect(container.querySelectorAll("path.cvb-chart-line").length).toBe(0);
    expect(container.querySelectorAll(".cvb-chart-endpoint-label").length).toBe(0);
    // Identity still lands via the legend.
    expect(container.querySelectorAll(".cvb-chart-legend-item").length).toBe(2);
  });

  test("baseline auto lifts the floor to the data's band; the default keeps zero", () => {
    const band: ChartSeries = {
      label: "pass",
      points: [
        { x: "Mon", y: 93.2 },
        { x: "Tue", y: 96.1 },
        { x: "Wed", y: 98.7 },
      ],
    };
    const gridLabels = (container: HTMLElement) =>
      [...container.querySelectorAll("text.cvb-chart-axis-label")]
        .filter((t) => t.getAttribute("x") === "40")
        .map((t) => Number(t.textContent));
    const auto = render(
      <BoardView
        view={
          {
            view: "board",
            sections: [{ kind: "chart", baseline: "auto", series: [band] }],
          } as CanvasBoardView
        }
      />,
    );
    const autoGrid = gridLabels(auto.container);
    expect(Math.min(...autoGrid)).toBeGreaterThan(0);
    expect(Math.min(...autoGrid)).toBeLessThanOrEqual(93.2);
    expect(Math.max(...autoGrid)).toBeGreaterThanOrEqual(98.7);
    auto.unmount();
    const zero = render(<BoardView view={chartBoard([band])} />);
    expect(Math.min(...gridLabels(zero.container))).toBe(0);
  });

  test("bar mark bands numeric x as ordered categories instead of a linear axis", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "chart",
          mark: "bar",
          series: [
            {
              label: "runs",
              points: [
                { x: 1, y: 4 },
                { x: 2, y: 6 },
                { x: 100, y: 2 },
              ],
            },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const bars = [...container.querySelectorAll("path.cvb-chart-bar")];
    expect(bars.length).toBe(3);
    // Even band spacing: the x=2 bar sits midway, not piled next to x=1.
    const xs = bars.map((b) => Number(/M(\d+\.?\d*)/.exec(b.getAttribute("d") ?? "")?.[1]));
    expect(xs[1]! - xs[0]!).toBeCloseTo(xs[2]! - xs[1]!, 0);
  });

  test("a wide grouped-bar chart keeps each slot's bars inside its own band", () => {
    const seriesCount = 6;
    const categoryCount = 30;
    const series: ChartSeries[] = Array.from({ length: seriesCount }, (_, si) => ({
      label: `s${si}`,
      points: Array.from({ length: categoryCount }, (_, ci) => ({
        x: `cat${ci}`,
        y: 10 + si + ci,
      })),
    }));
    const view = {
      view: "board",
      sections: [{ kind: "chart", mark: "bar", series }],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const bars = [...container.querySelectorAll("path.cvb-chart-bar")];
    expect(bars.length).toBe(seriesCount * categoryCount);

    // Every numeric token in a bar path's d is an (x, y) pair; the even
    // indices are x-coordinates, so their min/max give the bar's x extent.
    const xExtent = (d: string): [number, number] => {
      const nums = (d.match(/-?\d+\.?\d*/g) ?? []).map(Number);
      const xs = nums.filter((_, i) => i % 2 === 0);
      return [Math.min(...xs), Math.max(...xs)];
    };
    const groups: [number, number][] = [];
    for (let i = 0; i < bars.length; i += seriesCount) {
      const slotBars = bars.slice(i, i + seriesCount);
      const extents = slotBars.map((b) => xExtent(b.getAttribute("d") ?? ""));
      groups.push([Math.min(...extents.map((e) => e[0])), Math.max(...extents.map((e) => e[1]))]);
    }
    expect(groups.length).toBe(categoryCount);
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i]![0]).toBeGreaterThan(groups[i - 1]![1]);
    }
  });
});

describe("stats delta and spark", () => {
  test("a delta renders its direction glyph and tone; a sparkline renders behind the value", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "stats",
          items: [
            {
              label: "Fail rate",
              value: "2.1%",
              delta: { text: "+0.4pp", direction: "up", tone: "error" },
              spark: [1.2, 1.5, 1.4, 1.7, 2.1],
            },
            { label: "Services", value: 23 },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const delta = container.querySelector(".cvb-stat-delta");
    expect(delta?.textContent).toContain("▲");
    expect(delta?.textContent).toContain("+0.4pp");
    expect(delta?.getAttribute("data-tone")).toBe("error");
    const sparks = container.querySelectorAll("svg.cvb-stat-spark");
    expect(sparks.length).toBe(1);
    expect(sparks[0]?.querySelector("polyline")).not.toBeNull();
    expect(sparks[0]?.querySelector("circle")).not.toBeNull();
    // The plain tile renders neither affordance.
    const tiles = container.querySelectorAll(".cvb-stat");
    expect(tiles[1]?.querySelector(".cvb-stat-delta")).toBeNull();
    expect(tiles[1]?.querySelector(".cvb-stat-spark")).toBeNull();
  });

  test("a flat delta renders → and stays ink-colored without a tone", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "stats",
          items: [{ label: "Latency", value: "142ms", delta: { text: "±0", direction: "flat" } }],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const delta = container.querySelector(".cvb-stat-delta");
    expect(delta?.textContent).toContain("→");
    expect(delta?.hasAttribute("data-tone")).toBe(false);
  });

  test("a flat spark series renders a midline instead of dividing by zero", () => {
    const view = {
      view: "board",
      sections: [{ kind: "stats", items: [{ label: "Steady", value: 5, spark: [3, 3, 3] }] }],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const points = container.querySelector(".cvb-stat-spark polyline")?.getAttribute("points");
    expect(points).toBeTruthy();
    for (const pair of points!.split(" ")) {
      expect(Number(pair.split(",")[1])).toBe(9);
    }
  });
});

describe("seats and journey board sections", () => {
  test("seats render filled state, labels, decorative seats, and default tone", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "seats",
          items: [
            { label: "Navigator", tone: "id-blue", filled: true },
            {},
            { label: "Observer", filled: false },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const seats = container.querySelectorAll(".cvb-seat");
    expect(seats.length).toBe(3);
    expect(seats[0]?.getAttribute("data-filled")).toBe("true");
    expect(seats[1]?.hasAttribute("data-filled")).toBe(false);
    expect(seats[2]?.hasAttribute("data-filled")).toBe(false);
    expect(screen.getByLabelText("Navigator").getAttribute("title")).toBe("Navigator");
    expect(seats[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(seats[2]?.getAttribute("data-tone")).toBe("neutral");
  });

  test("journey renders numbered steps, titles, and optional text", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "journey",
          items: [
            { title: "Draft" },
            { title: "Review", text: "Waiting on maintainer" },
            { title: "Ship" },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    const steps = container.querySelectorAll(".cvb-journey-step");
    expect(steps.length).toBe(3);
    expect([...container.querySelectorAll(".cvb-journey-num")].map((n) => n.textContent)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect([...container.querySelectorAll(".cvb-journey-title")].map((n) => n.textContent)).toEqual(
      ["Draft", "Review", "Ship"],
    );
    expect(container.querySelector(".cvb-journey-text")?.textContent).toBe("Waiting on maintainer");
  });

  test("seats and journey nested inside columns render", () => {
    const view = {
      view: "board",
      sections: [
        {
          kind: "columns",
          columns: [
            { sections: [{ kind: "seats", items: [{ label: "A" }, {}] }] },
            { sections: [{ kind: "journey", items: [{ title: "One" }, { title: "Two" }] }] },
          ],
        },
      ],
    } as CanvasBoardView;
    const { container } = render(<BoardView view={view} />);
    expect(container.querySelectorAll(".cvb-seat").length).toBe(2);
    expect(container.querySelectorAll(".cvb-journey-step").length).toBe(2);
  });
});
