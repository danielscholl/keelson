// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";

import { describe, expect, test } from "bun:test";
import type { CommandInvokeResult, RibCommandDescriptor } from "@keelson/shared";
import { Hono } from "hono";
import { commandsRoutes } from "../src/commands-handler.ts";

const ORIGIN = "http://127.0.0.1:5173";

function makeApp(opts?: {
  listers?: Record<string, () => Promise<readonly RibCommandDescriptor[]>>;
  invokers?: Record<string, (name: string, arg: string) => Promise<CommandInvokeResult>>;
}): Hono {
  const app = new Hono();
  commandsRoutes(app, {
    commandListers: new Map(Object.entries(opts?.listers ?? {})),
    commandInvokers: new Map(Object.entries(opts?.invokers ?? {})),
    commandCompleters: new Map(),
  });
  return app;
}

function post(path: string, body: unknown, origin?: string): Request {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

describe("GET /api/commands", () => {
  test("lists a rib's commands namespaced by ribId", async () => {
    const app = makeApp({
      listers: { chamber: async () => [{ name: "mind", description: "Open a Mind" }] },
    });
    const res = await app.fetch(new Request("http://test/api/commands"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Array<{ name: string; ribId: string }> };
    expect(body.commands).toEqual([{ name: "mind", description: "Open a Mind", ribId: "chamber" }]);
  });

  test("drops a rib command whose name a surface reserves for a base command", async () => {
    const app = makeApp({
      listers: {
        chamber: async () => [
          { name: "run", description: "collides with the base /run" },
          { name: "genesis", description: "ok" },
        ],
      },
    });
    const res = await app.fetch(new Request("http://test/api/commands"));
    const body = (await res.json()) as { commands: Array<{ name: string }> };
    expect(body.commands.map((c) => c.name)).toEqual(["genesis"]);
  });
});

describe("POST /api/commands/:ribId/:name/invoke", () => {
  const invokers = {
    chamber: async (name: string, arg: string): Promise<CommandInvokeResult> =>
      name === "mind" && arg.length > 0
        ? { ok: true, effect: { effect: "open-agent", ribId: "chamber", slug: arg } }
        : { ok: false, error: "no slug" },
  };

  test("performs the invoke and returns the effect (no Origin = non-browser CLI)", async () => {
    const app = makeApp({ invokers });
    const res = await app.fetch(post("/api/commands/chamber/mind/invoke", { arg: "ada" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      effect: { effect: "open-agent", ribId: "chamber", slug: "ada" },
    });
  });

  test("allows a loopback Origin", async () => {
    const app = makeApp({ invokers });
    const res = await app.fetch(post("/api/commands/chamber/mind/invoke", { arg: "ada" }, ORIGIN));
    expect(res.status).toBe(200);
  });

  test("403 for a foreign Origin (CSRF guard)", async () => {
    const app = makeApp({ invokers });
    const res = await app.fetch(
      post("/api/commands/chamber/mind/invoke", { arg: "ada" }, "http://evil.example"),
    );
    expect(res.status).toBe(403);
  });

  test("404 for a rib that contributes no commands", async () => {
    const app = makeApp({ invokers });
    const res = await app.fetch(post("/api/commands/nope/mind/invoke", { arg: "ada" }));
    expect(res.status).toBe(404);
  });

  test("a rib-level failure is still a 200", async () => {
    const app = makeApp({ invokers });
    const res = await app.fetch(post("/api/commands/chamber/mind/invoke", { arg: "" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; error: string }).toEqual({
      ok: false,
      error: "no slug",
    });
  });
});
