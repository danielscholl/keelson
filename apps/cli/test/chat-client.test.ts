// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, describe, expect, test } from "bun:test";
import { WIRE_PROTOCOL_VERSION } from "@keelson/shared";
import {
  chatViaServer,
  createConversation,
  fetchSandboxConfig,
  type ProviderInfoRow,
  pickDefaultHttpProvider,
  updateConversation,
} from "../src/http/chat-client.ts";

const row = (id: string): ProviderInfoRow => ({
  id,
  displayName: id,
  builtIn: true,
  capabilities: { models: [], defaultModel: "" } as unknown as ProviderInfoRow["capabilities"],
});

describe("pickDefaultHttpProvider", () => {
  test("honors the server's default provider when it is registered", () => {
    expect(pickDefaultHttpProvider([row("copilot"), row("pi"), row("stub")], "pi")).toBe("pi");
  });

  test("ignores an unregistered or synthetic server default", () => {
    expect(pickDefaultHttpProvider([row("copilot"), row("stub")], "pi")).toBe("copilot");
    expect(pickDefaultHttpProvider([row("workflow"), row("stub")], "workflow")).toBe("stub");
  });

  test("falls back copilot → stub → first non-workflow without a server default", () => {
    expect(pickDefaultHttpProvider([row("pi"), row("copilot")])).toBe("copilot");
    expect(pickDefaultHttpProvider([row("pi"), row("stub")])).toBe("stub");
    expect(pickDefaultHttpProvider([row("workflow"), row("pi")])).toBe("pi");
  });
});

describe("sandbox on the wire", () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const frames: unknown[] = [];
  let configBody: unknown = {};
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/chat/ws" && srv.upgrade(req)) return undefined;
      if (url.pathname === "/api/config") return Response.json(configBody);
      const body = req.method === "GET" ? undefined : await req.json();
      seen.push({ method: req.method, path: url.pathname, body });
      return Response.json({ id: "c1", providerId: "pi", sandbox: "on" });
    },
    websocket: {
      message(ws, raw) {
        frames.push(JSON.parse(String(raw)));
        ws.send(
          JSON.stringify({
            version: WIRE_PROTOCOL_VERSION,
            conversationId: "c1",
            event: { type: "error", message: "sandbox is on", code: "SANDBOX_UNAVAILABLE" },
          }),
        );
        ws.send(
          JSON.stringify({
            version: WIRE_PROTOCOL_VERSION,
            conversationId: "c1",
            event: { type: "done" },
          }),
        );
      },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));

  test("createConversation and updateConversation carry the sandbox mode", async () => {
    await createConversation(base, { providerId: "pi", sandbox: "on" });
    const row = await updateConversation(base, "c1", { sandbox: "off" });
    expect(seen).toEqual([
      { method: "POST", path: "/api/conversations", body: { providerId: "pi", sandbox: "on" } },
      { method: "PATCH", path: "/api/conversations/c1", body: { sandbox: "off" } },
    ]);
    expect(row.sandbox).toBe("on");
  });

  test("the request frame carries sandbox and the error frame's code comes back", async () => {
    const result = await chatViaServer({
      baseUrl: base,
      conversationId: "c1",
      providerId: "pi",
      message: "hi",
      sandbox: true,
    });
    expect((frames[0] as { message: { sandbox?: boolean } }).message.sandbox).toBe(true);
    expect(result).toEqual({
      errored: true,
      errorMessage: "sandbox is on",
      errorCode: "SANDBOX_UNAVAILABLE",
    });
  });

  test("fetchSandboxConfig reads the policy and treats a server without one as off", async () => {
    configBody = {
      sandbox: { default: true, floor: true, summary: "sandbox on", platform: "darwin" },
    };
    expect(await fetchSandboxConfig(base)).toEqual({
      default: true,
      floor: true,
      summary: "sandbox on",
      platform: "darwin",
    });
    configBody = {};
    expect(await fetchSandboxConfig(base)).toEqual({
      default: false,
      floor: false,
      summary: "sandbox off",
    });
  });
});
