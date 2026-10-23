// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSpawnPath } from "./exec.ts";
import { resolveKeelsonHome } from "./paths.ts";
import type { SandboxProfile } from "./sandbox.ts";

// `@keelson/workflows` mirrors these three types structurally in
// `handlers/launcher.ts` (it has no dependency on this package); keep them in step.

export interface SpawnSpec {
  cmd: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SpawnHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface ProcessLauncher {
  readonly id: "host" | "mxc";
  // Throws synchronously when the process cannot start (ENOENT and the like).
  spawn(spec: SpawnSpec): SpawnHandle;
}

const IS_WINDOWS = process.platform === "win32";

export const hostLauncher: ProcessLauncher = {
  id: "host",
  spawn(spec) {
    return Bun.spawn([spec.cmd, ...spec.args], {
      cwd: spec.cwd,
      env: ensureSpawnPath({ ...spec.env }),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
      // A POSIX process group lets the caller signal `-pid` to reap a daemonizing
      // grandchild. On Windows Bun's `detached` drops piped stdout/stderr, so it stays off.
      // biome-ignore lint/suspicious/noTsIgnore: Bun supports `detached` at runtime; types lag.
      // @ts-ignore
      detached: !IS_WINDOWS,
    });
  },
};

// POSIX `sh` quoting: every token single-quoted, an embedded `'` closed, escaped, reopened.
export function shellJoin(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

// ── MXC (macOS Seatbelt) runtime ────────────────────────────────────────────

export const MXC_SDK_PACKAGE = "@microsoft/mxc-sdk";
// The SDK version the Seatbelt executor's behavior was verified against: no
// process timeout keeps the child in the executor's process group, stdout
// streams through, and launch failures arrive as "Request error" or a JSON envelope.
export const MXC_SDK_VERSION = "1.0.1";
export const MXC_INSTALL_HINT = "run `keelson sandbox install`";
// Seatbelt via MXC needs macOS 15 (Darwin 24) or later.
const MIN_DARWIN_MAJOR = 24;

export type MxcExecutorResolution =
  | { ok: true; path: string; version?: string; source: "env" | "package" }
  | { ok: false; reason: string; installHint: string };

export interface ResolveMxcExecutorOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  arch?: string;
  release?: string;
  exists?: (path: string) => boolean;
  // Absolute path of the SDK's package.json; throws when it is not installed.
  resolvePackageJson?: () => string;
  readVersion?: (packageJsonPath: string) => string | undefined;
}

let memoizedExecutor: MxcExecutorResolution | undefined;

// KEELSON_MXC_EXEC wins (dev builds), then the executor inside the installed SDK.
// Resolution is memoized for the process when called without injected options.
export function resolveMxcExecutor(opts?: ResolveMxcExecutorOptions): MxcExecutorResolution {
  if (opts === undefined && memoizedExecutor !== undefined) return memoizedExecutor;
  const resolved = resolveMxcExecutorUncached(opts ?? {});
  if (opts === undefined) memoizedExecutor = resolved;
  return resolved;
}

function resolveMxcExecutorUncached(opts: ResolveMxcExecutorOptions): MxcExecutorResolution {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const exists = opts.exists ?? existsSync;
  const override = env.KEELSON_MXC_EXEC?.trim();
  if (override) {
    return exists(override)
      ? { ok: true, path: override, source: "env" }
      : {
          ok: false,
          reason: `KEELSON_MXC_EXEC points at '${override}', which does not exist`,
          installHint: "unset KEELSON_MXC_EXEC or point it at an mxc-exec-mac build",
        };
  }
  if (platform !== "darwin") {
    return {
      ok: false,
      reason: `the Keelson sandbox runtime supports macOS only (this host is ${platform})`,
      installHint: "set `sandbox: { enabled: false }` on the node or `sandbox.default: false`",
    };
  }
  const darwinMajor = Number.parseInt((opts.release ?? release()).split(".")[0] ?? "", 10);
  if (!Number.isFinite(darwinMajor) || darwinMajor < MIN_DARWIN_MAJOR) {
    return {
      ok: false,
      reason: "the Keelson sandbox runtime needs macOS 15 or later",
      installHint: "update macOS, or set `sandbox.default: false`",
    };
  }
  if (arch !== "arm64") {
    return {
      ok: false,
      reason: `${MXC_SDK_PACKAGE} ships mxc-exec-mac for Apple silicon only (this host is ${arch})`,
      installHint: "set KEELSON_MXC_EXEC to a local mxc-exec-mac build",
    };
  }
  let packageJson: string;
  try {
    packageJson = (opts.resolvePackageJson ?? defaultMxcPackageJson)();
  } catch {
    return {
      ok: false,
      reason: `${MXC_SDK_PACKAGE} is not installed`,
      installHint: MXC_INSTALL_HINT,
    };
  }
  const path = join(dirname(packageJson), "bin", "arm64", "mxc-exec-mac");
  if (!exists(path)) {
    return {
      ok: false,
      reason: `${MXC_SDK_PACKAGE} is installed but has no ${path}`,
      installHint: MXC_INSTALL_HINT,
    };
  }
  const version = (opts.readVersion ?? readPackageVersion)(packageJson);
  return { ok: true, path, source: "package", ...(version !== undefined ? { version } : {}) };
}

// Next to this module in a release (the home's node_modules); from a source
// checkout that resolves inside the repo, so the home's install is tried too.
function defaultMxcPackageJson(): string {
  try {
    return fileURLToPath(import.meta.resolve(`${MXC_SDK_PACKAGE}/package.json`));
  } catch (err) {
    const inHome = join(
      resolveKeelsonHome(),
      "node_modules",
      ...MXC_SDK_PACKAGE.split("/"),
      "package.json",
    );
    if (existsSync(inHome)) return inHome;
    throw err;
  }
}

// Forget a memoized resolution (after `keelson sandbox install` in the same process).
export function resetMxcExecutorCache(): void {
  memoizedExecutor = undefined;
}

// Validates a minimal config with `--dry-run` (a few milliseconds), proving the
// executor runs on this host without launching anything.
export async function probeMxcExecutor(
  executorPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), "keelson-mxc-probe-"));
  try {
    const configPath = join(dir, "probe.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: "1.0.0",
        containment: "seatbelt",
        process: { commandLine: "true", cwd: realpathOrSelf(dir) },
        filesystem: { readwritePaths: [realpathOrSelf(dir)], readonlyPaths: [], deniedPaths: [] },
      }),
      { mode: 0o600 },
    );
    const proc = Bun.spawn([executorPath, "--dry-run", configPath], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 5_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code === 0 && stdout.includes("validation passed")) return { ok: true };
    const detail = (stderr.trim() || stdout.trim()).split("\n").map(rewriteMxcStderrLine).join(" ");
    return { ok: false, detail: `dry run exited ${code}${detail ? `: ${detail}` : ""}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readPackageVersion(packageJsonPath: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown })
      .version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function canonicalPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    if (raw.split(/[\\/]/).includes("..")) {
      throw new Error(`sandbox path '${raw}' contains '..'`);
    }
    const path = realpathOrSelf(raw);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

// The executor's one-shot request (schema 1.0.0). No `process.timeout`: with
// one, the child moves to its own process group and a kill of the executor's
// group would orphan it, so keelson's runSubprocess stays the only kill authority.
export function buildMxcConfig(profile: SandboxProfile, spec: SpawnSpec): Record<string, unknown> {
  return {
    version: "1.0.0",
    containment: "seatbelt",
    process: {
      commandLine: shellJoin([spec.cmd, ...spec.args]),
      cwd: realpathOrSelf(spec.cwd),
      env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      inheritDefaultEnv: true,
    },
    filesystem: {
      readwritePaths: canonicalPaths(profile.filesystem.readwrite),
      readonlyPaths: canonicalPaths(profile.filesystem.readonly),
      deniedPaths: canonicalPaths(profile.filesystem.denied),
    },
    network: {
      egress: { default: profile.network.outbound },
      // Seatbelt cannot allow host loopback while inbound is denied, so loopback
      // opens inbound too (see mxcProfileWarnings).
      ingress: profile.network.loopback
        ? { default: "allow", hostLoopback: "allow" }
        : { default: "deny", hostLoopback: "deny" },
    },
  };
}

// Seatbelt filters egress all-or-nothing, so a host allowlist would silently
// widen to every destination.
export function mxcProfileRefusal(profile: SandboxProfile): string | undefined {
  return profile.network.outbound === "allow" && (profile.network.allowedHosts?.length ?? 0) > 0
    ? "the macOS sandbox cannot limit outbound traffic to network.allowedHosts; remove allowedHosts to allow all outbound, or keep outbound denied"
    : undefined;
}

export function mxcProfileWarnings(profile: SandboxProfile): string[] {
  return profile.network.loopback
    ? [
        "sandbox network.loopback on macOS also allows inbound connections; a listener bound to 0.0.0.0 is reachable from the network",
      ]
    : [];
}

// The executor reports its own failures as a "Request error" block (a config it
// cannot parse) or a final {"error":{...}} line (a backend refusal); rewrite
// those so a node's stderr tail reads as a launch failure, not a script error.
export function rewriteMxcStderrLine(line: string): string {
  if (line === "Request error") return "sandbox launch failed: the executor rejected its config";
  if (line.startsWith('{"error":')) {
    try {
      const message = (JSON.parse(line) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === "string") return `sandbox launch failed: ${message}`;
    } catch {
      // not the envelope after all
    }
  }
  return line;
}

// The executor's own lines are short; a longer partial line is the child's,
// so it passes through as it arrives instead of buffering without bound.
const MAX_PENDING_STDERR = 8192;

export function rewriteMxcStderr(
  stream: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  if (stream === null) return null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  // True while forwarding the rest of an oversized line unrewritten.
  let passthrough = false;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let text = decoder.decode(chunk, { stream: true });
        if (passthrough) {
          const nl = text.indexOf("\n");
          if (nl === -1) {
            controller.enqueue(encoder.encode(text));
            return;
          }
          controller.enqueue(encoder.encode(text.slice(0, nl + 1)));
          text = text.slice(nl + 1);
          passthrough = false;
        }
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines)
          controller.enqueue(encoder.encode(`${rewriteMxcStderrLine(line)}\n`));
        if (pending.length > MAX_PENDING_STDERR) {
          controller.enqueue(encoder.encode(pending));
          pending = "";
          passthrough = true;
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.length > 0) controller.enqueue(encoder.encode(rewriteMxcStderrLine(pending)));
      },
    }),
  );
}

export interface CreateMxcLauncherOptions {
  executorPath: string;
  scratchDir: string;
  // A directory no sandboxed process can write; the config must not be
  // rewritable between this write and the executor's read.
  launchDir: string;
  profile: SandboxProfile;
}

// Runs each spawn under the profile: the config goes to an exclusively created
// 0600 file in the launch dir (argv length and `ps` visibility rule out
// --config-base64), and the executor leads its own process group so keelson's
// `-pgid` kill reaches the sandboxed tree.
export function createMxcLauncher(opts: CreateMxcLauncherOptions): ProcessLauncher {
  return {
    id: "mxc",
    spawn(spec) {
      mkdirSync(opts.scratchDir, { recursive: true, mode: 0o700 });
      const configPath = join(opts.launchDir, `mxc-${randomBytes(8).toString("hex")}.json`);
      writeFileSync(configPath, JSON.stringify(buildMxcConfig(opts.profile, spec)), {
        mode: 0o600,
        flag: "wx",
      });
      const proc = Bun.spawn([opts.executorPath, configPath], {
        cwd: opts.scratchDir,
        // The executor never passes its own env to the child; it needs nothing.
        env: { PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        // biome-ignore lint/suspicious/noTsIgnore: Bun supports `detached` at runtime; types lag.
        // @ts-ignore
        detached: true,
      });
      const exited = proc.exited.finally(() => rmSync(configPath, { force: true }));
      return {
        pid: proc.pid,
        stdout: proc.stdout,
        stderr: rewriteMxcStderr(proc.stderr),
        exited,
        kill: (signal) => proc.kill(signal),
      };
    },
  };
}

// Structural mirror of `@keelson/workflows`'s SandboxRuntime.
export interface MxcRuntime {
  readonly backend: "seatbelt";
  createLauncher(profile: SandboxProfile, scratch: string, launchDir: string): ProcessLauncher;
  warnings(profile: SandboxProfile): string[];
  refusal(profile: SandboxProfile): string | undefined;
}

export function createMxcRuntime(opts: { executorPath: string }): MxcRuntime {
  return {
    backend: "seatbelt",
    createLauncher: (profile, scratch, launchDir) =>
      createMxcLauncher({
        executorPath: opts.executorPath,
        scratchDir: scratch,
        launchDir,
        profile,
      }),
    warnings: mxcProfileWarnings,
    refusal: mxcProfileRefusal,
  };
}
