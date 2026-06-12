// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveKeelsonHome } from "./paths.ts";

const CONFIG_FILE_NAME = "config.json";

// Canonical built-in provider ids, in registration order. The workflow
// fallback ("first non-stub") and the default-provider pick both key off this
// order, so keep stub first and real providers after it.
export const BUILT_IN_PROVIDER_IDS = ["stub", "copilot", "claude", "pi", "codex"] as const;
export type BuiltInProviderId = (typeof BUILT_IN_PROVIDER_IDS)[number];

// Out-of-the-box enablement when neither KEELSON_PROVIDERS nor config.json says
// otherwise: copilot is the default agent; stub (offline echo), claude, pi, and
// codex are opt-in. stub is off by default so a fresh install presents a real
// coding agent, not the echo provider. A config `providers` map is merged over
// this.
export const DEFAULT_PROVIDER_ENABLEMENT: Readonly<Record<string, boolean>> = {
  stub: false,
  copilot: true,
  claude: false,
  pi: false,
  codex: false,
};

// Per-provider settings block. Only `model` is read today; the shape stays open
// so a provider can grow settings without a config migration.
const providerSettingsSchema = z.object({ model: z.string().optional() });

// How the claude provider chooses a credential. "auto" (default) prefers a
// Pro/Max subscription when `claude auth status` reports one and falls back to
// the API key otherwise; "subscription" / "api-key" pin one route. The provider
// strips ANTHROPIC_API_KEY from just the spawned CLI's env to reach the
// subscription, so this never requires unsetting the key globally.
export const CLAUDE_AUTH_MODES = ["auto", "subscription", "api-key"] as const;
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number];

const claudeSettingsSchema = providerSettingsSchema.extend({
  auth: z.enum(CLAUDE_AUTH_MODES).optional(),
});

// codex runs its own tools inside the `codex exec` subprocess, gated by the
// sandbox it is given (keelson can't gate them per-call). Defaults to
// "workspace-write" (read the repo, write within the project cwd); pin tighter
// with "read-only" or looser with "danger-full-access". `network` toggles the
// subprocess's network access (off by default).
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxModeConfig = (typeof CODEX_SANDBOX_MODES)[number];

const codexSettingsSchema = providerSettingsSchema.extend({
  sandbox: z.enum(CODEX_SANDBOX_MODES).optional(),
  network: z.boolean().optional(),
});

const keelsonConfigSchema = z.object({
  // Per-provider enable flags, merged over DEFAULT_PROVIDER_ENABLEMENT — a
  // config need only list the providers it wants to flip.
  providers: z.record(z.string(), z.boolean()).optional(),
  // Preferred provider for new chats and the workflow fallback. Honored only
  // when that provider is actually registered.
  defaultProvider: z.string().optional(),
  pi: providerSettingsSchema.optional(),
  claude: claudeSettingsSchema.optional(),
  codex: codexSettingsSchema.optional(),
});

export type KeelsonConfig = z.infer<typeof keelsonConfigSchema>;

// Read <home>/config.json (or KEELSON_CONFIG, when set). Tolerant by design: a
// missing file, unreadable file, non-JSON body, or shape mismatch all degrade
// to {} with a warning rather than throwing — config must never block boot.
export function loadKeelsonConfig(home: string = resolveKeelsonHome()): KeelsonConfig {
  const path = process.env.KEELSON_CONFIG?.trim() || join(home, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[keelson] ignoring ${path}: invalid JSON (${(err as Error).message}).`);
    return {};
  }
  const result = keelsonConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    console.warn(`[keelson] ignoring ${path}: ${issue?.message ?? "invalid shape"}${where}.`);
    return {};
  }
  return result.data;
}

export interface ResolveEnabledProvidersOptions {
  readonly config: KeelsonConfig;
  // Raw KEELSON_PROVIDERS value. When set non-empty it is an exact override of
  // the enabled list, ignoring config + defaults (back-compat + the test path).
  readonly envProviders?: string;
  // Ids the caller knows how to register, in canonical order. Output is a
  // subset of this, preserving its order.
  readonly known: readonly string[];
  readonly onWarn?: (message: string) => void;
}

// Resolve which providers to register. Precedence: KEELSON_PROVIDERS env (exact
// list) → config.providers merged over DEFAULT_PROVIDER_ENABLEMENT → defaults.
export function resolveEnabledProviders(opts: ResolveEnabledProvidersOptions): string[] {
  const warn = opts.onWarn ?? ((m: string) => console.warn(m));
  const knownSet = new Set(opts.known);

  const env = opts.envProviders?.trim();
  if (env) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of env.split(",")) {
      const id = part.trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (knownSet.has(id)) out.push(id);
      else warn(`[keelson] KEELSON_PROVIDERS contains unknown provider '${id}'; ignoring.`);
    }
    return out;
  }

  const merged: Record<string, boolean> = { ...DEFAULT_PROVIDER_ENABLEMENT };
  if (opts.config.providers) {
    for (const [rawId, enabled] of Object.entries(opts.config.providers)) {
      const id = rawId.trim().toLowerCase();
      if (!knownSet.has(id)) {
        warn(`[keelson] config.json providers map names an unknown provider '${rawId}'; ignoring.`);
        continue;
      }
      merged[id] = enabled === true;
    }
  }
  return opts.known.filter((id) => merged[id] === true);
}

// Pick the provider new chats and the workflow fallback default to. Honors
// config.defaultProvider when that provider is actually registered, else
// prefers copilot, then the first real (non-stub, non-workflow) provider, then
// stub. Returns undefined only when nothing is registered.
export function resolveDefaultProvider(
  config: KeelsonConfig,
  registeredIds: readonly string[],
): string | undefined {
  const ids = new Set(registeredIds);
  const preferred = config.defaultProvider?.trim().toLowerCase();
  if (preferred && preferred !== "workflow" && ids.has(preferred)) return preferred;
  if (ids.has("copilot")) return "copilot";
  const realFirst = registeredIds.find((id) => id !== "stub" && id !== "workflow");
  if (realFirst) return realFirst;
  if (ids.has("stub")) return "stub";
  // Never default to the synthetic non-chat 'workflow' provider — undefined when
  // nothing chat-capable is registered.
  return registeredIds.find((id) => id !== "workflow");
}
