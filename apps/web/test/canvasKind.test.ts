import { describe, expect, test } from "bun:test";
import type { RibSummary } from "@keelson/shared";
import { canvasKindForKey } from "../src/lib/canvasKind.ts";

function ribWithViews(views: RibSummary["views"]): RibSummary {
  return {
    id: "demo",
    displayName: "Demo",
    registered: [],
    views,
    surfaces: [],
    hasOnAction: false,
  };
}

describe("canvasKindForKey", () => {
  test("returns html for an html-declared key", () => {
    const ribs = [ribWithViews([{ key: "rib:demo:html", canvasKind: "html" }])];
    expect(canvasKindForKey(ribs, "rib:demo:html")).toBe("html");
  });

  test("returns view for a view-declared key", () => {
    const ribs = [ribWithViews([{ key: "rib:demo:view", canvasKind: "view" }])];
    expect(canvasKindForKey(ribs, "rib:demo:view")).toBe("view");
  });

  test("defaults to view for unknown keys", () => {
    const ribs = [ribWithViews([{ key: "rib:demo:html", canvasKind: "html" }])];
    expect(canvasKindForKey(ribs, "rib:demo:missing")).toBe("view");
  });

  test("defaults to view with no ribs", () => {
    expect(canvasKindForKey([], "rib:demo:any")).toBe("view");
  });
});
