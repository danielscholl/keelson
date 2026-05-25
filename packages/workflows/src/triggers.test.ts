// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { DagNode, NodeOutput, TriggerRule } from "./schema/index.ts";
import { checkTriggerRule } from "./triggers.ts";

function completed(): NodeOutput {
  return { state: "completed", output: "ok" };
}
function failed(): NodeOutput {
  return { state: "failed", output: "", error: "boom" };
}
function skipped(): NodeOutput {
  return { state: "skipped", output: "" };
}
function pending(): NodeOutput {
  return { state: "pending", output: "" };
}

function makeNode(opts: { depends_on?: string[]; trigger_rule?: TriggerRule }): DagNode {
  return {
    id: "n",
    prompt: "test",
    ...opts,
  } as DagNode;
}

describe("checkTriggerRule — defaults", () => {
  test("no dependencies → run", () => {
    expect(checkTriggerRule(makeNode({}), new Map())).toBe("run");
  });

  test("default rule is all_success", () => {
    const node = makeNode({ depends_on: ["a"] });
    expect(checkTriggerRule(node, new Map([["a", completed()]]))).toBe("run");
    expect(checkTriggerRule(node, new Map([["a", failed()]]))).toBe("skip");
  });
});

describe("checkTriggerRule — all_success", () => {
  test("all upstreams completed → run", () => {
    const node = makeNode({ depends_on: ["a", "b"], trigger_rule: "all_success" });
    const outputs = new Map([
      ["a", completed()],
      ["b", completed()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("run");
  });

  test("any upstream failed → skip", () => {
    const node = makeNode({ depends_on: ["a", "b"], trigger_rule: "all_success" });
    const outputs = new Map([
      ["a", completed()],
      ["b", failed()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("skip");
  });

  test("any upstream skipped → skip", () => {
    const node = makeNode({ depends_on: ["a", "b"], trigger_rule: "all_success" });
    const outputs = new Map([
      ["a", completed()],
      ["b", skipped()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("skip");
  });
});

describe("checkTriggerRule — one_success", () => {
  test("at least one completed → run", () => {
    const node = makeNode({ depends_on: ["a", "b"], trigger_rule: "one_success" });
    const outputs = new Map([
      ["a", failed()],
      ["b", completed()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("run");
  });

  test("none completed → skip", () => {
    const node = makeNode({ depends_on: ["a", "b"], trigger_rule: "one_success" });
    const outputs = new Map([
      ["a", failed()],
      ["b", failed()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("skip");
  });
});

describe("checkTriggerRule — none_failed_min_one_success", () => {
  test("no failures + at least one success → run", () => {
    const node = makeNode({
      depends_on: ["a", "b", "c"],
      trigger_rule: "none_failed_min_one_success",
    });
    const outputs = new Map([
      ["a", completed()],
      ["b", skipped()],
      ["c", skipped()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("run");
  });

  test("any failure → skip", () => {
    const node = makeNode({
      depends_on: ["a", "b"],
      trigger_rule: "none_failed_min_one_success",
    });
    const outputs = new Map([
      ["a", completed()],
      ["b", failed()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("skip");
  });

  test("all skipped (no failure but no success) → skip", () => {
    const node = makeNode({
      depends_on: ["a", "b"],
      trigger_rule: "none_failed_min_one_success",
    });
    const outputs = new Map([
      ["a", skipped()],
      ["b", skipped()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("skip");
  });
});

describe("checkTriggerRule — all_done", () => {
  test("every upstream is in a terminal state → run (mixed states)", () => {
    const node = makeNode({ depends_on: ["a", "b", "c"], trigger_rule: "all_done" });
    const outputs = new Map([
      ["a", completed()],
      ["b", failed()],
      ["c", skipped()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("run");
  });

  test("any pending → skip", () => {
    const node = makeNode({ depends_on: ["a", "b"], trigger_rule: "all_done" });
    const outputs = new Map([
      ["a", completed()],
      ["b", pending()],
    ]);
    expect(checkTriggerRule(node, outputs)).toBe("skip");
  });
});

describe("checkTriggerRule — missing upstreams", () => {
  test("upstream not in map is treated as failed", () => {
    const node = makeNode({ depends_on: ["missing"], trigger_rule: "all_success" });
    expect(checkTriggerRule(node, new Map())).toBe("skip");
  });

  test("missing upstream + one_success with another success still runs", () => {
    const node = makeNode({
      depends_on: ["missing", "ok"],
      trigger_rule: "one_success",
    });
    const outputs = new Map([["ok", completed()]]);
    expect(checkTriggerRule(node, outputs)).toBe("run");
  });
});
