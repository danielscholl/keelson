// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, mock, test } from "bun:test";
import type { PendingApprovalView } from "@keelson/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApprovalPrompt } from "../src/components/ApprovalsDock.tsx";

const view = (over: Partial<PendingApprovalView> = {}): PendingApprovalView => ({
  id: "a1",
  surface: "chat",
  policyId: "builtin:ask_on_shell",
  reason: "'Bash' runs shell or file-mutating actions",
  tool: "Bash",
  createdAt: "2026-06-20T00:00:00.000Z",
  ...over,
});

describe("ApprovalPrompt", () => {
  test("renders nothing when there are no pending approvals", () => {
    const { container } = render(
      <ApprovalPrompt approvals={[]} busyIds={new Set()} onResolve={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders a card per approval with its reason, surface, and tool", () => {
    render(
      <ApprovalPrompt
        approvals={[view(), view({ id: "a2", surface: "rib", tool: "Write", reason: "edit file" })]}
        busyIds={new Set()}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText("'Bash' runs shell or file-mutating actions")).toBeDefined();
    expect(screen.getByText("edit file")).toBeDefined();
    expect(screen.getByText("chat · Bash")).toBeDefined();
    expect(screen.getByText("rib · Write")).toBeDefined();
    expect(screen.getAllByRole("button", { name: /Accept/ })).toHaveLength(2);
  });

  test("Accept and Reject call onResolve with the id and decision", () => {
    const onResolve = mock((_id: string, _d: "accept" | "reject") => {});
    render(<ApprovalPrompt approvals={[view()]} busyIds={new Set()} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    expect(onResolve).toHaveBeenLastCalledWith("a1", "accept");
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onResolve).toHaveBeenLastCalledWith("a1", "reject");
  });

  test("disables both buttons for an in-flight (busy) approval", () => {
    render(<ApprovalPrompt approvals={[view()]} busyIds={new Set(["a1"])} onResolve={() => {}} />);
    expect((screen.getByRole("button", { name: /Accept/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /Reject/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("omits the tool suffix when the approval carries no tool", () => {
    render(
      <ApprovalPrompt
        approvals={[view({ tool: undefined })]}
        busyIds={new Set()}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText("chat")).toBeDefined();
  });
});
