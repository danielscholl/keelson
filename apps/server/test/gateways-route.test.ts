// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "@keelson/shared/config";
import { gatewayCredentialServiceId, loadKeelsonConfig } from "@keelson/shared/config";
import { Hono } from "hono";
import type { CredentialStore } from "../src/credentials.ts";
import { gatewaysRoutes } from "../src/gateways-handler.ts";

function makeFakeStore(): CredentialStore {
  const map = new Map<string, string>();
  return {
    async get(id) {
      return map.get(id);
    },
    async set(id, value) {
      map.set(id, value);
    },
    async delete(id) {
      return map.delete(id);
    },
  };
}

interface Rig {
  app: Hono;
  store: CredentialStore;
  home: string;
  upserted: GatewayConfig[];
  removed: string[];
}

let home: string;
const envBefore = process.env.KEELSON_CONFIG;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keelson-gwroute-"));
  // The writer honors KEELSON_CONFIG over the home arg; clear it so the test's
  // temp home is authoritative and we never touch a developer's real config.
  delete process.env.KEELSON_CONFIG;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
  else process.env.KEELSON_CONFIG = envBefore;
});

function makeRig(): Rig {
  const store = makeFakeStore();
  const upserted: GatewayConfig[] = [];
  const removed: string[] = [];
  const app = new Hono();
  gatewaysRoutes(app, store, {
    home,
    onGatewayUpserted: (gw) => upserted.push(gw),
    onGatewayRemoved: (name) => removed.push(name),
  });
  return { app, store, home, upserted, removed };
}

function put(app: Hono, name: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://test/api/gateways/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/gateways", () => {
  test("empty when none are configured", async () => {
    const { app } = makeRig();
    const res = await app.fetch(new Request("http://test/api/gateways"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gateways: [] });
  });

  test("reports signedIn per stored key", async () => {
    const { app, store } = makeRig();
    await put(app, "ollama", { baseUrl: "http://localhost:11434/v1", model: "qwen3:latest" });
    await put(app, "router", { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-1" });
    void store;
    const res = await app.fetch(new Request("http://test/api/gateways"));
    const body = (await res.json()) as { gateways: Array<{ name: string; signedIn: boolean }> };
    const byName = Object.fromEntries(body.gateways.map((g) => [g.name, g.signedIn]));
    expect(byName).toEqual({ ollama: false, router: true });
  });
});

describe("PUT /api/gateways/:name", () => {
  test("persists config + key, registers, and returns the summary", async () => {
    const { app, store, upserted } = makeRig();
    const res = await put(app, "router", {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o",
      apiKey: "sk-secret",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "router",
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai",
      model: "openai/gpt-4o",
      signedIn: true,
    });
    // Config persisted (non-secret) + key in the store (secret).
    expect(loadKeelsonConfig(home).gateways).toEqual([
      {
        name: "router",
        baseUrl: "https://openrouter.ai/api/v1",
        protocol: "openai",
        model: "openai/gpt-4o",
      },
    ]);
    expect(await store.get(gatewayCredentialServiceId("router"))).toBe("sk-secret");
    expect(upserted.map((g) => g.name)).toEqual(["router"]);
  });

  test("an update without apiKey keeps the stored key", async () => {
    const { app, store } = makeRig();
    await put(app, "g", { baseUrl: "http://a/v1", apiKey: "sk-1" });
    const res = await put(app, "g", { baseUrl: "http://b/v1", model: "m2" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signedIn: boolean }).signedIn).toBe(true);
    expect(await store.get(gatewayCredentialServiceId("g"))).toBe("sk-1");
    // The edit replaced the metadata, not duplicated it.
    expect(loadKeelsonConfig(home).gateways).toEqual([
      { name: "g", baseUrl: "http://b/v1", protocol: "openai", model: "m2" },
    ]);
  });

  test("400 on a reserved name", async () => {
    const { app, upserted } = makeRig();
    const res = await put(app, "claude", { baseUrl: "http://a/v1" });
    expect(res.status).toBe(400);
    expect(upserted).toHaveLength(0);
  });

  test("400 on an invalid baseUrl", async () => {
    const { app } = makeRig();
    expect((await put(app, "g", { baseUrl: "not-a-url" })).status).toBe(400);
  });

  test("the API key never appears in the response body", async () => {
    const { app } = makeRig();
    const res = await put(app, "g", { baseUrl: "http://a/v1", apiKey: "k9-sentinel-token" });
    expect(await res.text()).not.toContain("k9-sentinel-token");
  });
});

describe("DELETE /api/gateways/:name", () => {
  test("removes config + key, unregisters, idempotent", async () => {
    const { app, store, removed } = makeRig();
    await put(app, "g", { baseUrl: "http://a/v1", apiKey: "sk-1" });
    const res = await app.fetch(new Request("http://test/api/gateways/g", { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(loadKeelsonConfig(home).gateways).toBeUndefined();
    expect(await store.get(gatewayCredentialServiceId("g"))).toBeUndefined();
    expect(removed).toEqual(["g"]);
    // Idempotent: deleting again still 204.
    const again = await app.fetch(new Request("http://test/api/gateways/g", { method: "DELETE" }));
    expect(again.status).toBe(204);
  });
});

describe("cross-origin guard", () => {
  test("PUT from a disallowed origin is rejected before any write", async () => {
    const { app, store, upserted } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/gateways/g", {
        method: "PUT",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ baseUrl: "http://a/v1", apiKey: "pwn" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(loadKeelsonConfig(home).gateways).toBeUndefined();
    expect(await store.get(gatewayCredentialServiceId("g"))).toBeUndefined();
    expect(upserted).toHaveLength(0);
  });

  test("DELETE from a disallowed origin is rejected", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/gateways/g", {
        method: "DELETE",
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });
});
