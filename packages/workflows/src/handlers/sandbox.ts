// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, normalize, relative, resolve } from "node:path";

import type { NodeContext, NodeResult, SandboxOutcome } from "../executor.ts";
import type { NodeSandbox } from "../schema/index.ts";
import type { ProcessLauncher } from "./launcher.ts";

// Structural mirror of `@keelson/shared`'s SandboxProfile; a server test keeps
// the two assignable to each other.
export interface SandboxProfile {
  enabled: boolean;
  filesystem: { readwrite: string[]; readonly: string[]; denied: string[] };
  network: {
    outbound: "allow" | "deny";
    loopback?: boolean | undefined;
    allowedHosts?: string[] | undefined;
  };
  env: string[];
  backend?:
    | {
        copilot?: Record<string, unknown> | undefined;
        claude?: Record<string, unknown> | undefined;
        codex?: { mode?: "read-only" | "workspace-write" | "danger-full-access" | undefined };
        pi?: Record<string, unknown> | undefined;
      }
    | undefined;
}

// What PR-later runtimes implement: a backend name for observability and a
// launcher that runs a node's process under the profile.
export interface SandboxRuntime {
  readonly backend: string;
  createLauncher(profile: SandboxProfile, scratch: string): ProcessLauncher;
}

export interface SandboxResolution {
  // Null when the node runs unconfined.
  profile: SandboxProfile | null;
  outcome: SandboxOutcome;
  backend?: string;
  // Set when the sandbox is on but cannot be enforced; the node fails with it.
  fail?: string;
}

export interface SandboxResolveContext {
  cwd: string;
  artifactsDir?: string;
  workflowSandbox?: NodeSandbox;
  // Prompt nodes are confined by their provider, not the runtime; this carries
  // the provider's capability mirror and id.
  provider?: { id: string; support: "native" | "tool" | "none" };
}

export interface SandboxPolicy {
  resolve(nodeSandbox: NodeSandbox | undefined, ctx: SandboxResolveContext): SandboxResolution;
  launcherFor(profile: SandboxProfile, scratch: string): ProcessLauncher;
  // The env a sandboxed process gets; see pickSandboxEnv.
  envFor(
    env: Readonly<Record<string, string>>,
    profile: SandboxProfile,
    scratch: string,
  ): Record<string, string>;
}

export interface CreateSandboxPolicyOptions {
  // KEELSON_SANDBOX=required: every node is sandboxed and `enabled: false` is ignored.
  floor: boolean;
  // Whether a node that does not choose is sandboxed. An explicit choice wins.
  defaultEnabled: boolean;
  runtime?: SandboxRuntime;
  // Why `runtime` is absent, for the fail-closed message.
  unavailableReason?: string;
  // config.sandbox.profile: the operator's overlay on the built-in default.
  configProfile?: Omit<NodeSandbox, "enabled">;
  // config.sandbox.denied: appended after every author grant.
  operatorDenied?: readonly string[];
  // The keelson home, and its database path.
  home: string;
  dbPath: string;
  bundledBinDir: string;
  resolveGitCommonDir?: (cwd: string) => string | undefined;
  hostHome?: string;
  hostPath?: string;
  exists?: (path: string) => boolean;
  canonical?: (path: string) => string;
}

const TOOLCHAIN_PREFIXES = [
  "/opt/homebrew",
  "/usr/local",
  "~/.bun",
  "~/.cargo",
  "~/.rustup",
  "~/.local",
  "~/.nvm",
  "~/.volta",
  "~/.pyenv",
  "/nix",
];

const HOST_DENIED = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.gnupg",
  "~/.config/gh",
  "~/.config/glab-cli",
  "~/.docker",
  "~/.kube",
  "~/.netrc",
  "~/.npmrc",
  "~/Library/Keychains",
  "~/.claude",
  "~/.codex",
  "~/.copilot",
];

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPathError";
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function union(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) if (!out.includes(item)) out.push(item);
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// `~` expands against the host home, a relative path against cwd; any `..`
// segment is refused so a grant cannot climb out of what the author wrote.
export function resolveSandboxPath(raw: string, opts: { cwd: string; hostHome: string }): string {
  if (raw.split(/[\\/]/).includes("..")) {
    throw new SandboxPathError(`sandbox path '${raw}' contains '..'; write the path it means`);
  }
  if (raw === "~") return opts.hostHome;
  if (raw.startsWith("~/")) return join(opts.hostHome, raw.slice(2));
  return normalize(isAbsolute(raw) ? raw : resolve(opts.cwd, raw));
}

// Merges a YAML or operator block over a profile: `enabled` and network fields
// override, path lists and env union, backend keys merge per SDK.
export function mergeSandboxProfiles(
  base: SandboxProfile,
  override: NodeSandbox | Omit<NodeSandbox, "enabled"> | undefined,
  opts: { cwd: string; hostHome: string },
): SandboxProfile {
  if (override === undefined) return base;
  const paths = (list: readonly string[] | undefined) =>
    (list ?? []).map((raw) => resolveSandboxPath(raw, opts));
  const fs = override.filesystem;
  const backend = mergeBackend(base.backend, override.backend);
  return {
    enabled:
      "enabled" in override && override.enabled !== undefined ? override.enabled : base.enabled,
    filesystem: {
      readwrite: union(base.filesystem.readwrite, paths(fs?.readwrite)),
      readonly: union(base.filesystem.readonly, paths(fs?.readonly)),
      denied: union(base.filesystem.denied, paths(fs?.denied)),
    },
    network: {
      ...base.network,
      ...(override.network?.outbound !== undefined ? { outbound: override.network.outbound } : {}),
      ...(override.network?.loopback !== undefined ? { loopback: override.network.loopback } : {}),
      ...(override.network?.allowedHosts !== undefined
        ? { allowedHosts: [...override.network.allowedHosts] }
        : {}),
    },
    env: union(base.env, override.env),
    ...(backend !== undefined ? { backend } : {}),
  };
}

function mergeBackend(
  base: SandboxProfile["backend"],
  override: NodeSandbox["backend"],
): SandboxProfile["backend"] {
  if (override === undefined) return base;
  const out: NonNullable<SandboxProfile["backend"]> = { ...(base ?? {}) };
  for (const key of ["copilot", "claude", "codex", "pi"] as const) {
    const next = override[key] as Record<string, unknown> | undefined;
    if (next === undefined) continue;
    out[key] = { ...(base?.[key] ?? {}), ...next };
  }
  return out;
}

export interface DefaultSandboxProfileOptions {
  cwd: string;
  artifactsDir?: string;
  home: string;
  dbPath: string;
  bundledBinDir: string;
  hostHome: string;
  hostPath: string;
  gitCommonDir?: string;
  exists: (path: string) => boolean;
}

// The built-in profile a sandboxed bash or script node starts from, before the
// operator, workflow, and node blocks merge over it.
export function defaultSandboxProfile(opts: DefaultSandboxProfileOptions): SandboxProfile {
  const tilde = (p: string) => (p.startsWith("~/") ? join(opts.hostHome, p.slice(2)) : p);
  const readwrite = union(
    [opts.cwd],
    opts.artifactsDir !== undefined ? [opts.artifactsDir] : [],
    opts.gitCommonDir !== undefined && !isInside(opts.gitCommonDir, opts.cwd)
      ? [opts.gitCommonDir]
      : [],
  );
  const toolchains = TOOLCHAIN_PREFIXES.map(tilde).filter((p) => opts.exists(p));
  const pathDirs = opts.hostPath
    .split(delimiter)
    .filter((dir) => dir.length > 0 && isAbsolute(dir))
    .filter((dir) => !toolchains.some((prefix) => isInside(dir, prefix)));
  const readonly = union(
    [opts.bundledBinDir, join(opts.home, "scripts"), join(opts.home, "node_modules")],
    [join(opts.hostHome, ".gitconfig"), join(opts.hostHome, ".config", "git")],
    toolchains,
    pathDirs,
  );
  return {
    enabled: false,
    filesystem: {
      readwrite,
      readonly: readonly.filter((p) => !readwrite.some((rw) => isInside(p, rw))),
      denied: builtInDenied(opts),
    },
    network: { outbound: "deny" },
    env: [],
  };
}

function builtInDenied(opts: { home: string; dbPath: string; hostHome: string }): string[] {
  return union(
    HOST_DENIED.map((p) => join(opts.hostHome, p.slice(2))),
    [opts.dbPath, `${opts.dbPath}-wal`, `${opts.dbPath}-shm`, `${opts.dbPath}-journal`],
    [join(opts.home, "server.json"), join(opts.home, "config.json")],
  );
}

export function sandboxUnavailableMessage(reason: string, floor: boolean): string {
  const optOut = floor
    ? "unset `KEELSON_SANDBOX=required`, which ignores `enabled: false`"
    : "set `sandbox: { enabled: false }` on the node";
  return `sandbox required but unavailable: ${reason}; run \`keelson sandbox install\` or ${optOut}`;
}

export function createSandboxPolicy(opts: CreateSandboxPolicyOptions): SandboxPolicy {
  const hostHome = opts.hostHome ?? homedir();
  const hostPath = opts.hostPath ?? process.env.PATH ?? "";
  const exists = opts.exists ?? existsSync;
  const canonical = opts.canonical ?? realpathOrSelf;

  const canonicalize = (profile: SandboxProfile): SandboxProfile => ({
    ...profile,
    filesystem: {
      readwrite: union(profile.filesystem.readwrite.map(canonical)),
      readonly: union(profile.filesystem.readonly.map(canonical)),
      denied: union(profile.filesystem.denied.map(canonical)),
    },
  });

  return {
    resolve(nodeSandbox, ctx) {
      const enabled =
        opts.floor || (nodeSandbox?.enabled ?? ctx.workflowSandbox?.enabled ?? opts.defaultEnabled);
      if (!enabled) return { profile: null, outcome: "off" };
      const pathOpts = { cwd: ctx.cwd, hostHome };
      let profile: SandboxProfile;
      try {
        const gitCommonDir = (opts.resolveGitCommonDir ?? resolveGitCommonDir)(ctx.cwd);
        profile = defaultSandboxProfile({
          cwd: ctx.cwd,
          ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
          home: opts.home,
          dbPath: opts.dbPath,
          bundledBinDir: opts.bundledBinDir,
          hostHome,
          hostPath,
          ...(gitCommonDir !== undefined ? { gitCommonDir } : {}),
          exists,
        });
        profile = mergeSandboxProfiles(profile, opts.configProfile, pathOpts);
        profile = mergeSandboxProfiles(profile, ctx.workflowSandbox, pathOpts);
        profile = mergeSandboxProfiles(profile, nodeSandbox, pathOpts);
        profile = { ...profile, enabled: true };
        // Operator denies land last so no author grant can shadow them.
        profile = mergeSandboxProfiles(
          profile,
          { filesystem: { denied: [...(opts.operatorDenied ?? [])] } },
          pathOpts,
        );
      } catch (err) {
        if (!(err instanceof SandboxPathError)) throw err;
        return { profile: null, outcome: "off", fail: err.message };
      }
      profile = canonicalize(profile);

      if (ctx.provider !== undefined) {
        if (ctx.provider.support === "none") {
          return {
            profile,
            outcome: "off",
            fail: sandboxUnavailableMessage(
              `provider '${ctx.provider.id}' cannot sandbox its tools`,
              opts.floor,
            ),
          };
        }
        return { profile, outcome: "provider", backend: ctx.provider.id };
      }
      if (opts.runtime === undefined) {
        return {
          profile,
          outcome: "off",
          fail: sandboxUnavailableMessage(
            opts.unavailableReason ?? "no sandbox runtime is installed",
            opts.floor,
          ),
        };
      }
      return { profile, outcome: "mxc", backend: opts.runtime.backend };
    },
    launcherFor(profile, scratch) {
      if (opts.runtime === undefined) {
        throw new Error("launcherFor called without a sandbox runtime");
      }
      const withScratch = isCovered(scratch, profile.filesystem.readwrite)
        ? profile
        : {
            ...profile,
            filesystem: {
              ...profile.filesystem,
              readwrite: union(profile.filesystem.readwrite, [canonical(scratch)]),
            },
          };
      return opts.runtime.createLauncher(withScratch, scratch);
    },
    envFor(env, profile, scratch) {
      return pickSandboxEnv(env, { scratch, hostHome, allow: profile.env });
    },
  };
}

// `git rev-parse --git-common-dir` as an absolute path: a worktree commits into
// the main repository's .git. Undefined outside a repository or without git.
export function resolveGitCommonDir(cwd: string): string | undefined {
  try {
    const result = Bun.spawnSync(
      ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
    if (result.exitCode !== 0) return undefined;
    const dir = result.stdout.toString().trim();
    return dir.length > 0 ? dir : undefined;
  } catch {
    return undefined;
  }
}

// Structural mirror of `@keelson/shared/config`'s ResolvedSandboxConfig, the
// operator's resolved `sandbox` block plus KEELSON_SANDBOX.
export interface OperatorSandboxConfig {
  floor: boolean;
  default: boolean;
  settings: Omit<SandboxProfile, "enabled">;
}

// The policy both run paths (server and the CLI's offline fallback) build from
// operator config: its paths, network, env, and backend overlay the built-in
// node profile, and its denied paths land after every author grant.
export function createOperatorSandboxPolicy(
  config: OperatorSandboxConfig,
  deps: Pick<
    CreateSandboxPolicyOptions,
    "home" | "dbPath" | "bundledBinDir" | "runtime" | "unavailableReason" | "resolveGitCommonDir"
  >,
): SandboxPolicy {
  const { filesystem, network, env, backend } = config.settings;
  return createSandboxPolicy({
    ...deps,
    floor: config.floor,
    defaultEnabled: config.default,
    configProfile: {
      filesystem: { readwrite: filesystem.readwrite, readonly: filesystem.readonly },
      network: {
        outbound: network.outbound,
        ...(network.loopback !== undefined ? { loopback: network.loopback } : {}),
        ...(network.allowedHosts !== undefined ? { allowedHosts: network.allowedHosts } : {}),
      },
      env,
      ...(backend !== undefined ? { backend: backend as NodeSandbox["backend"] } : {}),
    },
    operatorDenied: filesystem.denied,
  });
}

export function sandboxContextFor(ctx: NodeContext): SandboxResolveContext {
  return {
    cwd: ctx.cwd,
    ...(ctx.artifactsDir !== undefined ? { artifactsDir: ctx.artifactsDir } : {}),
    ...(ctx.workflow.sandbox !== undefined ? { workflowSandbox: ctx.workflow.sandbox } : {}),
  };
}

// Stamps the decision onto a result; a handler built without a policy reports nothing.
export function tagSandboxResult(
  result: NodeResult,
  resolution: SandboxResolution | undefined,
): NodeResult {
  if (resolution === undefined) return result;
  return {
    ...result,
    sandbox: resolution.outcome,
    ...(resolution.backend !== undefined ? { sandboxBackend: resolution.backend } : {}),
  };
}

// The body rides in a file, never argv: a runtime may wrap the command in its
// own shell, and argv is length-limited and visible to `ps`.
export function writeSandboxBody(scratch: string, name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

function isCovered(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(path, root));
}

const SANDBOX_ENV_KEEP = new Set(["ARTIFACTS_DIR", "LANG", "LC_ALL", "TERM"]);

// The sandboxed process's env: the KEELSON_* channel and a few locale and PATH
// variables, plus names the profile allows; HOME, TMPDIR, and tool caches move
// into scratch. Everything else in the server's env (tokens, keys) is dropped.
export function pickSandboxEnv(
  env: Readonly<Record<string, string>>,
  opts: { scratch: string; hostHome: string; allow?: readonly string[] },
): Record<string, string> {
  const allow = new Set(opts.allow ?? []);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith("KEELSON_") ||
      SANDBOX_ENV_KEEP.has(key) ||
      key.toUpperCase() === "PATH" ||
      allow.has(key)
    ) {
      out[key] = value;
    }
  }
  out.HOME = join(opts.scratch, "home");
  out.TMPDIR = join(opts.scratch, "tmp");
  out.UV_CACHE_DIR = join(opts.scratch, "cache", "uv");
  out.BUN_INSTALL_CACHE_DIR = join(opts.scratch, "cache", "bun");
  out.GIT_CONFIG_GLOBAL = join(opts.hostHome, ".gitconfig");
  return out;
}

// `<artifactsDir>/sandbox/<nodeId>/` with home/ and tmp/ inside; a temp dir when
// the run has no artifacts dir.
export function prepareSandboxScratch(artifactsDir: string | undefined, nodeId: string): string {
  const safeId = nodeId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const scratch =
    artifactsDir !== undefined
      ? join(artifactsDir, "sandbox", safeId)
      : mkdtempSync(join(tmpdir(), `keelson-sandbox-${safeId}-`));
  for (const dir of ["home", "tmp", join("cache", "uv"), join("cache", "bun")]) {
    mkdirSync(join(scratch, dir), { recursive: true, mode: 0o700 });
  }
  return scratch;
}
