#!/usr/bin/env bun
// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Flags bun.lock pins younger than the quarantine window corporate vetting
// feeds apply to fresh npm publishes — a release whose youngest pin has aged
// past the window installs cleanly behind those feeds (issue #641).

const WINDOW_DAYS = 7;
const MAX_LOOKUPS = 100;
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
  const checked = pins.slice(0, MAX_LOOKUPS);
  if (checked.length < pins.length) {
    console.log(`capped: checking the first ${MAX_LOOKUPS} of ${pins.length} new pins`);
  }
  let young = 0;
  let failures = 0;
  for (const { pkg, version } of checked) {
    let published: Date | null;
    try {
      published = await publishedAt(pkg, version);
    } catch (err) {
      failures += 1;
      console.log(
        `lookup failed for ${pkg}@${version}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!published) {
      console.log(`no publish date for ${pkg}@${version} — skipped`);
      continue;
    }
    const ageDays = (Date.now() - published.getTime()) / 86_400_000;
    if (ageDays < WINDOW_DAYS) {
      young += 1;
      console.log(
        `::warning file=bun.lock::${pkg}@${version} was published ${ageDays.toFixed(1)} days ago — quarantine feeds holding releases for ${WINDOW_DAYS} days cannot install it yet`,
      );
    }
  }
  if (failures === checked.length) {
    console.log("every registry lookup failed — skipping the pin-age check");
    process.exit(0);
  }
  if (young > 0) {
    console.error(
      `${young} new pin(s) are younger than ${WINDOW_DAYS} days; fresh installs behind quarantine feeds will fail until they age in (not a merge blocker — a heads-up for release timing)`,
    );
    process.exit(1);
  }
  console.log(`all ${checked.length - failures} checked pins are at least ${WINDOW_DAYS} days old`);
}
