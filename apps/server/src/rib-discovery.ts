// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Rib, ribDisplayNameSchema, ribIdSchema } from "@keelson/shared";

export interface DiscoverRibsOptions {
  root?: string;
}

const HOOK_FIELDS = [
  "registerTools",
  "composeBundle",
  "dispose",
  "contributeWorkflows",
  "onAction",
  "authStatus",
] as const;

const ARRAY_FIELDS = ["views", "surfaces"] as const;

export async function discoverRibs(opts: DiscoverRibsOptions = {}): Promise<Record<string, Rib>> {
  const root = opts.root ?? join(process.cwd(), "node_modules", "@keelson");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    // Missing root is the common no-ribs-installed case; warning here would be boot-time noise.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw err;
  }
  const out: Record<string, Rib> = {};
  for (const name of names) {
    if (!name.startsWith("rib-")) continue;
    const entry = join(root, name);
    // stat follows symlinks; Bun workspace installs symlink node_modules/@keelson/rib-* to the real package dir.
    let entryStat: Awaited<ReturnType<typeof stat>>;
    try {
      entryStat = await stat(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[keelson] discovered '${name}': failed to stat (${msg}); skipping`);
      continue;
    }
    if (!entryStat.isDirectory()) continue;
    const expectedId = name.slice("rib-".length);
    const idCheck = ribIdSchema.safeParse(expectedId);
    if (!idCheck.success) {
      console.warn(
        `[keelson] discovered '${name}': inferred id '${expectedId}' is invalid (${idCheck.error.issues[0]?.message ?? "schema violation"}); skipping`,
      );
      continue;
    }
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
    const badHook = HOOK_FIELDS.find(
      (k) => candidate[k] !== undefined && typeof candidate[k] !== "function",
    );
    if (badHook) {
      console.warn(
        `[keelson] discovered '${name}': '${badHook}' is present but not a function; skipping`,
      );
      continue;
    }
    const badArray = ARRAY_FIELDS.find(
      (k) => candidate[k] !== undefined && !Array.isArray(candidate[k]),
    );
    if (badArray) {
      console.warn(
        `[keelson] discovered '${name}': '${badArray}' is present but not an array; skipping`,
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
