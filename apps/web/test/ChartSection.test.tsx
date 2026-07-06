import { describe, expect, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { fireEvent, render } from "@testing-library/react";
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
});
