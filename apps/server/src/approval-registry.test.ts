// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import type { ApprovalRequest } from "@keelson/shared";
import { createApprovalRegistry } from "./approval-registry.ts";

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  surface: "chat",
  policyId: "builtin:ask_on_shell",
  reason: "confirm shell",
  ...over,
});

describe("createApprovalRegistry", () => {
  it("resolves the request promise with the human's decision", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const pending = registry.request(req());
    const [open] = registry.list();
    expect(open).toBeDefined();
    expect(registry.resolve(open!.id, "accept")).toBe(true);
    expect(await pending).toBe("accept");
    expect(registry.list()).toEqual([]);
  });

  it("a reject resolves the promise with reject and clears the entry", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const pending = registry.request(req());
    const id = registry.list()[0]!.id;
    registry.resolve(id, "reject");
    expect(await pending).toBe("reject");
    expect(registry.list()).toEqual([]);
  });

  it("surfaces a redacted view — id + createdAt, never tool args", () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    void registry.request(req({ tool: "shell_exec", ribId: "chamber", provider: "copilot" }));
    const [view] = registry.list();
    expect(view).toMatchObject({
      surface: "chat",
      policyId: "builtin:ask_on_shell",
      reason: "confirm shell",
      tool: "shell_exec",
      ribId: "chamber",
      provider: "copilot",
    });
    expect(typeof view!.id).toBe("string");
    expect(Number.isNaN(Date.parse(view!.createdAt))).toBe(false);
    expect(view as Record<string, unknown>).not.toHaveProperty("args");
  });

  it("returns false when resolving an unknown or already-settled id", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    expect(registry.resolve("nope", "accept")).toBe(false);
    const pending = registry.request(req());
    const id = registry.list()[0]!.id;
    expect(registry.resolve(id, "accept")).toBe(true);
    await pending;
    // Second resolve of the same id no-ops — defends against a double-click.
    expect(registry.resolve(id, "reject")).toBe(false);
  });

  it("auto-rejects an unanswered approval once the timeout elapses", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 5 });
    const pending = registry.request(req());
    expect(registry.list()).toHaveLength(1);
    expect(await pending).toBe("reject");
    expect(registry.list()).toEqual([]);
  });

  it("rejects when the turn's abort signal fires", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const ac = new AbortController();
    const pending = registry.request(req(), ac.signal);
    expect(registry.list()).toHaveLength(1);
    ac.abort();
    expect(await pending).toBe("reject");
    expect(registry.list()).toEqual([]);
  });

  it("denies immediately for an already-aborted signal without surfacing a prompt", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const ac = new AbortController();
    ac.abort();
    const pending = registry.request(req(), ac.signal);
    expect(registry.list()).toEqual([]);
    expect(await pending).toBe("reject");
  });

  it("fires onChange on open and on settle", async () => {
    let changes = 0;
    const registry = createApprovalRegistry({ timeoutMs: 0, onChange: () => changes++ });
    const pending = registry.request(req());
    expect(changes).toBe(1);
    registry.resolve(registry.list()[0]!.id, "accept");
    await pending;
    expect(changes).toBe(2);
  });

  it("clear() rejects every open approval", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const a = registry.request(req({ tool: "a" }));
    const b = registry.request(req({ tool: "b" }));
    expect(registry.list()).toHaveLength(2);
    registry.clear();
    expect(await a).toBe("reject");
    expect(await b).toBe("reject");
    expect(registry.list()).toEqual([]);
  });

  it("keeps concurrent approvals independent", async () => {
    const registry = createApprovalRegistry({ timeoutMs: 0 });
    const a = registry.request(req({ tool: "a" }));
    const b = registry.request(req({ tool: "b" }));
    const [first, second] = registry.list();
    expect(first!.id).not.toBe(second!.id);
    registry.resolve(first!.id, "accept");
    expect(await a).toBe("accept");
    // b is still pending until resolved.
    expect(registry.list().map((v) => v.tool)).toEqual(["b"]);
    registry.resolve(second!.id, "reject");
    expect(await b).toBe("reject");
  });
});
