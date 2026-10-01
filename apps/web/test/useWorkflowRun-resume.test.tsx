// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import { type UseWorkflowRunResult, useWorkflowRun } from "../src/hooks/useWorkflowRun.ts";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.onclose?.();
  }
}

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

let latest: UseWorkflowRunResult | null = null;
function Probe() {
  latest = useWorkflowRun("run-1");
  return null;
}

function snapshot(status: string, definitionHash: string) {
  return {
    run: {
      runId: "run-1",
      workflowName: "rehash",
      status,
      startedAt: "2026-09-30T00:00:00.000Z",
      completedAt: null,
      error: null,
      conversationId: null,
      projectId: null,
      workingDir: "/repo",
      worktreePath: null,
      inputs: {},
      nodes: [],
      definitionHash,
    },
  };
}

describe("useWorkflowRun resumeRun", () => {
  let resumed = false;
  beforeEach(() => {
    FakeSocket.instances = [];
    latest = null;
    resumed = false;
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/resume-run") && init?.method === "POST") {
        resumed = true;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/api/workflows/runs/run-1")) {
        return Response.json(
          resumed ? snapshot("running", "b".repeat(64)) : snapshot("failed", "a".repeat(64)),
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
  });

  test("reopens the parked stream so the re-stamped definition hash reaches the view", async () => {
    render(<Probe />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const first = FakeSocket.instances[0]!;
    act(() => first.onopen?.());
    await waitFor(() => expect(latest?.run.definitionHash).toBe("a".repeat(64)));

    // Terminal frame parks reconnection: the server's close must not reopen.
    act(() => first.onmessage?.({ data: JSON.stringify({ type: "run_done", status: "failed" }) }));
    act(() => first.onclose?.());
    await waitFor(() => expect(latest?.run.status).toBe("failed"));
    expect(FakeSocket.instances).toHaveLength(1);

    await act(async () => {
      await latest?.resumeRun();
    });
    expect(resumed).toBe(true);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    act(() => FakeSocket.instances[1]?.onopen?.());
    await waitFor(() => expect(latest?.run.definitionHash).toBe("b".repeat(64)));
    expect(latest?.run.status).toBe("running");
  });
});
