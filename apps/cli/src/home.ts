// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveKeelsonHome, resolveRibsRoot } from "@keelson/shared/paths";

export { resolveKeelsonHome };

// Ensure the keelson home exists as a minimal Bun project so `bun add` can
// install ribs into <home>/node_modules/@keelson. Idempotent: leaves an
// existing package.json untouched.
export function ensureHome(home: string = resolveKeelsonHome()): string {
  mkdirSync(home, { recursive: true });
  const pkgPath = join(home, "package.json");
  const pkg = { name: "keelson-home", private: true, dependencies: {} };
  try {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return home;
}

// The @keelson scope directory for home-local package mutations.
export function homeRibsDir(home: string = resolveKeelsonHome()): string {
  return join(home, "node_modules", "@keelson");
}

export function readManifestText(home: string = resolveKeelsonHome()): string {
  return readFileSync(join(home, "package.json"), "utf8");
}

export function writeManifestText(home: string, text: string): void {
  writeFileSync(join(home, "package.json"), text);
}

export function parseManifestRibDeps(text: string): Map<string, string> {
  const manifest = JSON.parse(text) as { dependencies?: Record<string, unknown> };
  const deps = new Map<string, string>();
  for (const [name, source] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith("@keelson/rib-") && typeof source === "string") {
      deps.set(name, source);
    }
  }
  return deps;
}

export function findDuplicateRibKeys(text: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const match of text.matchAll(/"(@keelson\/rib-[^"]+)"\s*:/g)) {
    const name = match[1];
    if (!name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates].sort();
}

export interface HomeSnapshot {
  manifestText: string;
  lockText: string | null;
}

export function snapshotHome(home: string = resolveKeelsonHome()): HomeSnapshot {
  const lockPath = join(home, "bun.lock");
  return {
    manifestText: readManifestText(home),
    lockText: existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null,
  };
}

export function restoreHome(home: string, snapshot: HomeSnapshot): void {
  writeManifestText(home, snapshot.manifestText);
  const lockPath = join(home, "bun.lock");
  if (snapshot.lockText === null) {
    rmSync(lockPath, { force: true });
  } else {
    writeFileSync(lockPath, snapshot.lockText);
  }
}

function ribIdsFromDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("rib-"))
    .map((name) => name.slice("rib-".length))
    .sort();
}

// Ids of rib-* packages installed in <home>/node_modules/@keelson only.
export function installedRibIds(home: string = resolveKeelsonHome()): string[] {
  return ribIdsFromDir(homeRibsDir(home));
}

// Read-only installed listing, matching server discovery's home→workspace
// fallback for checkout-style development.
export function listedRibIds(home: string = resolveKeelsonHome()): string[] {
  return ribIdsFromDir(resolveRibsRoot(home));
}

export interface RibVersion {
  id: string;
  // The rib package's declared version, or null when its package.json is
  // missing or unreadable (a bare checkout-symlinked dir need not carry one).
  version: string | null;
}

function ribVersionFromDir(dir: string, id: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `rib-${id}`, "package.json"), "utf8"));
    const v = (parsed as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// listedRibIds plus each rib's package.json version — the data behind
// `keelson version` and `rib list --installed`. Reads the same workspace-fallback
// root, so it carries versions in a checkout as well as an installed home.
export function listedRibs(home: string = resolveKeelsonHome()): RibVersion[] {
  const root = resolveRibsRoot(home);
  return listedRibIds(home).map((id) => ({ id, version: ribVersionFromDir(root, id) }));
}
