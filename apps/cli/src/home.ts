// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
