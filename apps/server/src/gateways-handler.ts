// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Gateway management. A gateway is an OpenAI-compatible endpoint registered as a
// provider named for the gateway. Non-secret metadata (baseUrl, protocol,
// model) persists to config.json; the API key persists to the keychain under
// gatewayCredentialServiceId(name) and is never round-tripped to the browser.

import {
  type GatewayConfig,
  type GatewaySummary,
  gatewayCredentialServiceId,
  gatewayNameSchema,
  loadKeelsonConfig,
  updateKeelsonConfigGateways,
  upsertGatewayBodySchema,
} from "@keelson/shared/config";
import type { Hono } from "hono";
import type { CredentialStore } from "./credentials.ts";
import { isAllowedOrigin } from "./server-context.ts";

export interface GatewaysRoutesDeps {
  // Config dir override for tests; defaults to the resolved keelson home (via
  // updateKeelsonConfigGateways / loadKeelsonConfig).
  home?: string;
  // Live-(re)register the provider after its config + key persist. Injected by
  // the composition root so the handler stays free of the global registry and
  // remains unit-testable.
  onGatewayUpserted: (gateway: GatewayConfig) => void;
  // Tear down the registered provider after its config + key are removed.
  onGatewayRemoved: (name: string) => void;
}

async function summarize(store: CredentialStore, gateway: GatewayConfig): Promise<GatewaySummary> {
  const signedIn = (await store.get(gatewayCredentialServiceId(gateway.name))) !== undefined;
  return { ...gateway, signedIn };
}

export function gatewaysRoutes(app: Hono, store: CredentialStore, deps: GatewaysRoutesDeps): void {
  const home = deps.home;
  const loadGateways = (): GatewayConfig[] => loadKeelsonConfig(home).gateways ?? [];

  // Serialize mutations so two concurrent PUT/DELETE calls can't interleave the
  // config write, keychain I/O, and registry update and leave them out of sync.
  // Each task runs after the previous settles; a task's failure never poisons
  // the chain for the next.
  let mutations: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = mutations.then(task, task);
    mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // CSRF guard on the mutating routes, mirroring credentialsRoutes: a present
  // Origin must be loopback; a missing Origin is a non-browser caller (curl /
  // CLI on loopback) that already has shell access to the keychain.
  app.use("/api/gateways/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  });

  app.get("/api/gateways", async (c) => {
    const gateways = await Promise.all(loadGateways().map((gw) => summarize(store, gw)));
    return c.json({ gateways });
  });

  app.put("/api/gateways/:name", async (c) => {
    const nameParsed = gatewayNameSchema.safeParse(c.req.param("name"));
    if (!nameParsed.success) {
      return c.json({ error: nameParsed.error.issues[0]?.message ?? "invalid gateway name" }, 400);
    }
    const name = nameParsed.data;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const bodyParsed = upsertGatewayBodySchema.safeParse(body);
    if (!bodyParsed.success) {
      return c.json({ error: bodyParsed.error.issues[0]?.message ?? "invalid body" }, 400);
    }
    const gateway: GatewayConfig = {
      name,
      baseUrl: bodyParsed.data.baseUrl,
      protocol: bodyParsed.data.protocol ?? "openai",
      ...(bodyParsed.data.model ? { model: bodyParsed.data.model } : {}),
    };
    const apiKey = bodyParsed.data.apiKey;
    try {
      await serialize(async () => {
        updateKeelsonConfigGateways(
          (gateways) => [...gateways.filter((g) => g.name !== name), gateway],
          home,
        );
        if (apiKey) await store.set(gatewayCredentialServiceId(name), apiKey);
        deps.onGatewayUpserted(gateway);
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return c.json(await summarize(store, gateway));
  });

  app.delete("/api/gateways/:name", async (c) => {
    const nameParsed = gatewayNameSchema.safeParse(c.req.param("name"));
    if (!nameParsed.success) {
      return c.json({ error: nameParsed.error.issues[0]?.message ?? "invalid gateway name" }, 400);
    }
    const name = nameParsed.data;
    try {
      await serialize(async () => {
        updateKeelsonConfigGateways((gateways) => gateways.filter((g) => g.name !== name), home);
        await store.delete(gatewayCredentialServiceId(name));
        deps.onGatewayRemoved(name);
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    // Idempotent — same 204 whether or not the gateway existed.
    return c.body(null, 204);
  });
}
