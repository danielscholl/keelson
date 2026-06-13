// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";
import { probeServer } from "../server-probe.ts";

// The repo whose GitHub Releases this CLI updates from. Overridable for forks
// and for tests that point at a fixture server.
const REPO = process.env.KEELSON_UPDATE_REPO?.trim() || "danielscholl/keelson";
const API_BASE = process.env.KEELSON_UPDATE_API?.trim() || "https://api.github.com";

export interface UpdateOptions {
  json: boolean;
  check: boolean;
  force: boolean;
  ribs: boolean;
  notes: boolean;
}

interface ReleaseInfo {
  tag_name: string;
  body?: string | null;
}

interface HomeManifest {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

// "v0.2.0" → "0.2.0". Returns null for tags that aren't a valid semver so a
// stray non-release tag can't crash the comparison.
export function parseTagVersion(tag: string): string | null {
  const v = tag.startsWith("v") ? tag.slice(1) : tag;
  // Bun.semver.order throws on invalid input — use it as the validity probe.
  try {
    Bun.semver.order(v, v);
    return v;
  } catch {
    return null;
  }
}

// The versioned release-asset URLs install.sh would pin for a given version —
// the single place the download-URL shape is encoded on the update path.
export function releaseAssetUrls(repo: string, version: string): { cli: string; shared: string } {
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  return { cli: `${base}/keelson-cli.tgz`, shared: `${base}/keelson-shared.tgz` };
}

// Re-pin @keelson/cli + @keelson/shared to a version's asset URLs, preserving
// every other dependency (the installed ribs). Pure: returns a new manifest.
export function applyManifestVersion(
  manifest: HomeManifest,
  repo: string,
  version: string,
): HomeManifest {
  const urls = releaseAssetUrls(repo, version);
  return {
    ...manifest,
    dependencies: {
      ...manifest.dependencies,
      "@keelson/cli": urls.cli,
      "@keelson/shared": urls.shared,
    },
  };
}

// Every installed rib dependency. `bun update` advances each to the latest of
// whatever its source resolves to — a floating git ref (github URL, github:,
// owner/repo, git+) moves to its newest commit; a pinned tag, tarball, or path
// is a no-op. Source-agnostic by design: keelson keeps no registry, so it can't
// (and shouldn't) reason about where a rib came from.
export function ribDependencies(manifest: HomeManifest): string[] {
  const deps = manifest.dependencies ?? {};
  return Object.keys(deps)
    .filter((name) => name.startsWith("@keelson/rib-"))
    .sort();
}

// Release bodies for the versions in the window (current, latest], oldest
// first — what changed between what you have and what you're moving to.
export function selectReleaseNotes(
  releases: ReleaseInfo[],
  current: string,
  latest: string,
): string {
  const inWindow = releases
    .map((r) => ({ v: parseTagVersion(r.tag_name), body: (r.body ?? "").trim() }))
    .filter((r): r is { v: string; body: string } => r.v !== null)
    .filter((r) => Bun.semver.order(r.v, current) > 0 && Bun.semver.order(r.v, latest) <= 0)
    .sort((a, b) => Bun.semver.order(a.v, b.v));
  return inWindow.map((r) => (r.body ? `## v${r.v}\n\n${r.body}` : `## v${r.v}`)).join("\n\n");
}

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  return {
    "User-Agent": "keelson-cli",
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const res = await fetch(`${API_BASE}/repos/${REPO}/releases/latest`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`);
  return (await res.json()) as ReleaseInfo;
}

async function fetchReleases(): Promise<ReleaseInfo[]> {
  const res = await fetch(`${API_BASE}/repos/${REPO}/releases?per_page=100`, {
    headers: ghHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`);
  return (await res.json()) as ReleaseInfo[];
}

// Run `bun <args>` in the home. JSON mode discards bun's chatter (the envelope
// is the only stdout); human mode inherits its progress — mirrors rib.ts.
async function runBun(args: string[], home: string, quiet: boolean): Promise<number> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: home,
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return await proc.exited;
}

function installedCliVersion(home: string): string | null {
  const p = join(home, "node_modules", "@keelson", "cli", "package.json");
  if (!existsSync(p)) return null;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function fail(message: string, code: string, json: boolean): never {
  emit({ error: message, code }, { json });
  process.exit(EXIT_FAIL);
}

export async function runUpdate(opts: UpdateOptions): Promise<never> {
  const home = resolveKeelsonHome();
  const manifestPath = join(home, "package.json");
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    fail(
      `no installed keelson home at ${home} — \`keelson update\` upgrades an install.sh-provisioned home, not a source checkout`,
      "NOT_INSTALLED",
      opts.json,
    );
  }
  const manifest = JSON.parse(manifestRaw) as HomeManifest;
  if (!manifest.dependencies?.["@keelson/cli"]) {
    fail(
      `${home} is not an installed keelson home (no @keelson/cli dependency); in a source checkout, update with git`,
      "NOT_INSTALLED",
      opts.json,
    );
  }

  const current = pkg.version;
  let release: ReleaseInfo;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    fail(`could not reach GitHub releases: ${(err as Error).message}`, "FETCH_FAILED", opts.json);
  }
  const latest = parseTagVersion(release.tag_name);
  if (!latest) {
    fail(
      `latest release tag '${release.tag_name}' is not a valid version`,
      "BAD_RELEASE",
      opts.json,
    );
  }

  const upToDate = Bun.semver.order(latest, current) <= 0;

  // Release notes for the window are best-effort: never let a notes failure
  // block (or fail) the update itself.
  let notes = "";
  if (opts.notes && !upToDate) {
    try {
      notes = selectReleaseNotes(await fetchReleases(), current, latest);
    } catch {
      notes = (release.body ?? "").trim();
    }
  }

  if (upToDate && !opts.force) {
    emitResult(opts, { current, latest, upToDate: true, updated: false, home });
    process.exit(EXIT_OK);
  }

  if (opts.check) {
    if (!opts.json) printDelta(current, latest, notes);
    emitResult(opts, {
      current,
      latest,
      upToDate,
      updated: false,
      updateAvailable: !upToDate,
      home,
      ...(notes ? { notes } : {}),
    });
    process.exit(EXIT_OK);
  }

  if (!opts.json) printDelta(current, latest, notes);

  writeFileSync(
    manifestPath,
    `${JSON.stringify(applyManifestVersion(manifest, REPO, latest), null, 2)}\n`,
  );

  const installCode = await runBun(["install"], home, opts.json);
  if (installCode !== 0) {
    fail(
      `bun install failed (exit ${installCode}) after re-pinning to v${latest}`,
      "INSTALL_FAILED",
      opts.json,
    );
  }

  const ribs = opts.ribs ? ribDependencies(manifest) : [];
  if (ribs.length > 0) {
    const ribCode = await runBun(["update", ...ribs], home, opts.json);
    if (ribCode !== 0) {
      fail(
        `keelson updated to v${latest}, but advancing ribs (${ribs.join(", ")}) failed (exit ${ribCode}) — re-run \`keelson update\``,
        "RIB_UPDATE_FAILED",
        opts.json,
      );
    }
  }

  const installed = installedCliVersion(home) ?? latest;
  const server = await probeServer({});
  emitResult(opts, {
    current,
    latest,
    installed,
    updated: true,
    ribsUpdated: ribs,
    restartRequired: server !== null,
    home,
    ...(installed !== latest ? { warning: `installed ${installed}, expected ${latest}` } : {}),
  });
  if (!opts.json) {
    process.stdout.write(`\nupdated keelson ${current} → ${installed}\n`);
    if (ribs.length > 0)
      process.stdout.write(
        `advanced ribs: ${ribs.map((r) => r.replace("@keelson/rib-", "")).join(", ")}\n`,
      );
    if (server !== null)
      process.stdout.write(
        "restart the server (`keelson stop && keelson start`) to load the update\n",
      );
  }
  process.exit(EXIT_OK);
}

function printDelta(current: string, latest: string, notes: string): void {
  process.stdout.write(`keelson ${current} → ${latest}\n`);
  if (notes) process.stdout.write(`\n${notes}\n\n`);
}

function emitResult(opts: UpdateOptions, data: Record<string, unknown>): void {
  if (opts.json) {
    emit({ data }, { json: true });
    return;
  }
  // Human mode prints its own delta/summary lines; only surface the terse
  // already-current message here (the apply path writes its summary inline).
  if (data.updated === false && data.upToDate === true && !data.updateAvailable) {
    process.stdout.write(`keelson ${data.current} (already on the latest release)\n`);
  }
}
