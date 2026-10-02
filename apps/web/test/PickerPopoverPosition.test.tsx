// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickerPopoverPosition } from "../src/lib/pickerPopoverPosition.ts";

describe("pickerPopoverPosition", () => {
  test("aligns a fitting trigger to its left edge", () => {
    expect(pickerPopoverPosition({ left: 32, right: 159, width: 127 }, 1024, 320)).toEqual({
      left: "32px",
      right: "auto",
      minWidth: "320px",
    });
  });

  test("aligns a right-edge trigger to its right edge at both desktop widths", () => {
    expect(pickerPopoverPosition({ left: 1449, right: 1576, width: 127 }, 1600, 320)).toEqual({
      left: "auto",
      right: "24px",
      minWidth: "320px",
    });
    expect(pickerPopoverPosition({ left: 873, right: 1000, width: 127 }, 1024, 280)).toEqual({
      left: "auto",
      right: "24px",
      minWidth: "280px",
    });
  });

  test("picker CSS keeps the 460px maximum and two 6px viewport gutters", () => {
    const css = readFileSync(join(import.meta.dir, "../src/app.css"), "utf8");
    const rule = css.match(/\.model-picker-popover \{([^}]+)\}/)?.[1];
    expect(rule).toContain("width: max-content;");
    expect(rule).toContain("max-width: min(460px, calc(100vw - 12px));");
  });

  test("switches alignment only once the maximum-width panel no longer fits", () => {
    expect(pickerPopoverPosition({ left: 558, right: 658, width: 100 }, 1024, 280)).toEqual({
      left: "558px",
      right: "auto",
      minWidth: "280px",
    });
    expect(pickerPopoverPosition({ left: 559, right: 659, width: 100 }, 1024, 280)).toEqual({
      left: "auto",
      right: "365px",
      minWidth: "280px",
    });
  });

  test("clamps either edge and caps the minimum width to the viewport", () => {
    expect(pickerPopoverPosition({ left: -20, right: 107, width: 127 }, 1024, 320)).toEqual({
      left: "6px",
      right: "auto",
      minWidth: "320px",
    });
    expect(pickerPopoverPosition({ left: 1000, right: 1200, width: 200 }, 1024, 280)).toEqual({
      left: "auto",
      right: "6px",
      minWidth: "280px",
    });
    expect(pickerPopoverPosition({ left: 370, right: 870, width: 500 }, 375, 320)).toEqual({
      left: "auto",
      right: "6px",
      minWidth: "363px",
    });
    expect(pickerPopoverPosition({ left: 0, right: 20, width: 20 }, 8, 280)).toEqual({
      left: "auto",
      right: "6px",
      minWidth: "0px",
    });
  });
});
