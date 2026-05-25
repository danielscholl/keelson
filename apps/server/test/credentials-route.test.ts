// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type {
  ClaudeAuthProbe,
  CopilotAuthProbe,
} from "@keelson/providers";
import { credentialsRoutes } from "../src/credentials-handler.ts";
import type { CredentialStore } from "../src/credentials.ts";

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

interface TestRig {
  app: Hono;
  store: CredentialStore;
}

interface RigOptions {
  copilotAuthProbe?: CopilotAuthProbe;
  claudeAuthProbe?: ClaudeAuthProbe;
  cwd?: () => string;
}

function makeRig(opts: RigOptions = {}): TestRig {
  const store = makeFakeStore();
  const app = new Hono();
  credentialsRoutes(app, store, {
    ...(opts.copilotAuthProbe ? { copilotAuthProbe: opts.copilotAuthProbe } : {}),
    ...(opts.claudeAuthProbe ? { claudeAuthProbe: opts.claudeAuthProbe } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  return { app, store };
}

describe("POST /api/credentials/:serviceId", () => {
  test("204 on success and store contains the value", async () => {
    const { app, store } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "tok-abc" }),
      }),
    );
    expect(res.status).toBe(204);
    expect(await store.get("copilot")).toBe("tok-abc");
  });

  test("400 on missing body", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 on empty value", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 on invalid serviceId (path traversal shape)", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/..%2Fetc%2Fpasswd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 on invalid serviceId (uppercase)", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/Copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/credentials/:serviceId", () => {
  test("204 when entry existed", async () => {
    const { app, store } = makeRig();
    await store.set("copilot", "tok");
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", { method: "DELETE" }),
    );
    expect(res.status).toBe(204);
    expect(await store.get("copilot")).toBeUndefined();
  });

  test("204 when entry did not exist (idempotent)", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", { method: "DELETE" }),
    );
    expect(res.status).toBe(204);
  });

  test("400 on invalid serviceId", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/BadId", { method: "DELETE" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/credentials/:serviceId/status", () => {
  test("returns signedIn: true after set", async () => {
    const { app, store } = makeRig();
    await store.set("copilot", "tok");
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot/status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true });
  });

  test("returns signedIn: false for unset", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot/status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });

  test("400 on invalid serviceId", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/BadId/status"),
    );
    expect(res.status).toBe(400);
  });
});

describe("cross-origin guard", () => {
  test("POST from a disallowed origin is rejected with 403", async () => {
    const { app, store } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example",
        },
        body: JSON.stringify({ value: "pwn" }),
      }),
    );
    expect(res.status).toBe(403);
    // Most important: the rejection must happen before the store is written.
    expect(await store.get("copilot")).toBeUndefined();
  });

  test("DELETE from a disallowed origin is rejected with 403", async () => {
    const { app, store } = makeRig();
    await store.set("copilot", "real");
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "DELETE",
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await store.get("copilot")).toBe("real");
  });

  test("GET status from a disallowed origin is rejected with 403", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot/status", {
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("POST from an allowed dev origin succeeds", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({ value: "tok" }),
      }),
    );
    expect(res.status).toBe(204);
  });

  test("POST without an Origin header is allowed (CLI / scripts)", async () => {
    const { app } = makeRig();
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "tok" }),
      }),
    );
    expect(res.status).toBe(204);
  });
});

describe("GET /api/credentials/copilot/cli-status", () => {
  test("returns probe result with login + authType", async () => {
    let receivedCwd: string | undefined;
    const probe: CopilotAuthProbe = async (cwd) => {
      receivedCwd = cwd;
      return {
        isAuthenticated: true,
        authType: "user",
        login: "octocat",
        host: "github.com",
      };
    };
    const { app } = makeRig({ copilotAuthProbe: probe, cwd: () => "/fake/cwd" });
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot/cli-status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      authType: "user",
      login: "octocat",
      host: "github.com",
    });
    expect(receivedCwd).toBe("/fake/cwd");
  });

  test("returns authenticated:false with statusMessage when probe says unauthenticated", async () => {
    const probe: CopilotAuthProbe = async () => ({
      isAuthenticated: false,
      statusMessage: "no auth configured",
    });
    const { app } = makeRig({ copilotAuthProbe: probe });
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot/cli-status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: false,
      statusMessage: "no auth configured",
    });
  });

  test("returns provider-not-registered fallback when probe is absent", async () => {
    const { app } = makeRig(); // no probe wired
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot/cli-status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: false,
      statusMessage: "Copilot provider not registered",
    });
  });

  test("rejects disallowed origin with 403 (cross-origin guard applies)", async () => {
    const probe: CopilotAuthProbe = async () => ({ isAuthenticated: true });
    const { app } = makeRig({ copilotAuthProbe: probe });
    const res = await app.fetch(
      new Request("http://test/api/credentials/copilot/cli-status", {
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/credentials/claude/cli-status", () => {
  // The handler now checks ANTHROPIC_API_KEY in process.env before
  // consulting the CLI probe. These tests cover the probe path, so we
  // null the env for the describe block and restore it after. Skipping
  // this guard would let a developer's real ANTHROPIC_API_KEY make the
  // probe-path tests trivially pass via the env short-circuit.
  let savedEnv: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(() => {
    if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
  });

  test("returns probe result with email + authMethod", async () => {
    const probe: ClaudeAuthProbe = async () => ({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "octo@example.com",
    });
    const { app } = makeRig({ claudeAuthProbe: probe });
    const res = await app.fetch(
      new Request("http://test/api/credentials/claude/cli-status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      authMethod: "claude.ai",
      login: "octo@example.com",
    });
  });

  test("returns authenticated:false with statusMessage when probe errors", async () => {
    const probe: ClaudeAuthProbe = async () => ({
      loggedIn: false,
      error: "claude not on PATH",
    });
    const { app } = makeRig({ claudeAuthProbe: probe });
    const res = await app.fetch(
      new Request("http://test/api/credentials/claude/cli-status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: false,
      statusMessage: "claude not on PATH",
    });
  });

  test("returns provider-not-registered fallback when probe is absent", async () => {
    const { app } = makeRig(); // no probe wired
    const res = await app.fetch(
      new Request("http://test/api/credentials/claude/cli-status"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: false,
      statusMessage: "Claude provider not registered",
    });
  });

  test("env-set ANTHROPIC_API_KEY short-circuits to authenticated:true", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      // No probe wired — the handler should answer from env alone, not
      // fall through to the "Claude provider not registered" fallback.
      const { app } = makeRig();
      const res = await app.fetch(
        new Request("http://test/api/credentials/claude/cli-status"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        authenticated: true,
        authMethod: "env",
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("rejects disallowed origin with 403 (cross-origin guard applies)", async () => {
    const probe: ClaudeAuthProbe = async () => ({ loggedIn: true });
    const { app } = makeRig({ claudeAuthProbe: probe });
    const res = await app.fetch(
      new Request("http://test/api/credentials/claude/cli-status", {
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("credentials never round-trip via responses", () => {
  test("sentinel value never appears in any response body", async () => {
    const { app } = makeRig();
    const SENTINEL = "k9-supercalifragilistic-token-z7";

    const post = await app.fetch(
      new Request("http://test/api/credentials/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: SENTINEL }),
      }),
    );
    expect(post.status).toBe(204);
    expect(await post.text()).not.toContain(SENTINEL);

    const status = await app.fetch(
      new Request("http://test/api/credentials/copilot/status"),
    );
    expect(await status.text()).not.toContain(SENTINEL);

    const del = await app.fetch(
      new Request("http://test/api/credentials/copilot", { method: "DELETE" }),
    );
    expect(await del.text()).not.toContain(SENTINEL);
  });
});
