// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { parseManifestRibDeps } from "./home.ts";
import {
  findRelease,
  installedRibVersion,
  isReleaseTag,
  newestRelease,
  parseRibSource,
  pinnedSpec,
  type ReleaseTag,
  type ResolveTags,
  ribIdFromPackage,
} from "./rib-version.ts";

export type RibPlanStatus =
  // Moves the rib to a different release.
  | "updated"
  // Already at that version; the manifest gains the explicit pin.
  | "pinned"
  // Pinned and already newest.
  | "current"
  // Pinned to something that is not a release tag: an operator opt-out.
  | "tracking"
  // Not a git remote (npm name, local path, tarball) — releases do not apply.
  | "unpinnable"
  | "no-releases"
  | "unreachable"
  | "not-found";

export interface RibPlanEntry {
  id: string;
  pkg: string;
  source: string;
  installed: string | null;
  target: ReleaseTag | null;
  status: RibPlanStatus;
  reason?: string;
}

// Statuses that rewrite the manifest, as opposed to the ones that only report.
const MOVES: ReadonlySet<RibPlanStatus> = new Set<RibPlanStatus>(["updated", "pinned"]);

export function isMove(entry: RibPlanEntry): boolean {
  return MOVES.has(entry.status) && entry.target !== null;
}

// Only states where the answer is unknown, never ones where it is a legitimate
// "nothing to move to". `tracking` and `unpinnable` are operator choices, and a
// rib with no tags yet would otherwise fail every update forever; an
// unreachable repo is the one case where reporting success would be a claim we
// did not verify.
const PROBLEMS: ReadonlySet<RibPlanStatus> = new Set<RibPlanStatus>(["unreachable", "not-found"]);

export function isProblem(entry: RibPlanEntry): boolean {
  return PROBLEMS.has(entry.status);
}

export interface PlanOptions {
  home: string;
  manifestText: string;
  // Rib ids to consider; empty or absent means every rib in the manifest.
  only?: readonly string[];
  // An explicit version to move to, in place of "the newest release".
  to?: string;
  allowPrerelease: boolean;
  resolveTags: ResolveTags;
}

export async function planRibUpdates(opts: PlanOptions): Promise<RibPlanEntry[]> {
  const deps = [...parseManifestRibDeps(opts.manifestText)].sort(([a], [b]) => a.localeCompare(b));
  const wanted = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const selected = deps.filter(([pkg]) => wanted === null || wanted.has(ribIdFromPackage(pkg)));

  return await Promise.all(selected.map(([pkg, source]) => planOne(pkg, source, opts)));
}

async function planOne(pkg: string, source: string, opts: PlanOptions): Promise<RibPlanEntry> {
  const id = ribIdFromPackage(pkg);
  const installed = installedRibVersion(opts.home, pkg);
  const base: Omit<RibPlanEntry, "status"> = { id, pkg, source, installed, target: null };

  const parsed = parseRibSource(source);
  if (parsed === null) return { ...base, status: "unpinnable" };

  // A ref the operator set to something other than a release tag (a branch, a
  // commit) is a deliberate opt-out; only an explicit `--to` overrides it.
  if (parsed.ref !== null && !isReleaseTag(parsed.ref) && opts.to === undefined) {
    return { ...base, status: "tracking" };
  }

  const resolution = await opts.resolveTags(parsed.url);
  if (resolution.kind === "unreachable") {
    return { ...base, status: "unreachable", reason: resolution.reason };
  }

  const target =
    opts.to === undefined
      ? newestRelease(resolution.tags, opts.allowPrerelease)
      : findRelease(resolution.tags, opts.to);
  if (target === null) {
    return opts.to === undefined
      ? { ...base, status: "no-releases" }
      : { ...base, status: "not-found", reason: `no release ${opts.to} in ${parsed.url}` };
  }

  if (parsed.ref === target.tag) return { ...base, target, status: "current" };
  return { ...base, target, status: installed === target.version ? "pinned" : "updated" };
}

// Rewrites only the rib deps that move, leaving every other dependency (the
// harness pins, the provider SDKs) exactly as it found them.
export function applyRibPins(manifestText: string, entries: readonly RibPlanEntry[]): string {
  const manifest = JSON.parse(manifestText) as {
    dependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  const dependencies = { ...manifest.dependencies };
  for (const entry of entries) {
    if (!isMove(entry)) continue;
    const parsed = parseRibSource(entry.source);
    if (parsed === null || entry.target === null) continue;
    dependencies[entry.pkg] = pinnedSpec(parsed, entry.target.tag);
  }
  return `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`;
}
