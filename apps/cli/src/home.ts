// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveKeelsonHome } from "@keelson/shared/paths";

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

// The home's @keelson scope directory — where `bun add` lands rib packages and
// where the server's discovery scans for rib-*.
export function homeRibsDir(home: string = resolveKeelsonHome()): string {
  return join(home, "node_modules", "@keelson");
}

// Ids of installed rib-* packages under the home, inferred from directory names
// (rib-osdu → osdu). Sorted; empty when nothing is installed yet.
export function installedRibIds(home: string = resolveKeelsonHome()): string[] {
  const dir = homeRibsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("rib-"))
    .map((name) => name.slice("rib-".length))
    .sort();
}
