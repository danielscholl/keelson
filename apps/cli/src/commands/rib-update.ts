// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { runBunPmCaptured } from "../bun-pm.ts";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import {
  readManifestText,
  resolveKeelsonHome,
  restoreHome,
  snapshotHome,
  writeManifestText,
} from "../home.ts";
import { emit } from "../output.ts";
import { applyRibPins, isMove, isProblem, planRibUpdates, type RibPlanEntry } from "../rib-plan.ts";
import {
  checkHarnessCompat,
  installedRibVersion,
  lsRemoteTags,
  type ResolveTags,
  ribIdFromPackage,
} from "../rib-version.ts";
import { probeServer } from "../server-probe.ts";

export interface IncompatibleRib {
  id: string;
  version: string | null;
  range: string;
  harness: string;
}

export interface RibUpdatePassOptions {
  home: string;
  only?: readonly string[];
  to?: string;
  allowPrerelease: boolean;
  check: boolean;
  quiet: boolean;
  resolveTags?: ResolveTags;
}

export interface RibUpdatePass {
  entries: RibPlanEntry[];
  moved: RibPlanEntry[];
  applied: boolean;
  installError: string | null;
  incompatible: IncompatibleRib[];
}

// A rib activates at boot, so an install that requires a newer harness is not a
// crash here — it is a rib that will fail validation on the next start. Naming
// it now, with the version to roll back to, is the difference between that and
// a silent skip in the boot log.
function verifyCompat(home: string, moved: readonly RibPlanEntry[]): IncompatibleRib[] {
  const incompatible: IncompatibleRib[] = [];
  for (const entry of moved) {
    const verdict = checkHarnessCompat(home, entry.pkg);
    if (verdict === null || verdict.compatible) continue;
    incompatible.push({
      id: entry.id,
      version: installedRibVersion(home, entry.pkg),
      range: verdict.range,
      harness: verdict.harness,
    });
  }
  return incompatible;
}

export async function runRibUpdatePass(opts: RibUpdatePassOptions): Promise<RibUpdatePass> {
  const manifestText = readManifestText(opts.home);
  const entries = await planRibUpdates({
    home: opts.home,
    manifestText,
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.to !== undefined ? { to: opts.to } : {}),
    allowPrerelease: opts.allowPrerelease,
    resolveTags: opts.resolveTags ?? lsRemoteTags,
  });
  const moved = entries.filter(isMove);

  if (opts.check || moved.length === 0) {
    return { entries, moved: [], applied: false, installError: null, incompatible: [] };
  }

  const snapshot = snapshotHome(opts.home);
  writeManifestText(opts.home, applyRibPins(manifestText, moved));
  const install = await runBunPmCaptured(["install"], opts.home, opts.quiet);
  if (install.code !== 0) {
    // The manifest is the only record of which version is installed, so a home
    // left holding pins bun rejected would report versions it does not have.
    restoreHome(opts.home, snapshot);
    await runBunPmCaptured(["install"], opts.home, opts.quiet);
    const detail = install.stderr.trim().split("\n").at(-1)?.trim();
    return {
      entries,
      moved: [],
      applied: false,
      installError: detail
        ? `${detail} (exit ${install.code})`
        : `bun install exited ${install.code}`,
      incompatible: [],
    };
  }

  return {
    entries,
    moved,
    applied: true,
    installError: null,
    incompatible: verifyCompat(opts.home, moved),
  };
}

export function describeEntry(entry: RibPlanEntry): string {
  switch (entry.status) {
    case "updated":
      return `${entry.id} ${entry.installed ?? "unknown"} → ${entry.target?.version}`;
    case "pinned":
      return `${entry.id} pinned to v${entry.target?.version} (was tracking the default branch)`;
    case "current":
      return `${entry.id} v${entry.target?.version} (already newest)`;
    case "tracking":
      return `${entry.id} tracking ${trackedRef(entry.source)} (unpinned; --to overrides)`;
    case "unpinnable":
      return `${entry.id} installed from ${entry.source}, which has no releases to track`;
    case "no-releases":
      return `${entry.id} has no release tags yet`;
    case "unreachable":
      return `${entry.id} could not be reached: ${entry.reason}`;
    case "not-found":
      return `${entry.id}: ${entry.reason}`;
  }
}

function trackedRef(source: string): string {
  const hash = source.indexOf("#");
  return hash === -1 ? "the default branch" : source.slice(hash + 1);
}

export interface RibUpdateOptions {
  json: boolean;
  check: boolean;
  pre: boolean;
  to?: string;
  baseUrl?: string;
}

function fail(message: string, code: string, json: boolean, exit: number): never {
  emit({ error: message, code }, { json });
  process.exit(exit);
}

export async function runRibUpdate(ids: string[], opts: RibUpdateOptions): Promise<never> {
  const home = resolveKeelsonHome();
  let manifestText: string;
  try {
    manifestText = readManifestText(home);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    fail(`no keelson home at ${home}`, "NOT_INSTALLED", opts.json, EXIT_FAIL);
  }

  if (opts.to !== undefined && ids.length !== 1) {
    fail("--to needs exactly one rib id", "BAD_INPUTS", opts.json, EXIT_BAD_ARGS);
  }

  const known = new Set(
    Object.keys(
      (JSON.parse(manifestText) as { dependencies?: Record<string, string> }).dependencies ?? {},
    )
      .filter((name) => name.startsWith("@keelson/rib-"))
      .map(ribIdFromPackage),
  );
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    fail(`not installed: ${unknown.join(", ")}`, "NOT_FOUND", opts.json, EXIT_NOT_FOUND);
  }

  const pass = await runRibUpdatePass({
    home,
    only: ids,
    ...(opts.to !== undefined ? { to: opts.to } : {}),
    allowPrerelease: opts.pre,
    check: opts.check,
    quiet: opts.json,
  });

  if (pass.installError !== null) {
    fail(
      `rib update failed and the home was rolled back: ${pass.installError}`,
      "INSTALL_FAILED",
      opts.json,
      EXIT_FAIL,
    );
  }

  const pending = opts.check ? pass.entries.filter(isMove) : [];
  const problems = pass.entries.filter(isProblem);
  const server = pass.applied
    ? await probeServer(opts.baseUrl ? { baseUrl: opts.baseUrl } : {})
    : null;

  emit(
    {
      data: {
        home,
        ribs: pass.entries.map((e) => ({
          id: e.id,
          status: e.status,
          from: e.installed,
          to: e.target?.version ?? null,
          tag: e.target?.tag ?? null,
          ...(e.reason ? { reason: e.reason } : {}),
        })),
        updated: pass.moved.map((e) => e.id),
        ...(pass.incompatible.length > 0 ? { incompatible: pass.incompatible } : {}),
        restartRequired: server !== null,
      },
    },
    { json: opts.json },
  );

  if (!opts.json) {
    if (pass.entries.length === 0) process.stdout.write("no ribs installed\n");
    for (const entry of pass.entries) process.stdout.write(`${describeEntry(entry)}\n`);
    // Only claim there is nothing to update when every rib was actually
    // checked; saying it after a rib we could not read describes a search that
    // did not happen.
    if (opts.check && pending.length === 0 && pass.entries.length > 0 && problems.length === 0) {
      process.stdout.write("\nno rib updates available\n");
    }
    for (const rib of pass.incompatible) {
      process.stdout.write(
        `warning: ${rib.id} v${rib.version} needs @keelson/shared ${rib.range}, but this home has ${rib.harness} — it will be skipped at boot; roll back with \`keelson rib update ${rib.id} --to <version>\`\n`,
      );
    }
    if (server !== null) {
      process.stdout.write("restart the server (`keelson restart`) to load the update\n");
    }
  }

  // A rib that could not be reached is not an update that succeeded: exiting 0
  // here would let a scripted update report clean while silently skipping it.
  process.exit(problems.length > 0 ? EXIT_FAIL : EXIT_OK);
}
