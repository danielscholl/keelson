// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { spawnEnv } from "./spawn-env.ts";

const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

async function runCli(
  args: readonly string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: spawnEnv(env) } : {}),
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

type GatewaySummary = {
  name: string;
  baseUrl: string;
  protocol: string;
  model?: string;
  signedIn: boolean;
};

interface GatewaysServerConfig {
  gateways?: GatewaySummary[];
  putStatus?: number;
  putBody?: unknown;
}

function startGatewaysServer(config: GatewaysServerConfig = {}): {
  baseUrl: string;
  stop: () => void;
  requests: { puts: Array<{ name: string; body: Record<string, unknown> }>; deletes: string[] };
} {
  const requests = {
    puts: [] as Array<{ name: string; body: Record<string, unknown> }>,
    deletes: [] as string[],
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/gateways") {
        return Response.json({ gateways: config.gateways ?? [] });
      }
      if (req.method === "PUT" && url.pathname.startsWith("/api/gateways/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/gateways/".length));
        const body = (await req.json()) as Record<string, unknown>;
        requests.puts.push({ name, body });
        if (config.putStatus !== undefined) {
          return Response.json(config.putBody ?? { error: "put failed" }, {
            status: config.putStatus,
          });
        }
        return Response.json({
          name,
          baseUrl: body.baseUrl,
          protocol: body.protocol ?? "openai",
          ...(body.model ? { model: body.model } : {}),
          signedIn: Boolean(body.apiKey),
        });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/gateways/")) {
        requests.deletes.push(decodeURIComponent(url.pathname.slice("/api/gateways/".length)));
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

function envelope(stdout: string): any {
  return JSON.parse(stdout.trim());
}

describe("keelson gateway", () => {
  test("gateway list --json returns gateways from the server", async () => {
    const gateways: GatewaySummary[] = [
      { name: "ollama", baseUrl: "http://localhost:11434/v1", protocol: "openai", signedIn: false },
    ];
    const fake = startGatewaysServer({ gateways });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "gateway",
        "list",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.gateways).toEqual(gateways);
    } finally {
      fake.stop();
    }
  });

  test("gateway list with no server exits 3 with NO_SERVER", async () => {
    const { stdout, exitCode } = await runCli([
      "--json",
      "gateway",
      "list",
      "--base-url",
      "http://127.0.0.1:1",
    ]);
    expect(exitCode).toBe(3);
    const env = envelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("NO_SERVER");
  });

  test("gateway add rejects a blank name", async () => {
    const { stdout, exitCode } = await runCli(["--json", "gateway", "add", "  ", "http://h/v1"]);
    expect(exitCode).toBe(2);
    expect(envelope(stdout).code).toBe("BAD_INPUTS");
  });

  test("gateway add rejects a blank url", async () => {
    const { stdout, exitCode } = await runCli(["--json", "gateway", "add", "ollama", "  "]);
    expect(exitCode).toBe(2);
    expect(envelope(stdout).code).toBe("BAD_INPUTS");
  });

  test("gateway add sends baseUrl/model/key and returns the summary", async () => {
    const fake = startGatewaysServer();
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "gateway",
        "add",
        "router",
        "https://openrouter.ai/api/v1",
        "--model",
        "openai/gpt-4o",
        "--key",
        "sk-secret",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.gateway).toMatchObject({ name: "router", signedIn: true });
      expect(fake.requests.puts).toHaveLength(1);
      expect(fake.requests.puts[0]).toEqual({
        name: "router",
        body: {
          baseUrl: "https://openrouter.ai/api/v1",
          model: "openai/gpt-4o",
          apiKey: "sk-secret",
        },
      });
    } finally {
      fake.stop();
    }
  });

  test("gateway add maps an HTTP 400 to BAD_INPUTS", async () => {
    const fake = startGatewaysServer({ putStatus: 400, putBody: { error: "bad gateway name" } });
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "gateway",
        "add",
        "claude",
        "http://h/v1",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(2);
      expect(envelope(stdout).code).toBe("BAD_INPUTS");
    } finally {
      fake.stop();
    }
  });

  test("gateway remove sends a DELETE and returns the removed name", async () => {
    const fake = startGatewaysServer();
    try {
      const { stdout, exitCode } = await runCli([
        "--json",
        "gateway",
        "remove",
        "ollama",
        "--base-url",
        fake.baseUrl,
      ]);
      expect(exitCode).toBe(0);
      const env = envelope(stdout);
      expect(env.ok).toBe(true);
      expect(env.data.removed).toBe("ollama");
      expect(fake.requests.deletes).toEqual(["ollama"]);
    } finally {
      fake.stop();
    }
  });
});
