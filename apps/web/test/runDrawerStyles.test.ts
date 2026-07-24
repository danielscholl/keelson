// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// The run drawer's chrome is plain CSS with no runtime assertion behind it, so
// these guard the three ways it can silently break: unstyled buttons (the
// `.btn` base lives behind a selector group the drawer must be listed in), a
// stacking order that leaves it clickable under the canvas it opened, and a
// header that overflows its own close button on a phone.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/app.css"), "utf8");

function block(selector: string): string {
  const i = css.indexOf(`${selector} {`);
  if (i === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(i, css.indexOf("}", i));
}

function zIndexOf(selector: string): number {
  const m = /z-index:\s*(\d+)/.exec(block(selector));
  if (!m) throw new Error(`${selector} declares no z-index`);
  return Number(m[1]);
}

// The `.btn` base is scoped to a selector group; a container not in that group
// renders browser-default buttons with no danger/primary states.
function selectorGroupBefore(declaration: string): string {
  const i = css.indexOf(declaration);
  if (i === -1) throw new Error(`no rule declaring ${declaration}`);
  const start = css.lastIndexOf("}", i);
  return css.slice(start + 1, i);
}

describe("run drawer styles", () => {
  test("its header and body are inside the workflow .btn base", () => {
    const base = selectorGroupBefore("padding: 5px 14px; border-radius: 6px;");
    expect(base).toContain(".run-drawer-meta .btn");
    expect(base).toContain(".run-drawer-body .btn");
  });

  test("the approval composer's primary button is styled in the drawer body", () => {
    const primary = selectorGroupBefore(
      "background: var(--accent); border-color: var(--accent); color: white; font-weight: 600;",
    );
    expect(primary).toContain(".run-drawer-body .btn.primary");
  });

  test("it stacks below the canvas it can open over itself", () => {
    // The canvas is width-capped, so an equal z-index would leave the drawer's
    // uncovered strip above the canvas backdrop and still clickable.
    expect(zIndexOf(".run-drawer")).toBeLessThan(zIndexOf(".canvas-backdrop"));
    expect(zIndexOf(".run-drawer-backdrop")).toBeLessThan(zIndexOf(".run-drawer"));
  });

  test("its header controls wrap instead of overflowing a narrow drawer", () => {
    expect(block(".run-drawer-header")).toContain("flex-wrap: wrap");
    expect(block(".run-drawer-meta")).toContain("flex-wrap: wrap");
    // A non-shrinking meta row is what pushes the close button off-screen.
    expect(block(".run-drawer-meta")).not.toContain("flex-shrink: 0");
  });
});
