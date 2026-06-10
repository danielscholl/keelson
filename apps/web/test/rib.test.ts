import { describe, expect, test } from "bun:test";
import { ribAccent, ribAccentHue, visibleRuns } from "../src/lib/rib.ts";

describe("ribAccent", () => {
  test("hue is stable per id and in [0,360)", () => {
    const h = ribAccentHue("osdu");
    expect(h).toBe(ribAccentHue("osdu"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
    // Different ids should (almost always) differ; these two do.
    expect(ribAccentHue("osdu")).not.toBe(ribAccentHue("chamber"));
  });

  test("accent derives color/bg/border from the same hue", () => {
    const a = ribAccent("osdu");
    expect(a.color).toContain("hsl(");
    expect(a.bg).toContain("/ 0.12");
    expect(a.border).toContain("/ 0.35");
  });
});

describe("visibleRuns — per-rib hide for the runs feed", () => {
  const rows = [
    { runId: "a", ribId: null },
    { runId: "b", ribId: "osdu" },
    { runId: "c", ribId: "chamber" },
  ];

  test("keeps every row when nothing is hidden", () => {
    expect(visibleRuns(rows, () => false).map((r) => r.runId)).toEqual(["a", "b", "c"]);
  });

  test("drops rows whose rib is hidden, always keeping local (null ribId) runs", () => {
    const hidden = new Set(["osdu"]);
    expect(visibleRuns(rows, (id) => hidden.has(id)).map((r) => r.runId)).toEqual(["a", "c"]);
  });

  test("can hide multiple ribs at once", () => {
    const hidden = new Set(["osdu", "chamber"]);
    expect(visibleRuns(rows, (id) => hidden.has(id)).map((r) => r.runId)).toEqual(["a"]);
  });
});
