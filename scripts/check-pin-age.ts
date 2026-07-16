#!/usr/bin/env bun
// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Flags bun.lock pins younger than the quarantine window corporate vetting
// feeds apply to fresh npm publishes — a release whose youngest pin has aged
// past the window installs cleanly behind those feeds.

const WINDOW_DAYS = 7;
const CONCURRENCY = 8;
const REGISTRY = "https://registry.npmjs.org";

interface Pin {
  pkg: string;
  version: string;
}

// Added lockfile resolution entries look like `+ "name": ["name@1.2.3", ...]`.
// Only registry semver pins matter: workspace:/github:/tarball sources (whose
// "version" doesn't start with a digit) never pass through a quarantine feed.
export function parseAddedPins(diff: string): Pin[] {
  const pins = new Map<string, Pin>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+")) continue;
    for (const m of line.matchAll(/\["((?:@[^/"]+\/)?[^@"]+)@(\d[^"]*)"/g)) {
      const pkg = m[1] as string;
      const version = m[2] as string;
      pins.set(`${pkg}@${version}`, { pkg, version });
    }
  }
  return [...pins.values()];
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}

async function publishedAt(pkg: string, version: string): Promise<Date | null> {
  const res = await fetch(`${REGISTRY}/${pkg}`);
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${pkg}`);
  const doc = (await res.json()) as { time?: Record<string, string> };
  const iso = doc.time?.[version];
  return iso ? new Date(iso) : null;
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: bun scripts/check-pin-age.ts <base-ref>");
    process.exit(2);
  }
  const diff = Bun.spawnSync(["git", "diff", `${base}...HEAD`, "--", "bun.lock"]);
  if (diff.exitCode !== 0) {
    console.error(diff.stderr.toString());
    process.exit(2);
  }
  const pins = parseAddedPins(diff.stdout.toString());
  if (pins.length === 0) {
    console.log("no new registry pins in bun.lock");
    process.exit(0);
  }
  console.log(`checking ${pins.length} new pin(s) against ${REGISTRY}`);
  const verdicts = await mapLimit(pins, CONCURRENCY, async ({ pkg, version }) => {
    try {
      const published = await publishedAt(pkg, version);
      if (!published) return { pkg, version, ageDays: null, error: "no publish date" };
      return { pkg, version, ageDays: (Date.now() - published.getTime()) / 86_400_000 };
    } catch (err) {
      return {
        pkg,
        version,
        ageDays: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  const young = verdicts.filter((v) => v.ageDays !== null && v.ageDays < WINDOW_DAYS);
  const unverified = verdicts.filter((v) => v.ageDays === null);
  for (const v of young) {
    console.log(
      `::warning file=bun.lock::${v.pkg}@${v.version} was published ${v.ageDays?.toFixed(1)} days ago — quarantine feeds holding releases for ${WINDOW_DAYS} days cannot install it yet`,
    );
  }
  for (const v of unverified) {
    console.log(`::warning file=bun.lock::${v.pkg}@${v.version} could not be verified: ${v.error}`);
  }
  if (young.length > 0 || unverified.length > 0) {
    console.error(
      `${young.length} pin(s) younger than ${WINDOW_DAYS} days, ${unverified.length} unverifiable — fresh installs behind quarantine feeds may fail until pins age in (not a merge blocker; a heads-up for release timing)`,
    );
    process.exit(1);
  }
  console.log(`all ${pins.length} new pins are at least ${WINDOW_DAYS} days old`);
}
