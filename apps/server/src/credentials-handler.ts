// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Credentials POST inbound only — never round-trip the value back to the
// browser. The status endpoint returns only the bit `signedIn`.

import type { ClaudeAuthProbe, CopilotAuthProbe } from "@keelson/providers";
import {
  type ClaudeCliStatus,
  type CopilotCliStatus,
  claudeCliStatusSchema,
  copilotCliStatusSchema,
  credentialServiceIdSchema,
  credentialStatusSchema,
  setCredentialBodySchema,
} from "@keelson/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { type CredentialStore, ribCredentialAccountSchema } from "./credentials.ts";
import { isAllowedOrigin } from "./server-context.ts";

// The credential routes accept either a public kebab service id (copilot,
// claude, …) or a rib-namespaced account (`rib_<id>_<svc>`) so the rib
// credential accessor's keys are provisionable through this same route. This
// mirrors the store's own `assertServiceId`, keeping route and store in sync.
const SERVICE_ID_SCHEMA = z.union([credentialServiceIdSchema, ribCredentialAccountSchema]);

export interface CredentialsRoutesDeps {
  // Optional — present only when Copilot is among the registered providers.
  // When absent, GET /api/credentials/copilot/cli-status returns
  // `{ authenticated: false, statusMessage: "Copilot provider not registered" }`
  // so the UI gets a stable shape regardless of KEELSON_PROVIDERS.
  copilotAuthProbe?: CopilotAuthProbe;
  // Same fallback semantics for Claude. Probe shells out to
  // `claude auth status --json`; absent when Claude isn't registered.
  claudeAuthProbe?: ClaudeAuthProbe;
  // Override for tests — defaults to process.cwd(). The Copilot SDK uses
  // this to scope the auth answer to the workspace sendQuery would target.
  cwd?: () => string;
}

export function credentialsRoutes(
  app: Hono,
  store: CredentialStore,
  deps: CredentialsRoutesDeps = {},
): void {
  const cwdFn = deps.cwd ?? (() => process.cwd());
  // Cross-origin guard: a browser cross-origin POST (e.g. mode: 'no-cors'
  // with text/plain) sails past CORS read-blocking and would otherwise
  // overwrite a stored token. Reject when Origin is set but not in the
  // dev/prod allowlist. Missing Origin is treated as a non-browser caller
  // (curl, scripts on the loopback) and allowed — those already have shell
  // access to the keyring directly.
  app.use("/api/credentials/*", async (c, next) => {
    const origin = c.req.header("origin");
    // Missing Origin = non-browser caller (curl on loopback) — those already
    // have shell access to the keyring, so allow. Present-but-non-loopback
    // is the CSRF case we reject.
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  });

  app.post("/api/credentials/:serviceId", async (c) => {
    const idParsed = SERVICE_ID_SCHEMA.safeParse(c.req.param("serviceId"));
    if (!idParsed.success) {
      return c.json({ error: "invalid serviceId" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const bodyParsed = setCredentialBodySchema.safeParse(body);
    if (!bodyParsed.success) {
      return c.json({ error: bodyParsed.error.message }, 400);
    }
    try {
      await store.set(idParsed.data, bodyParsed.data.value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
    return c.body(null, 204);
  });

  app.delete("/api/credentials/:serviceId", async (c) => {
    const idParsed = SERVICE_ID_SCHEMA.safeParse(c.req.param("serviceId"));
    if (!idParsed.success) {
      return c.json({ error: "invalid serviceId" }, 400);
    }
    try {
      await store.delete(idParsed.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
    // Idempotent — same 204 whether or not the entry existed.
    return c.body(null, 204);
  });

  app.get("/api/credentials/:serviceId/status", async (c) => {
    const idParsed = SERVICE_ID_SCHEMA.safeParse(c.req.param("serviceId"));
    if (!idParsed.success) {
      return c.json({ error: "invalid serviceId" }, 400);
    }
    let value: string | undefined;
    try {
      value = await store.get(idParsed.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
    const status = credentialStatusSchema.parse({ signedIn: value !== undefined });
    return c.json(status);
  });

  // Copilot CLI auth probe (F9). Sits beside the generic /status route and
  // proxies the SDK's getAuthStatus so the SignIn UI can branch between
  // "Using local Copilot CLI auth as @user", "No CLI auth detected", and
  // "Token paste-saved". Probe never throws — `authenticated: false` plus
  // `statusMessage` is the failure shape.
  app.get("/api/credentials/copilot/cli-status", async (c) => {
    if (!deps.copilotAuthProbe) {
      const fallback: CopilotCliStatus = {
        authenticated: false,
        statusMessage: "Copilot provider not registered",
      };
      return c.json(copilotCliStatusSchema.parse(fallback));
    }
    const result = await deps.copilotAuthProbe(cwdFn());
    const status: CopilotCliStatus = {
      authenticated: result.isAuthenticated,
      ...(result.authType ? { authType: result.authType } : {}),
      ...(result.login ? { login: result.login } : {}),
      ...(result.host ? { host: result.host } : {}),
      ...(result.statusMessage ? { statusMessage: result.statusMessage } : {}),
    };
    return c.json(copilotCliStatusSchema.parse(status));
  });

  // Claude auth probe. Checks env first (the SDK's spawn inherits
  // process.env, so ANTHROPIC_API_KEY in `.env` is the zero-friction
  // path); falls through to `claude auth status --json` when env is
  // unset because the Claude Agent SDK has no programmatic auth-status
  // method. Never throws — `authenticated: false` is the failure shape.
  app.get("/api/credentials/claude/cli-status", async (c) => {
    if (process.env.ANTHROPIC_API_KEY) {
      const status: ClaudeCliStatus = {
        authenticated: true,
        authMethod: "env",
      };
      return c.json(claudeCliStatusSchema.parse(status));
    }
    if (!deps.claudeAuthProbe) {
      const fallback: ClaudeCliStatus = {
        authenticated: false,
        statusMessage: "Claude provider not registered",
      };
      return c.json(claudeCliStatusSchema.parse(fallback));
    }
    const result = await deps.claudeAuthProbe();
    const status: ClaudeCliStatus = {
      authenticated: result.loggedIn,
      ...(result.authMethod ? { authMethod: result.authMethod } : {}),
      ...(result.email ? { login: result.email } : {}),
      ...(result.error ? { statusMessage: result.error } : {}),
    };
    return c.json(claudeCliStatusSchema.parse(status));
  });
}
