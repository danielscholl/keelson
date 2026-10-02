import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/app.css"), "utf8");

describe("side canvas styles", () => {
  test("docks a 520px overlay to the right without the centered width cap", () => {
    const side = /\.canvas-drawer-side\s*\{([^}]+)\}/.exec(css)?.[1];
    expect(side).toBeDefined();
    expect(side).toContain("left: auto;");
    expect(side).toContain("right: 0;");
    expect(side).toContain("width: 520px;");
    expect(side).toContain("max-width: 100%;");
    expect(side).toContain("margin-inline: 0;");
    expect(side).toContain("border-inline-end: none;");
  });

  test("fills viewports below 720px", () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*720px\)\s*\{\s*\.canvas-drawer-side\s*\{\s*width:\s*100%;/,
    );
  });

  test("stacks board columns and scopes container layout to the side body", () => {
    expect(css).toMatch(/\.canvas-drawer-side \.cvb-columns\s*\{\s*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(
      /\.canvas-drawer-side \.canvas-drawer-body\s*\{\s*container-type:\s*inline-size;/,
    );
  });
});
