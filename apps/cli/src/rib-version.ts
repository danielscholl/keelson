// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RibSource {
  // The manifest spec with any `#ref` stripped, so re-pinning rewrites only the
  // fragment and leaves the operator's chosen source form alone.
  base: string;
  // An anonymous-readable https URL for `git ls-remote`; bun's `github:` and
  // scp-style shorthands are not URLs git itself understands.
  url: string;
  ref: string | null;
}

function splitRef(spec: string): { base: string; ref: string | null } {
  const hash = spec.indexOf("#");
  if (hash === -1) return { base: spec, ref: null };
  const ref = spec.slice(hash + 1);
  return { base: spec.slice(0, hash), ref: ref.length > 0 ? ref : null };
}

// Downloadable artifacts that live on the same hosts as repos. The harness pins
// itself to release-asset URLs, which must never be read as a git remote.
const NOT_A_REPO = /\.(?:tgz|tar\.gz|tar\.bz2|zip)$/i;

// A repo path is two or more segments: GitLab subgroups nest arbitrarily
// (`group/sub/repo`), so a depth limit would report those as unpinnable.
function ownerRepo(path: string): string | null {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (NOT_A_REPO.test(trimmed) || trimmed.includes("/releases/download/")) return null;
  const parts = trimmed.split("/");
  if (parts.length < 2 || parts.some((part) => part.length === 0)) return null;
  parts[parts.length - 1] = (parts.at(-1) as string).replace(/\.git$/, "");
  return (parts.at(-1) as string).length === 0 ? null : parts.join("/");
}

function gitUrl(base: string): string | null {
  const spec = base.startsWith("git+") ? base.slice(4) : base;

  if (/^(?:https?|ssh|git):\/\//.test(spec)) {
    let parsed: URL;
    try {
      parsed = new URL(spec);
    } catch {
      return null;
    }
    const path = ownerRepo(parsed.pathname);
    return path ? `https://${parsed.host}/${path}` : null;
  }

  if (spec.startsWith("github:")) {
    const path = ownerRepo(spec.slice("github:".length));
    return path ? `https://github.com/${path}` : null;
  }

  // scp-style `git@host:owner/repo`. A leading `scheme:` is consumed here even
  // when it is not a git remote, so bun's own `file:`, `link:`, and `npm:`
  // specs cannot fall through to the bare-shorthand branch below and be read as
  // `owner/repo`. The host must carry userinfo or a dot to count as a remote.
  const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/.exec(spec);
  if (scp) {
    if (scp[1] === undefined && !(scp[2] as string).includes(".")) return null;
    const path = ownerRepo(scp[3] as string);
    return path ? `https://${scp[2]}/${path}` : null;
  }

  // Bare `owner/repo` means GitHub to bun, so it has to mean GitHub here too;
  // reading it as a path would leave the dependency bun actually installed from
  // git looking unpinnable. Local paths are absolutized before they reach the
  // manifest, and npm names carry a leading `@`.
  if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(spec)) {
    const path = ownerRepo(spec);
    if (path) return `https://github.com/${path}`;
  }

  return null;
}

// Null for anything that is not a git remote: npm names, local paths, and
// tarball URLs are all legitimate rib sources that releases do not apply to.
export function parseRibSource(spec: string): RibSource | null {
  const { base, ref } = splitRef(spec.trim());
  const url = gitUrl(base);
  return url === null ? null : { base, url, ref };
}

export function pinnedSpec(source: RibSource, tag: string): string {
  return `${source.base}#${tag}`;
}

export interface ReleaseTag {
  tag: string;
  version: string;
}

// Deliberately stricter than Bun.semver, which accepts partials like `1.2`.
// `ls-remote` returns every tag a repo carries, including hand-pushed ones, and
// a tag whose ordering is ambiguous is not a release we can safely advance to.
const RELEASE_TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function releaseTags(tags: readonly string[], allowPrerelease: boolean): ReleaseTag[] {
  const releases: ReleaseTag[] = [];
  for (const tag of tags) {
    const match = RELEASE_TAG.exec(tag);
    if (!match) continue;
    const version = match[1] as string;
    if (!allowPrerelease && version.includes("-")) continue;
    releases.push({ tag, version });
  }
  return releases.sort((a, b) => Bun.semver.order(a.version, b.version));
}

export function newestRelease(
  tags: readonly string[],
  allowPrerelease: boolean,
): ReleaseTag | null {
  return releaseTags(tags, allowPrerelease).at(-1) ?? null;
}

// `--to` accepts either form the operator sees (`0.48.0` or `v0.48.0`), and
// matches prereleases regardless of the prerelease filter: naming a version
// explicitly is the opt-in.
export function findRelease(tags: readonly string[], wanted: string): ReleaseTag | null {
  const target = wanted.startsWith("v") ? wanted.slice(1) : wanted;
  return releaseTags(tags, true).find((r) => r.version === target) ?? null;
}

// Distinguishes a release pin from a branch or commit pin, which is what tells
// an operator opt-out apart from a version this command may advance.
export function isReleaseTag(ref: string): boolean {
  return RELEASE_TAG.test(ref);
}

// Reachability and emptiness are distinct outcomes. A repo that cannot be read
// (private, offline, no git on PATH) must never collapse into "no releases",
// which reads as "nothing to do" and would let an update silently skip a rib.
export type TagResolution =
  | { kind: "resolved"; tags: string[] }
  | { kind: "unreachable"; reason: string };

export type ResolveTags = (url: string) => Promise<TagResolution>;

function lastLine(text: string): string {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.at(-1) ?? "";
}

export function parseLsRemote(stdout: string): string[] {
  const tags: string[] = [];
  for (const line of stdout.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (ref?.startsWith("refs/tags/")) tags.push(ref.slice("refs/tags/".length));
  }
  return tags;
}

// Reading tags over git rather than a forge's REST API keeps this host-agnostic
// (a GitLab-hosted rib resolves the same way) and unauthenticated, with no rate
// limit to budget against across a multi-rib update.
export async function lsRemoteTags(url: string, timeoutMs = 20_000): Promise<TagResolution> {
  try {
    const proc = Bun.spawn(["git", "ls-remote", "--tags", "--refs", url], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      signal: AbortSignal.timeout(timeoutMs),
      // Without this a private repo blocks on a credential prompt instead of
      // failing, and `keelson update` hangs rather than reporting the rib.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      return { kind: "unreachable", reason: lastLine(stderr) || `git ls-remote exited ${code}` };
    }
    return { kind: "resolved", tags: parseLsRemote(stdout) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "unreachable", reason: message };
  }
}

export function ribPackageName(id: string): string {
  return `@keelson/rib-${id}`;
}

export function ribIdFromPackage(pkg: string): string {
  return pkg.replace(/^@keelson\/rib-/, "");
}

interface RibManifest {
  version?: unknown;
  peerDependencies?: Record<string, unknown>;
}

function readRibManifest(home: string, pkg: string): RibManifest | null {
  try {
    return JSON.parse(readFileSync(join(home, "node_modules", pkg, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

export function installedRibVersion(home: string, pkg: string): string | null {
  const version = readRibManifest(home, pkg)?.version;
  return typeof version === "string" ? version : null;
}

// The `@keelson/shared` range a rib declares it was built against. Ribs have
// carried this since the contract existed; nothing read it until releases gave
// the harness a version to compare it to.
export function ribHarnessRange(home: string, pkg: string): string | null {
  const range = readRibManifest(home, pkg)?.peerDependencies?.["@keelson/shared"];
  return typeof range === "string" ? range : null;
}

export function installedHarnessVersion(home: string): string | null {
  const version = readRibManifest(home, "@keelson/shared")?.version;
  return typeof version === "string" ? version : null;
}

export interface CompatVerdict {
  compatible: boolean;
  range: string;
  harness: string;
}

const COMPARATOR =
  /^(?:[<>]=?|[~^]|=)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Bun.semver.satisfies does not validate its range and never throws: a
// malformed one silently matches every version, so a typo in a rib's declared
// range would score as compatible from a comparison that never happened.
export function isValidRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed.length === 0) return false;
  return trimmed.split("||").every((clause) => {
    const tokens = clause
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return false;
    // A hyphen range is exactly `A - B`. Dropping every `-` instead would let
    // `1.0.0 -` validate on the strength of its first token alone.
    const hyphen = tokens.indexOf("-");
    if (hyphen !== -1) {
      return (
        tokens.length === 3 &&
        hyphen === 1 &&
        COMPARATOR.test(tokens[0] as string) &&
        COMPARATOR.test(tokens[2] as string)
      );
    }
    return tokens.every((token) => COMPARATOR.test(token));
  });
}

// Undecidable inputs return null rather than a verdict: a rib with no declared
// range, an unreadable harness manifest, or a range that does not parse are all
// "we cannot tell", and reporting those as compatible would put the harness's
// name behind a claim it never checked.
export function checkHarnessCompat(home: string, pkg: string): CompatVerdict | null {
  const range = ribHarnessRange(home, pkg);
  const harness = installedHarnessVersion(home);
  if (range === null || harness === null || !isValidRange(range)) return null;
  return { compatible: Bun.semver.satisfies(harness, range), range, harness };
}
