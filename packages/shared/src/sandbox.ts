// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// Field names are mirrored structurally by @keelson/workflows; rename in both.

export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const codexSandboxModeSchema = z.enum(CODEX_SANDBOX_MODES);
export type CodexSandboxMode = z.infer<typeof codexSandboxModeSchema>;

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
  message: "env entries are variable names",
});

export const sandboxNetworkSchema = z
  .object({
    outbound: z.enum(["allow", "deny"]).default("deny"),
    loopback: z.boolean().optional(),
    allowedHosts: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const sandboxFilesystemSchema = z
  .object({
    readwrite: z.array(z.string().min(1)).default([]),
    readonly: z.array(z.string().min(1)).default([]),
    denied: z.array(z.string().min(1)).default([]),
  })
  .strict();

// Per-SDK passthrough, spread over each mapper's output last.
export const sandboxBackendSchema = z
  .object({
    copilot: z.record(z.string(), z.unknown()).optional(),
    claude: z.record(z.string(), z.unknown()).optional(),
    codex: z.object({ mode: codexSandboxModeSchema.optional() }).strict().optional(),
    pi: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const sandboxProfileSchema = z
  .object({
    enabled: z.boolean(),
    filesystem: sandboxFilesystemSchema.default({ readwrite: [], readonly: [], denied: [] }),
    network: sandboxNetworkSchema.default({ outbound: "deny" }),
    env: z.array(envNameSchema).default([]),
    backend: sandboxBackendSchema.optional(),
  })
  .strict();
export type SandboxProfile = z.infer<typeof sandboxProfileSchema>;
export type SandboxNetwork = SandboxProfile["network"];
export type SandboxFilesystem = SandboxProfile["filesystem"];
export type SandboxBackend = NonNullable<SandboxProfile["backend"]>;

// A profile before the per-turn on/off decision and working directory are applied.
export type SandboxSettings = Omit<SandboxProfile, "enabled">;

export const EMPTY_SANDBOX_SETTINGS: SandboxSettings = {
  filesystem: { readwrite: [], readonly: [], denied: [] },
  network: { outbound: "deny" },
  env: [],
};

export const sandboxModeSchema = z.enum(["on", "off"]);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export const sandboxSupportSchema = z.enum(["native", "tool", "none"]);
export type SandboxSupport = z.infer<typeof sandboxSupportSchema>;

// How a workflow node actually ran: in the Keelson sandbox runtime, inside the
// provider's own sandbox, or unconfined.
export const sandboxOutcomeSchema = z.enum(["mxc", "provider", "off"]);
export type SandboxOutcome = z.infer<typeof sandboxOutcomeSchema>;

// KEELSON_SANDBOX: `required` is a floor no conversation or frame can lower;
// `on`/`off` only replace the configured default.
export type SandboxEnvSetting =
  | { kind: "unset" }
  | { kind: "required" }
  | { kind: "default"; enabled: boolean }
  | { kind: "invalid"; value: string };

export function parseSandboxEnv(raw: string | undefined): SandboxEnvSetting {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") return { kind: "unset" };
  if (value === "required") return { kind: "required" };
  if (value === "on") return { kind: "default", enabled: true };
  if (value === "off") return { kind: "default", enabled: false };
  return { kind: "invalid", value: raw ?? "" };
}

export type SandboxSource = "floor" | "frame" | "conversation" | "env" | "config";

export interface SandboxResolution {
  enabled: boolean;
  source: SandboxSource;
  // True when the floor holds the sandbox on and a user toggle cannot clear it.
  locked: boolean;
}

export function resolveSandboxEnabled(input: {
  frame?: boolean;
  conversation?: SandboxMode;
  configDefault: boolean;
  env?: string;
}): SandboxResolution {
  const env = parseSandboxEnv(input.env);
  if (env.kind === "required") return { enabled: true, source: "floor", locked: true };
  if (input.frame !== undefined) return { enabled: input.frame, source: "frame", locked: false };
  if (input.conversation !== undefined) {
    return { enabled: input.conversation === "on", source: "conversation", locked: false };
  }
  if (env.kind === "default") return { enabled: env.enabled, source: "env", locked: false };
  return { enabled: input.configDefault, source: "config", locked: false };
}

function union(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

// `resolvePath` canonicalizes cwd (the server passes realpathSync); this module
// is bundled for the browser, so it cannot touch the filesystem itself.
export function buildSandboxProfile(
  base: SandboxSettings,
  cwd: string,
  enabled: boolean,
  resolvePath: (path: string) => string = (path) => path,
): SandboxProfile {
  const root = resolvePath(cwd);
  return {
    enabled,
    filesystem: {
      readwrite: union([root], base.filesystem.readwrite),
      readonly: union(base.filesystem.readonly),
      denied: union(base.filesystem.denied),
    },
    network: { ...base.network },
    env: union(base.env),
    ...(base.backend !== undefined ? { backend: base.backend } : {}),
  };
}

export interface SandboxProfileOverride {
  enabled?: boolean;
  filesystem?: Partial<SandboxFilesystem>;
  network?: Partial<SandboxNetwork>;
  env?: readonly string[];
  backend?: SandboxBackend;
}

// Scalars and backend keys in `override` win; path and env lists union.
export function mergeSandboxProfile(
  base: SandboxProfile,
  override: SandboxProfileOverride,
): SandboxProfile {
  const backend = mergeBackend(base.backend, override.backend);
  return {
    enabled: override.enabled ?? base.enabled,
    filesystem: {
      readwrite: union(base.filesystem.readwrite, override.filesystem?.readwrite),
      readonly: union(base.filesystem.readonly, override.filesystem?.readonly),
      denied: union(base.filesystem.denied, override.filesystem?.denied),
    },
    network: { ...base.network, ...definedOnly(override.network ?? {}) },
    env: union(base.env, override.env),
    ...(backend !== undefined ? { backend } : {}),
  };
}

function mergeBackend(
  base: SandboxBackend | undefined,
  override: SandboxBackend | undefined,
): SandboxBackend | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  const out: SandboxBackend = { ...base };
  for (const key of ["copilot", "claude", "codex", "pi"] as const) {
    const next = override[key];
    if (next === undefined) continue;
    const prev = base[key];
    out[key] = prev === undefined ? next : { ...prev, ...next };
  }
  return out;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function describeSandboxProfile(p: SandboxProfile): string {
  return p.enabled ? `sandbox on · ${describeSandboxGrants(p)}` : "sandbox off";
}

// What a profile lets a sandboxed tool do, whether or not it is enabled.
export function describeSandboxGrants(p: SandboxProfile): string {
  const [first, ...rest] = p.filesystem.readwrite;
  const writes =
    first === undefined ? "none" : rest.length > 0 ? `${first} +${rest.length}` : first;
  const network =
    p.network.outbound === "allow"
      ? p.network.allowedHosts && p.network.allowedHosts.length > 0
        ? `outbound ${p.network.allowedHosts.length} host(s)`
        : "outbound allowed"
      : "outbound denied";
  const parts = [
    `writes ${writes}`,
    ...(p.filesystem.readonly.length > 0 ? [`${p.filesystem.readonly.length} read-only`] : []),
    ...(p.filesystem.denied.length > 0 ? [`${p.filesystem.denied.length} denied`] : []),
    `network ${network}${p.network.loopback ? " + loopback" : ""}`,
    p.env.length > 0 ? `env ${p.env.join(", ")}` : "no extra env",
  ];
  return parts.join(" · ");
}

const NATIVE_BACKENDS: Record<string, Partial<Record<string, string>>> = {
  copilot: { darwin: "Seatbelt", linux: "bubblewrap", win32: "ProcessContainer" },
  claude: { darwin: "Seatbelt", linux: "bubblewrap" },
  codex: { darwin: "Seatbelt", linux: "Landlock", win32: "Windows sandbox" },
};

const NATIVE_NAMES: Record<string, string> = {
  copilot: "Copilot CLI sandbox",
  claude: "Claude Code sandbox",
  codex: "Codex sandbox",
};

// `platform` is the server host's, which a browser client learns from /api/config.
export function describeSandboxBackend(
  providerId: string,
  support: SandboxSupport,
  platform: string,
): string {
  if (support === "none") return `${providerId} cannot sandbox its tools`;
  if (support === "tool") return `${providerId} shell runs in the Keelson sandbox`;
  const name = NATIVE_NAMES[providerId] ?? `${providerId} native sandbox`;
  const backend = NATIVE_BACKENDS[providerId]?.[platform];
  return backend !== undefined ? `${name} (${backend})` : `${name} (unsupported on ${platform})`;
}

const SOURCE_LABELS: Record<SandboxSource, string> = {
  floor: "required by KEELSON_SANDBOX=required",
  frame: "set for this session",
  conversation: "saved on this conversation",
  env: "KEELSON_SANDBOX default",
  config: "config default",
};

export interface SandboxStatusInput {
  resolution: SandboxResolution;
  providerId: string;
  support: SandboxSupport;
  platform: string;
  // What a sandboxed turn may touch, from /api/config.
  profile: string;
  // The server host's runtime line, from /api/config.
  runtime?: string;
}

// The `/sandbox status` text, identical on the CLI and the SPA.
export function describeSandboxStatus(input: SandboxStatusInput): string[] {
  const { resolution, providerId, support } = input;
  const lines = [
    `sandbox: ${resolution.enabled ? "on" : "off"} (${SOURCE_LABELS[resolution.source]})`,
  ];
  const backend =
    providerId === "stub"
      ? "stub runs no tools (n/a)"
      : describeSandboxBackend(providerId, support, input.platform);
  lines.push(
    `provider: ${backend}${resolution.enabled && support === "none" ? "; turns fail closed while the sandbox is on" : ""}`,
  );
  if (input.runtime !== undefined) lines.push(`runtime: ${input.runtime}`);
  lines.push(`profile: ${input.profile}`);
  return lines;
}

export const SANDBOX_LOCKED_MESSAGE =
  "KEELSON_SANDBOX=required holds the sandbox on; unset it to turn the sandbox off";

export function sandboxUnsupportedWarning(
  providerId: string,
  support: SandboxSupport,
): string | undefined {
  return support === "none"
    ? `${providerId} cannot sandbox its tools, so turns fail closed while the sandbox is on; switch to a provider that can sandbox`
    : undefined;
}
