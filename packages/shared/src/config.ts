// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { credentialServiceIdSchema } from "./chat.ts";
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

// MCP gateway settings. The server exposes the tool registry over MCP when
// `enabled` (default true); state-changing tools also cross by default —
// set `exposeStateChanging: false` to restrict the endpoint to read-only tools.
// `toolDenylist` removes tools by name; `requireToken` gates the endpoint behind
// a bearer token recorded in server.json. KEELSON_MCP_* env vars override these
// (see resolveMcpSettings).
const mcpSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  exposeStateChanging: z.boolean().optional(),
  toolDenylist: z.array(z.string()).optional(),
  requireToken: z.boolean().optional(),
});

// `{ callerRibId: { targetRibId: [toolName, …] } }`, `"*"` meaning every tool the
// target owns. Unioned with KEELSON_CROSS_RIB_GRANTS, not overridden by it (see
// resolveCrossRibGrants).
const crossRibGrantsSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(z.string().min(1)).min(1)),
);
export type CrossRibGrantsConfig = z.infer<typeof crossRibGrantsSchema>;

// Wire flavors a gateway speaks. Only "openai" (OpenAI Chat Completions, the
// universal IR for OpenRouter / Ollama / vLLM / Azure / LiteLLM) is implemented
// today; the enum is single-valued so adding "anthropic" later is a
// non-breaking widening, not a schema migration.
export const GATEWAY_PROTOCOLS = ["openai"] as const;
export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number];

// Names that would shadow a registered provider id. A gateway registers under
// its own name, so it must not collide with a built-in or the synthetic
// non-chat 'workflow' provider.
const RESERVED_GATEWAY_NAMES = new Set<string>([...BUILT_IN_PROVIDER_IDS, "workflow"]);

// A gateway name is the provider id AND part of the keychain account
// (`gateway-<name>`); cap at 48 so that account stays within
// credentialServiceIdSchema's 64-char limit, and lock it to kebab-case so the
// account is path-safe.
export const gatewayNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, "gateway name must be lowercase kebab-case")
  .refine((n) => !RESERVED_GATEWAY_NAMES.has(n), {
    message: "gateway name collides with a built-in provider id",
  });

// http(s)-only; a manual refine (not z.string().url()) keeps the rule explicit
// and stable across zod minor versions.
const gatewayBaseUrlSchema = z.string().refine(
  (v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "baseUrl must be an http(s) URL (e.g. http://localhost:11434/v1)" },
);

// A configured gateway: an OpenAI-compatible endpoint reached at `baseUrl` (the
// API key, when needed, lives in the keychain under gatewayCredentialServiceId).
// `model` seeds the default + the picker; the live model list comes from
// listModels() against the endpoint.
export const gatewayConfigSchema = z
  .object({
    name: gatewayNameSchema,
    baseUrl: gatewayBaseUrlSchema,
    protocol: z.enum(GATEWAY_PROTOCOLS).default("openai"),
    model: z.string().min(1).optional(),
  })
  .strict();
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

// The keychain account a gateway's API key is stored under. Distinct from the
// gateway name's own namespace via the `gateway-` prefix; validated so a bad
// name can't mint an unreadable keyring entry.
export function gatewayCredentialServiceId(name: string): string {
  const serviceId = `gateway-${name}`;
  return credentialServiceIdSchema.parse(serviceId);
}

// Wire shape for GET /api/gateways and the PUT response — a gateway's
// non-secret config plus a `signedIn` bit (the API key is never returned).
export const gatewaySummarySchema = gatewayConfigSchema.extend({ signedIn: z.boolean() }).strict();
export type GatewaySummary = z.infer<typeof gatewaySummarySchema>;

export const listGatewaysResponseSchema = z
  .object({ gateways: z.array(gatewaySummarySchema) })
  .strict();
export type ListGatewaysResponse = z.infer<typeof listGatewaysResponseSchema>;

// Wire shape for PUT /api/gateways/:name — upsert metadata plus an optional
// API key (set/rotated only when present; omitted leaves the stored key as-is).
export const upsertGatewayBodySchema = z
  .object({
    baseUrl: gatewayBaseUrlSchema,
    protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
    model: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .strict();
export type UpsertGatewayBody = z.infer<typeof upsertGatewayBodySchema>;

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
  mcp: mcpSettingsSchema.optional(),
  // Which ribs may call which other ribs' tools. Default-deny without an entry.
  crossRibGrants: crossRibGrantsSchema.optional(),
  // OpenAI-compatible gateway endpoints, each registered as a provider named
  // for the gateway. Non-secret metadata only — the API key lives in the
  // keychain (see gatewayCredentialServiceId).
  gateways: z.array(gatewayConfigSchema).optional(),
});

export type KeelsonConfig = z.infer<typeof keelsonConfigSchema>;

export type ReadKeelsonConfigResult =
  | { readonly ok: true; readonly config: KeelsonConfig }
  | { readonly ok: false; readonly path: string; readonly reason: string };

// Read <home>/config.json (or KEELSON_CONFIG, when set), keeping the failure
// instead of degrading it. A caller that asserts something about the file's
// contents needs "declares nothing" (absent file → ok with {}) apart from "could
// not be read", which loadKeelsonConfig collapses into the same {}.
export function readKeelsonConfig(home: string = resolveKeelsonHome()): ReadKeelsonConfigResult {
  const path = process.env.KEELSON_CONFIG?.trim() || join(home, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, config: {} };
    return { ok: false, path, reason: (err as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, path, reason: `invalid JSON (${(err as Error).message})` };
  }
  const result = keelsonConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return { ok: false, path, reason: `${issue?.message ?? "invalid shape"}${where}` };
  }
  return { ok: true, config: result.data };
}

// Read <home>/config.json (or KEELSON_CONFIG, when set). Tolerant by design: a
// missing file, unreadable file, non-JSON body, or shape mismatch all degrade
// to {} with a warning rather than throwing — config must never block boot.
export function loadKeelsonConfig(home: string = resolveKeelsonHome()): KeelsonConfig {
  const result = readKeelsonConfig(home);
  if (result.ok) return result.config;
  console.warn(`[keelson] ignoring ${result.path}: ${result.reason}.`);
  return {};
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

// Resolved MCP gateway settings — config.mcp with KEELSON_MCP_* env overrides
// applied. Env wins over config (mirrors KEELSON_PROVIDERS over config.providers).
export interface McpSettings {
  enabled: boolean;
  exposeStateChanging: boolean;
  toolDenylist: string[];
  requireToken: boolean;
}

export function resolveMcpSettings(
  config: KeelsonConfig,
  env: Record<string, string | undefined> = process.env,
): McpSettings {
  const m = config.mcp ?? {};
  const envList = (env.KEELSON_MCP_DENYLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    enabled: env.KEELSON_MCP_DISABLED === "1" ? false : m.enabled !== false,
    // Default on: the local, single-user harness exposes its registered tools —
    // state-changing included — over the loopback endpoint. `=1` forces on and
    // `=0` forces off, each winning over config; otherwise config decides and an
    // unset config defaults to on (lock down with `exposeStateChanging: false`).
    exposeStateChanging:
      env.KEELSON_MCP_EXPOSE_STATE_CHANGING === "1"
        ? true
        : env.KEELSON_MCP_EXPOSE_STATE_CHANGING === "0"
          ? false
          : m.exposeStateChanging !== false,
    toolDenylist: [...new Set([...(m.toolDenylist ?? []), ...envList])],
    requireToken: env.KEELSON_MCP_REQUIRE_TOKEN === "1" ? true : m.requireToken === true,
  };
}

// The grants in force, resolved: caller rib id → target rib id → granted tool
// names ("*" = every tool the target owns).
export type CrossRibGrants = Map<string, Map<string, Set<string>>>;

// The one place a grant enters the map, so the env string and the config object
// normalize identically. Both sources are hand-authored, and a stray space is
// invisible in either — an untrimmed `"osdu_security "` would parse, store, and
// then never match the check, denying a grant the operator believes they set.
function addCrossRibGrant(
  grants: CrossRibGrants,
  rawCaller: string,
  rawTarget: string,
  rawNames: readonly string[],
): void {
  const caller = rawCaller.trim();
  const target = rawTarget.trim();
  const names = rawNames.map((name) => name.trim()).filter((name) => name.length > 0);
  if (!caller || !target || names.length === 0) return;
  let targetGrants = grants.get(caller);
  if (!targetGrants) {
    targetGrants = new Map();
    grants.set(caller, targetGrants);
  }
  let toolGrants = targetGrants.get(target);
  if (!toolGrants) {
    toolGrants = new Set();
    targetGrants.set(target, toolGrants);
  }
  for (const name of names) {
    toolGrants.add(name);
  }
}

export function parseCrossRibGrants(raw: string | undefined): CrossRibGrants {
  const grants: CrossRibGrants = new Map();
  if (raw === undefined || raw.trim() === "") return grants;
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const [caller, target, tools, ...rest] = trimmed.split(":").map((part) => part.trim());
    if (!caller || !target || !tools || rest.length > 0) continue;
    const names = tools
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    addCrossRibGrant(grants, caller, target, names);
  }
  return grants;
}

function addConfigGrants(grants: CrossRibGrants, config: CrossRibGrantsConfig | undefined): void {
  for (const [caller, targets] of Object.entries(config ?? {})) {
    for (const [target, names] of Object.entries(targets)) {
      addCrossRibGrant(grants, caller, target, names);
    }
  }
}

// A `{ caller: { target: [tool, …] } }` object to the resolved map, normalized
// exactly as the env parser normalizes its half. Serves both config.json's
// `crossRibGrants` and the identically-shaped map GET /api/ribs reports.
export function crossRibGrantsFromConfig(config: CrossRibGrantsConfig | undefined): CrossRibGrants {
  const grants: CrossRibGrants = new Map();
  addConfigGrants(grants, config);
  return grants;
}

// The inverse: a resolved map back to the wire/config object shape.
export function serializeCrossRibGrants(
  grants: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>,
): CrossRibGrantsConfig {
  const out: CrossRibGrantsConfig = {};
  for (const [caller, targets] of grants) {
    const byTarget: Record<string, string[]> = {};
    for (const [target, tools] of targets) {
      byTarget[target] = [...tools];
    }
    out[caller] = byTarget;
  }
  return out;
}

// The grants in force: config.json's `crossRibGrants` unioned with
// KEELSON_CROSS_RIB_GRANTS. A union, not an override, because the two answer
// different questions — config is the standing grant that has to survive a
// restart from any shell, env is a grant for one session. Either alone is
// sufficient; neither can revoke the other (remove the grant to revoke it).
export function resolveCrossRibGrants(
  config: KeelsonConfig,
  env: Record<string, string | undefined> = process.env,
): CrossRibGrants {
  const grants = parseCrossRibGrants(env.KEELSON_CROSS_RIB_GRANTS);
  addConfigGrants(grants, config.crossRibGrants);
  return grants;
}

export function isCrossRibGrantAllowed(
  grants: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>,
  callerRibId: string,
  targetRibId: string,
  name: string,
): boolean {
  const tools = grants.get(callerRibId)?.get(targetRibId);
  return tools?.has(name) === true || tools?.has("*") === true;
}

// Tolerant read of the gateways array from a raw config object: keep the
// entries that still validate, drop the rest. Used by the writer so one corrupt
// entry can't fail an otherwise-valid update.
function readGatewayArray(raw: unknown): GatewayConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: GatewayConfig[] = [];
  for (const item of raw) {
    const parsed = gatewayConfigSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// Read-modify-write the `gateways` array in config.json, preserving every other
// (including unknown) top-level key. `mutate` receives the current gateways and
// returns the next set; the result is schema-validated before it lands. The
// write is atomic (temp file + rename) and refuses to clobber a config.json
// that exists but doesn't parse as a JSON object, so a hand-edit typo surfaces
// as an error instead of silent data loss. Honors KEELSON_CONFIG like the reader.
export function updateKeelsonConfigGateways(
  mutate: (gateways: GatewayConfig[]) => GatewayConfig[],
  home: string = resolveKeelsonHome(),
): GatewayConfig[] {
  const path = process.env.KEELSON_CONFIG?.trim() || join(home, CONFIG_FILE_NAME);
  let rawObj: Record<string, unknown> = {};
  let existing: string | undefined;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (err) {
      throw new Error(`refusing to overwrite ${path}: not valid JSON (${(err as Error).message})`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`refusing to overwrite ${path}: not a JSON object`);
    }
    rawObj = parsed as Record<string, unknown>;
  }
  const next = z.array(gatewayConfigSchema).parse(mutate(readGatewayArray(rawObj.gateways)));
  if (next.length > 0) rawObj.gateways = next;
  else delete rawObj.gateways;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rawObj, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return next;
}
