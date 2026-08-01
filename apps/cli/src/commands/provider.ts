// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isOnDemandProvider,
  isProviderSdkInstalled,
  ON_DEMAND_PROVIDER_PACKAGES,
  onDemandProviderIds,
} from "@keelson/providers";
import {
  BUILT_IN_PROVIDER_IDS,
  loadKeelsonConfig,
  resolveEnabledProviders,
  updateKeelsonConfigProviders,
} from "@keelson/shared/config";
import { runBunPm } from "../bun-pm.ts";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { ensureHome, resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";
import { probeServer } from "../server-probe.ts";

interface BaseOptions {
  json: boolean;
  baseUrl?: string;
}

type ProviderStatus = "bundled" | "installed" | "not installed";

function statusOf(id: string): ProviderStatus {
  if (!isOnDemandProvider(id)) return "bundled";
  return isProviderSdkInstalled(id) ? "installed" : "not installed";
}

// The install ranges are the peer ranges of the @keelson/cli the operator is
// actually running, so `provider add` can never pull an SDK major the installed
// harness wasn't built against. A source checkout has no such manifest and
// already carries the SDKs as devDependencies, so a bare name is the right
// fallback there.
export function installSpecs(id: string, home: string): string[] {
  const packages = ON_DEMAND_PROVIDER_PACKAGES[id] ?? [];
  let ranges: Record<string, string> = {};
  try {
    const manifest = JSON.parse(
      readFileSync(join(home, "node_modules", "@keelson", "cli", "package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    ranges = manifest.peerDependencies ?? {};
  } catch {
    ranges = {};
  }
  return packages.map((pkg) => (ranges[pkg] ? `${pkg}@${ranges[pkg]}` : pkg));
}

function unknownProvider(id: string, opts: BaseOptions): never {
  emit(
    {
      error: `unknown provider '${id}' — installable providers: ${onDemandProviderIds().join(", ")}`,
      code: "BAD_INPUTS",
    },
    { json: opts.json },
  );
  process.exit(EXIT_BAD_ARGS);
}

export async function runProviderList(opts: BaseOptions): Promise<never> {
  const config = loadKeelsonConfig();
  const enabled = new Set(
    resolveEnabledProviders({
      config,
      envProviders: process.env.KEELSON_PROVIDERS,
      known: BUILT_IN_PROVIDER_IDS,
    }),
  );
  const providers = BUILT_IN_PROVIDER_IDS.map((id) => ({
    id,
    status: statusOf(id),
    enabled: enabled.has(id),
  }));
  emit({ data: { providers, home: resolveKeelsonHome() } }, { json: opts.json });
  if (!opts.json) {
    const missing = providers.filter((p) => p.status === "not installed").map((p) => p.id);
    if (missing.length > 0) {
      process.stdout.write(`\nadd one with: keelson provider add <${missing.join("|")}>\n`);
    }
  }
  process.exit(EXIT_OK);
}

export async function runProviderAdd(id: string, opts: BaseOptions): Promise<never> {
  const trimmed = id.trim();
  if (!isOnDemandProvider(trimmed)) unknownProvider(trimmed, opts);
  const home = ensureHome();
  const specs = installSpecs(trimmed, home);
  const alreadyInstalled = isProviderSdkInstalled(trimmed);
  if (!alreadyInstalled) {
    const code = await runBunPm(["add", ...specs], home, opts.json);
    if (code !== 0) {
      emit(
        { error: `bun add ${specs.join(" ")} failed (exit ${code})`, code: "INSTALL_FAILED" },
        { json: opts.json },
      );
      process.exit(EXIT_FAIL);
    }
  }
  updateKeelsonConfigProviders({ [trimmed]: true }, home);
  const server = await probeServer(opts.baseUrl ? { baseUrl: opts.baseUrl } : {});
  emit(
    {
      data: {
        provider: trimmed,
        packages: specs,
        alreadyInstalled,
        enabled: true,
        restartRequired: server !== null,
      },
    },
    { json: opts.json },
  );
  if (!opts.json) {
    process.stdout.write(
      alreadyInstalled ? `${trimmed} already installed; enabled\n` : `added ${trimmed}\n`,
    );
    if (server !== null) {
      process.stdout.write("restart the server (`keelson restart`) to activate it\n");
    }
  }
  process.exit(EXIT_OK);
}

export async function runProviderRemove(id: string, opts: BaseOptions): Promise<never> {
  const trimmed = id.trim();
  if (!isOnDemandProvider(trimmed)) unknownProvider(trimmed, opts);
  const home = resolveKeelsonHome();
  const packages = ON_DEMAND_PROVIDER_PACKAGES[trimmed] ?? [];
  const code = await runBunPm(["remove", ...packages], home, opts.json);
  if (code !== 0) {
    emit(
      { error: `bun remove ${packages.join(" ")} failed (exit ${code})`, code: "REMOVE_FAILED" },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  updateKeelsonConfigProviders({ [trimmed]: false }, home);
  const server = await probeServer(opts.baseUrl ? { baseUrl: opts.baseUrl } : {});
  emit(
    {
      data: {
        provider: trimmed,
        packages: [...packages],
        enabled: false,
        restartRequired: server !== null,
      },
    },
    { json: opts.json },
  );
  if (!opts.json) {
    process.stdout.write(`removed ${trimmed}\n`);
    if (server !== null) {
      process.stdout.write("restart the server (`keelson restart`) to deactivate it\n");
    }
  }
  process.exit(EXIT_OK);
}
