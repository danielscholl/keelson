import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandCallBlock } from "../src/components/Chat/CommandCallBlock.tsx";

const OPEN_LABEL = "Open in Workflows →";

describe("CommandCallBlock — workflow run link", () => {
  test("renders an Open button that fires onOpenRun with workflowName + runId", () => {
    const calls: Array<[string, string]> = [];
    render(
      <CommandCallBlock
        commandCall={{
          command: "workflow",
          args: "run smoke-test",
          family: "workflow",
          result: {
            ok: true,
            message: "Started smoke-test — run r1",
            runId: "r1",
            workflowName: "smoke-test",
          },
        }}
        onOpenRun={(workflowName, runId) => calls.push([workflowName, runId])}
      />,
    );
    fireEvent.click(screen.getByText(OPEN_LABEL));
    expect(calls).toEqual([["smoke-test", "r1"]]);
  });

  test("omits the Open button when the result carries no run id (list output)", () => {
    render(
      <CommandCallBlock
        commandCall={{
          command: "workflow",
          args: "",
          family: "workflow",
          result: { ok: true, message: "Workflows:\n  smoke-test" },
        }}
        onOpenRun={() => {}}
      />,
    );
    expect(screen.queryByText(OPEN_LABEL)).toBeNull();
  });

  test("omits the Open button when the run failed", () => {
    render(
      <CommandCallBlock
        commandCall={{
          command: "workflow",
          args: "run nope",
          family: "workflow",
          result: { ok: false, message: "Couldn't start nope: unknown workflow 'nope'" },
        }}
        onOpenRun={() => {}}
      />,
    );
    expect(screen.queryByText(OPEN_LABEL)).toBeNull();
  });
});
