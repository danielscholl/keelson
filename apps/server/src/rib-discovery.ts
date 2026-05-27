// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Rib, ribDisplayNameSchema, ribIdSchema } from "@keelson/shared";

export interface DiscoverRibsOptions {
  // Directory containing `rib-*` subdirectories. Defaults to
  // `<process.cwd()>/node_modules/@keelson`; tests pass a fixture path.
  root?: string;
}

// Walk `root`, dynamic-import each `rib-*` package's default export, and
// return a manifest keyed by the rib's id (the directory suffix after `rib-`).
// Every failure mode (missing root, malformed export, throwing import,
// schema violation, id mismatch with package basename, duplicate id) warns
// and skips — a single broken rib package must not prevent the rest from
// activating, matching how `KEELSON_RIBS` typos are handled in `applyRibs`.
export async function discoverRibs(opts: DiscoverRibsOptions = {}): Promise<Record<string, Rib>> {
  const root = opts.root ?? join(process.cwd(), "node_modules", "@keelson");
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw err;
  }
  const out: Record<string, Rib> = {};
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    if (!name.startsWith("rib-")) continue;
    const expectedId = name.slice("rib-".length);
    const idCheck = ribIdSchema.safeParse(expectedId);
    if (!idCheck.success) {
      console.warn(
        `[keelson] discovered '${name}': inferred id '${expectedId}' is invalid (${idCheck.error.issues[0]?.message ?? "schema violation"}); skipping`,
      );
      continue;
    }
    const entry = join(root, name);
    let mod: { default?: unknown };
    try {
      mod = (await import(entry)) as { default?: unknown };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[keelson] failed to import '${name}': ${msg}; skipping`);
      continue;
    }
    const exported = mod.default;
    if (!exported || typeof exported !== "object") {
      console.warn(
        `[keelson] discovered '${name}': default export missing or not an object; skipping`,
      );
      continue;
    }
    const candidate = exported as Partial<Rib>;
    const ribIdCheck = ribIdSchema.safeParse(candidate.id);
    if (!ribIdCheck.success) {
      console.warn(`[keelson] discovered '${name}': default export has invalid id; skipping`);
      continue;
    }
    const displayCheck = ribDisplayNameSchema.safeParse(candidate.displayName);
    if (!displayCheck.success) {
      console.warn(
        `[keelson] discovered '${name}': default export has invalid displayName; skipping`,
      );
      continue;
    }
    if (candidate.id !== expectedId) {
      console.warn(
        `[keelson] discovered '${name}': declared id '${candidate.id}' doesn't match package suffix '${expectedId}'; skipping`,
      );
      continue;
    }
    if (out[candidate.id]) {
      console.warn(
        `[keelson] duplicate rib id '${candidate.id}' discovered; skipping later occurrence`,
      );
      continue;
    }
    out[candidate.id] = exported as Rib;
  }
  return out;
}
