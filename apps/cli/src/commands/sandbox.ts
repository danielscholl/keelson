// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKeelsonConfig, resolveSandboxConfig } from "@keelson/shared/config";
import {
  MXC_SDK_PACKAGE,
  MXC_SDK_VERSION,
  type MxcExecutorResolution,
  probeMxcExecutor,
  resetMxcExecutorCache,
  resolveMxcExecutor,
} from "@keelson/shared/launcher";
import { runBunPm } from "../bun-pm.ts";
import { EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { ensureHome, resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";

interface BaseOptions {
  json: boolean;
}

export interface SandboxStatus {
  // Whether a turn or node that does not choose is sandboxed, and whether
  // KEELSON_SANDBOX=required holds every one on.
  default: boolean;
  floor: boolean;
  executor: MxcExecutorResolution;
  probe?: { ok: true } | { ok: false; detail: string };
}

export interface SandboxStatusDeps {
  resolve?: () => MxcExecutorResolution;
  probe?: (path: string) => Promise<{ ok: true } | { ok: false; detail: string }>;
  sandboxConfig?: () => { default: boolean; floor: boolean };
}

export async function collectSandboxStatus(deps: SandboxStatusDeps = {}): Promise<SandboxStatus> {
  const config = (deps.sandboxConfig ?? (() => resolveSandboxConfig(loadKeelsonConfig())))();
  const executor = (deps.resolve ?? (() => resolveMxcExecutor({})))();
  return {
    default: config.default,
    floor: config.floor,
    executor,
    ...(executor.ok ? { probe: await (deps.probe ?? probeMxcExecutor)(executor.path) } : {}),
  };
}

// Pins the SDK to the peer range the running @keelson/cli was released with,
// like `provider add`; a source checkout falls back to the verified version.
export function sandboxInstallSpec(home: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(home, "node_modules", "@keelson", "cli", "package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    const range = manifest.peerDependencies?.[MXC_SDK_PACKAGE];
    if (range) return `${MXC_SDK_PACKAGE}@${range}`;
  } catch {
    // no release manifest: a source checkout
  }
  return `${MXC_SDK_PACKAGE}@${MXC_SDK_VERSION}`;
}

// One line for `/sandbox status`: the executor and its dry run, or why there is none.
export function sandboxRuntimeLine(status: SandboxStatus): string {
  if (!status.executor.ok) {
    return `unavailable — ${status.executor.reason}; ${status.executor.installHint}`;
  }
  const version = status.executor.version ? ` ${status.executor.version}` : "";
  const probe =
    status.probe?.ok === false ? `dry run failed — ${status.probe.detail}` : "dry run passed";
  return `seatbelt via ${status.executor.path}${version}; ${probe}`;
}

function statusLines(status: SandboxStatus): string[] {
  const mode = status.floor
    ? "required (KEELSON_SANDBOX=required)"
    : status.default
      ? "on by default"
      : "off by default";
  const lines = [`sandbox: ${mode}`];
  if (status.executor.ok) {
    const version = status.executor.version ? ` ${status.executor.version}` : "";
    lines.push(
      `runtime: seatbelt via ${status.executor.path}${version} (${status.executor.source})`,
    );
    lines.push(
      status.probe?.ok === false
        ? `probe: failed — ${status.probe.detail}`
        : "probe: dry run passed",
    );
  } else {
    lines.push(`runtime: unavailable — ${status.executor.reason}`);
    lines.push(`fix: ${status.executor.installHint}`);
  }
  return lines;
}

export async function runSandboxStatus(opts: BaseOptions): Promise<never> {
  const status = await collectSandboxStatus();
  if (opts.json) emit({ data: status }, { json: true });
  else process.stdout.write(`${statusLines(status).join("\n")}\n`);
  process.exit(EXIT_OK);
}

export async function runSandboxInstall(opts: BaseOptions): Promise<never> {
  if (process.platform !== "darwin") {
    emit(
      {
        error: `the Keelson sandbox runtime supports macOS only (this host is ${process.platform})`,
        code: "UNSUPPORTED_PLATFORM",
      },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  const home = ensureHome();
  const before = resolveMxcExecutor({});
  const alreadyInstalled = before.ok && before.source === "package";
  const spec = sandboxInstallSpec(home);
  if (!alreadyInstalled) {
    const code = await runBunPm(["add", spec], home, opts.json);
    if (code !== 0) {
      emit(
        { error: `bun add ${spec} failed (exit ${code})`, code: "INSTALL_FAILED" },
        { json: opts.json },
      );
      process.exit(EXIT_FAIL);
    }
  }
  resetMxcExecutorCache();
  const status = await collectSandboxStatus();
  if (!status.executor.ok) {
    // bun blocks the SDK's native postinstall by default; the standalone
    // executor does not need it, so mention it only when the binary is missing.
    emit(
      {
        error: `${spec} installed but the executor is unavailable: ${status.executor.reason}. If bun blocked a postinstall, run \`bun pm untrusted\` in ${resolveKeelsonHome()}`,
        code: "EXECUTOR_MISSING",
      },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  if (opts.json) {
    emit({ data: { package: spec, alreadyInstalled, ...status } }, { json: true });
  } else {
    process.stdout.write(`${alreadyInstalled ? "already installed" : `added ${spec}`}\n`);
    process.stdout.write(`${statusLines(status).join("\n")}\n`);
    process.stdout.write("restart the server (`keelson restart`) to use it\n");
  }
  process.exit(status.probe?.ok === false ? EXIT_FAIL : EXIT_OK);
}
