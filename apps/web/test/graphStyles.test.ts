import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canvasToneSchema } from "@keelson/shared";

const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");

describe("board graph styles", () => {
  test("uses shrinkable tracks and stacks narrow graphs", () => {
    expect(css).toContain("grid-template-columns: repeat(var(--cvb-graph-cols), minmax(0, 1fr));");
    expect(css).toMatch(
      /\.cvb-graph\[data-narrow\] \.cvb-graph-columns\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(css).toMatch(/\.cvb-graph-label\s*\{[^}]*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.cvb-graph-badges\s*\{[^}]*flex-wrap: wrap;/);
  });

  test("maps every supported graph tone to an existing theme token", () => {
    for (const tone of canvasToneSchema.options) {
      const rule = new RegExp(
        `:is\\(\\.cvb-graph-node, \\.cvb-graph-edge, \\.view-graph-node\\)\\[data-tone="${tone}"\\] \\{ --g-tone: var\\((--[\\w-]+)\\); \\}`,
      );
      const token = rule.exec(css)?.[1];
      expect(token).toBeDefined();
      expect(css).toContain(`${token}:`);
    }
    expect(css).toMatch(
      /\.view-graph-node\s*\{[^}]*border-left: 3px solid var\(--g-tone, var\(--accent\)\);/,
    );
  });

  test("dims chains, dashes edges and respects reduced motion", () => {
    expect(css).toMatch(/\[data-dim\]\s*\{\s*opacity: 0\.28;/);
    expect(css).toMatch(/\.cvb-graph-edge\[data-dashed\]\s*\{\s*stroke-dasharray: 4 4;/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.cvb-graph-node,\s*\.cvb-graph-edge \{\s*transition: none;/,
    );
  });
});
