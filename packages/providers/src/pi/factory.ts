// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PiRawEvent } from "./event-bridge.ts";

// The slice of a pi AgentSession the provider drives. The real factory adapts
// pi's session; tests supply a fake that emits scripted events.
export interface PiSession {
  // Register an event listener; returns an unsubscribe function.
  subscribe(listener: (event: PiRawEvent) => void): () => void;
  // Run one turn. Resolves when the turn is done; events fire via subscribe.
  prompt(text: string): Promise<void>;
}

export interface PiCreateSessionParams {
  cwd: string;
  // "vendor/model" (e.g. "anthropic/claude-opus-4.5"). Omitted → pi picks from
  // its own settings/auth.
  model?: string;
}

export interface PiSessionFactory {
  createSession(params: PiCreateSessionParams): Promise<PiSession>;
}

// Per-vendor API-key env vars pi reads. A subset — pi supports many more; this
// list only needs to recognise that *some* credential is present for the doctor
// hint. pi owns the actual resolution.
const PI_VENDOR_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export interface PiAuthStatus {
  authenticated: boolean;
  source?: "auth.json" | "env";
}

export interface CheckPiAuthOptions {
  env?: NodeJS.ProcessEnv;
  // Defaults to ~/.pi/agent/auth.json; overridable so tests stay hermetic.
  authFile?: string;
}

// Self-managed auth: pi reads ~/.pi/agent/auth.json and per-vendor env keys.
// We only report presence for `keelson doctor`; pi owns the credential flow
// (its own `pi` login). Pure over the filesystem + env so it is testable.
export function checkPiAuth(opts: CheckPiAuthOptions = {}): PiAuthStatus {
  const env = opts.env ?? process.env;
  const authFile = opts.authFile ?? join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(authFile)) return { authenticated: true, source: "auth.json" };
  for (const name of PI_VENDOR_ENV_VARS) {
    if (env[name]?.trim()) return { authenticated: true, source: "env" };
  }
  return { authenticated: false };
}

// Default factory: drives the real pi SDK. The SDK is lazy-imported inside
// createSession so a missing or broken pi install never crashes unrelated
// commands, and so pi's own package.json self-read happens only when a turn
// actually runs. This adapter is the one seam with no unit coverage: it is
// written against pi 0.79.1 but the SDK-call path is not yet exercised live
// (that needs real pi credentials).
export class PiAgentSessionFactory implements PiSessionFactory {
  async createSession(params: PiCreateSessionParams): Promise<PiSession> {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const model = params.model ? await resolveModel(params.model) : undefined;
    const { session } = await sdk.createAgentSession({
      cwd: params.cwd,
      // Pure chat/reasoning inside keelson: pi's built-in read/bash/edit/write
      // tools would run without keelson's permission + redaction rails, so they
      // stay off until that gating is wired.
      noTools: "all",
      // `as never` is the cast boundary: resolveModel returns the SDK's Model
      // resolved from a string ref, which the strict generic signature can't see.
      ...(model !== undefined ? { model: model as never } : {}),
    });
    return {
      subscribe: (listener) =>
        session.subscribe((event) => listener(event as unknown as PiRawEvent)),
      prompt: (text) => session.prompt(text),
    };
  }
}

// Resolve via pi's model registry, not pi-ai's static getModel: the registry
// applies github-copilot's modifyModels hook, which rewrites the model baseUrl
// to the account's own token endpoint (individual/business/enterprise). Static
// getModel keeps the hardcoded individual host, so a non-individual account
// gets HTTP 421 Misdirected Request. Fallbacks (static def, then undefined)
// keep an unresolvable ref from throwing.
async function resolveModel(ref: string): Promise<unknown | undefined> {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  if (!modelId) return undefined;
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const registry = sdk.ModelRegistry.create(
      sdk.AuthStorage.create(),
      join(sdk.getAgentDir(), "models.json"),
    );
    const match = registry.getAvailable().find((m) => m.provider === provider && m.id === modelId);
    if (match) return match;
  } catch {
    // registry unavailable (missing pi install / unreadable config) — fall
    // through to the static definition below.
  }
  try {
    const piai = await import("@earendil-works/pi-ai");
    const getModel = piai.getModel as (p: string, m: string) => unknown;
    return getModel(provider, modelId);
  } catch {
    return undefined;
  }
}
