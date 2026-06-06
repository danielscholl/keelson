import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Rib, RibContext } from "@keelson/shared";
import { applyRibs } from "../src/ribs.ts";

const ctx: RibContext = {
  getExec: () => ({
    runJSON: async <T>() => ({ ok: true as const, data: undefined as T }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
};

// A one-panel surface plus an optional bound producer, to exercise the
// activation-time cadence/workflow cross-check in applyRibs.
function demoRib(opts: {
  regionWorkflow?: string;
  regionCadenceMs?: number;
  producerName?: string;
  bindKey?: string;
}): Rib {
  const column = {
    key: "rib:demo:panel",
    ...(opts.regionWorkflow ? { workflow: opts.regionWorkflow } : {}),
    ...(opts.regionCadenceMs ? { cadenceMs: opts.regionCadenceMs } : {}),
  };
  return {
    id: "demo",
    displayName: "Demo",
    surfaces: [{ id: "s", title: "S", layout: { rows: [{ columns: [column] }] } }],
    ...(opts.producerName
      ? {
          contributeWorkflows: () => [
            {
              definition: { name: opts.producerName, nodes: [] },
              ...(opts.bindKey ? { bindSnapshotKey: opts.bindKey } : {}),
            },
          ],
        }
      : {}),
  };
}

let warnings: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.warn = realWarn;
});

function activate(rib: Rib) {
  return applyRibs({ active: ["demo"], available: { demo: rib }, ctx });
}

const cadenceWarn = () => warnings.filter((w) => w.includes("sets cadenceMs"));

describe("applyRibs — cadence/workflow cross-check", () => {
  test("no warning when the cadence workflow is a producer bound to the region key", () => {
    activate(
      demoRib({
        regionWorkflow: "demo-panel",
        regionCadenceMs: 600_000,
        producerName: "demo-panel",
        bindKey: "rib:demo:panel",
      }),
    );
    expect(cadenceWarn()).toEqual([]);
  });

  test("warns when cadenceMs points at a workflow this rib doesn't contribute", () => {
    activate(
      demoRib({
        regionWorkflow: "demo-typo",
        regionCadenceMs: 600_000,
        producerName: "demo-panel",
        bindKey: "rib:demo:panel",
      }),
    );
    expect(cadenceWarn()).toHaveLength(1);
    expect(cadenceWarn()[0]).toContain("rib:demo:panel");
    expect(cadenceWarn()[0]).toContain("demo-typo");
  });

  test("warns when the producer binds a different key than the region", () => {
    activate(
      demoRib({
        regionWorkflow: "demo-panel",
        regionCadenceMs: 600_000,
        producerName: "demo-panel",
        bindKey: "rib:demo:other",
      }),
    );
    expect(cadenceWarn()).toHaveLength(1);
  });

  test("warns when cadenceMs is set but the region has no workflow", () => {
    activate(demoRib({ regionCadenceMs: 600_000 }));
    expect(cadenceWarn()).toHaveLength(1);
    expect(cadenceWarn()[0]).toContain("(none)");
  });

  test("no warning when a region declares no cadence", () => {
    activate(
      demoRib({
        regionWorkflow: "demo-panel",
        producerName: "demo-panel",
        bindKey: "rib:demo:panel",
      }),
    );
    expect(cadenceWarn()).toEqual([]);
  });
});
