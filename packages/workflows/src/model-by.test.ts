// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
  applyModelCase,
  isModelSelector,
  resolveModelSelector,
  selectModelCase,
} from "./model-by.ts";
import type { DagNode, ModelBy, NodeOutput } from "./schema/index.ts";

const outputs = (entries: Record<string, string>): ReadonlyMap<string, NodeOutput> =>
  new Map(Object.entries(entries).map(([id, output]) => [id, { state: "completed", output }]));

const MAP: ModelBy = {
  from: "$intake.output.tier",
  cases: {
    deep: { model_by_provider: { copilot: "gpt-6-astra" }, effort: "high" },
    std: { model: "balanced", effort: "low" },
  },
};

describe("resolveModelSelector", () => {
  test("reads a workflow input", () => {
    expect(resolveModelSelector("$inputs.tier", { tier: " deep " }, outputs({}))).toBe("deep");
  });

  test("reads a whole upstream output", () => {
    expect(resolveModelSelector("$intake.output", {}, outputs({ intake: "deep\n" }))).toBe("deep");
  });

  test("reads a JSON field of an upstream output", () => {
    const o = outputs({ intake: '{"tier":"std","score":4}' });
    expect(resolveModelSelector("$intake.output.tier", {}, o)).toBe("std");
    expect(resolveModelSelector("$intake.output.score", {}, o)).toBe("4");
  });

  test("a hyphenated node id resolves", () => {
    const o = outputs({ "pick-tier": '{"tier":"deep"}' });
    expect(resolveModelSelector("$pick-tier.output.tier", {}, o)).toBe("deep");
  });

  test("absent input, absent node, non-JSON body and missing field all read empty", () => {
    expect(resolveModelSelector("$inputs.nope", {}, outputs({}))).toBe("");
    expect(resolveModelSelector("$ghost.output", {}, outputs({}))).toBe("");
    expect(resolveModelSelector("$intake.output.tier", {}, outputs({ intake: "not json" }))).toBe(
      "",
    );
    expect(resolveModelSelector("$intake.output.tier", {}, outputs({ intake: "{}" }))).toBe("");
  });

  test("a prototype-named field is a miss, not an inherited member", () => {
    const o = outputs({ intake: '{"tier":"deep"}' });
    expect(resolveModelSelector("$intake.output.constructor", {}, o)).toBe("");
  });
});

describe("isModelSelector", () => {
  test.each([
    ["$inputs.tier", true],
    ["$intake.output", true],
    ["$intake.output.tier", true],
    ["$pick-tier.output.tier", true],
    ["intake.output.tier", false],
    ["$intake", false],
    ["$intake.result", false],
    ["deep", false],
    ["", false],
  ])("%s -> %s", (expr, expected) => {
    expect(isModelSelector(expr as string)).toBe(expected);
  });
});

describe("selectModelCase", () => {
  test("picks the matching case", () => {
    const r = selectModelCase(MAP, {}, outputs({ intake: '{"tier":"deep"}' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caseKey).toBe("deep");
    expect(r.selected.model_by_provider).toEqual({ copilot: "gpt-6-astra" });
  });

  test("an unmatched value fails rather than guessing a branch", () => {
    const r = selectModelCase(MAP, {}, outputs({ intake: '{"tier":"wat"}' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("'wat'");
    expect(r.error).toContain("deep, std");
  });

  test("an empty selector value fails and says so", () => {
    const r = selectModelCase(MAP, {}, outputs({}));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("an empty value");
  });

  test("a declared default absorbs an unmatched value", () => {
    const withDefault: ModelBy = { ...MAP, default: "std" };
    const r = selectModelCase(withDefault, {}, outputs({ intake: '{"tier":"wat"}' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caseKey).toBe("std");
  });

  test("a case key wins over the default when both could apply", () => {
    const withDefault: ModelBy = { ...MAP, default: "std" };
    const r = selectModelCase(withDefault, {}, outputs({ intake: '{"tier":"deep"}' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caseKey).toBe("deep");
  });
});

describe("applyModelCase", () => {
  const node = {
    id: "investigate",
    prompt: "go",
    model: "fast",
    effort: "none",
    model_by_provider: { copilot: "stale" },
  } as unknown as DagNode;

  test("the case's fields replace the node's static ones", () => {
    const out = applyModelCase(node, {
      model_by_provider: { copilot: "gpt-6-astra" },
      effort: "high",
    }) as unknown as Record<string, unknown>;
    expect(out.model_by_provider).toEqual({ copilot: "gpt-6-astra" });
    expect(out.effort).toBe("high");
    // Untouched by a case that sets no `model`.
    expect(out.model).toBe("fast");
  });

  test("an effort-only case leaves the model alone", () => {
    const out = applyModelCase(node, { effort: "xhigh" }) as unknown as Record<string, unknown>;
    expect(out.effort).toBe("xhigh");
    expect(out.model).toBe("fast");
    expect(out.model_by_provider).toEqual({ copilot: "stale" });
  });

  test("the original node is not mutated", () => {
    applyModelCase(node, { model: "deep", effort: "max" });
    expect((node as unknown as Record<string, unknown>).model).toBe("fast");
  });
});
