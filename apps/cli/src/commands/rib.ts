// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { resolve } from "node:path";
import type { RibSummary } from "@keelson/shared";
import { runBunPm, runBunPmCaptured } from "../bun-pm.ts";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import {
  ensureHome,
  findDuplicateRibKeys,
  installedRibIds,
  listedRibs,
  parseManifestRibDeps,
  readManifestText,
  resolveKeelsonHome,
  restoreHome,
  snapshotHome,
} from "../home.ts";
import { listRibs } from "../http/ribs-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import {
  lsRemoteTags,
  newestRelease,
  parseRibSource,
  pinnedSpec,
  type ResolveTags,
} from "../rib-version.ts";
import { defaultServerBaseUrl, probeServer } from "../server-probe.ts";

interface BaseOptions {
  json: boolean;
  baseUrl?: string;
}

export interface RibAddOptions extends BaseOptions {
  // Install a specific git ref instead of the newest release, for tracking a
  // rib's default branch during development.
  ref?: string;
}

// Keelson keeps no registry of ribs — `rib add <source>` hands the source
// straight to `bun add`, which accepts a github URL, github:owner/repo, a git
// URL, an npm name, or a path. The only rewrite: a relative path is absolutized,
// because `bun add` runs with cwd=home and a bare `./rib` would otherwise
// resolve under the home rather than the operator's shell cwd.
function resolveRibSource(arg: string): string {
  if (arg.startsWith(".")) return resolve(arg);
  return arg;
}

export interface AddPin {
  spec: string;
  tag: string | null;
  // A complete sentence explaining why no release pin was applied, for the
  // legitimate cases. Printed verbatim: the reasons do not share a prefix.
  unpinned: string | null;
  // Set when the tags could not be read at all. Installing anyway would take
  // whatever the default branch holds while reporting nothing went wrong, so
  // the add stops instead.
  unreadable: string | null;
}

// Resolving the release before `bun add` rather than re-pinning after means bun
// clones the tag itself: the operator never has an unreleased commit installed,
// not even transiently.
export async function resolveAddPin(
  source: string,
  ref: string | undefined,
  resolveTags: ResolveTags = lsRemoteTags,
): Promise<AddPin> {
  const bare = { tag: null, unpinned: null, unreadable: null };
  const parsed = parseRibSource(source);
  if (ref !== undefined) {
    return parsed === null
      ? { ...bare, spec: source, unpinned: `--ref does not apply to ${source}` }
      : { ...bare, spec: `${parsed.base}#${ref}` };
  }
  if (parsed === null || parsed.ref !== null) return { ...bare, spec: source };

  const resolution = await resolveTags(parsed.url);
  if (resolution.kind === "unreachable") {
    return { ...bare, spec: source, unreadable: resolution.reason };
  }
  const target = newestRelease(resolution.tags, false);
  if (target === null) {
    return { ...bare, spec: source, unpinned: "no release tags yet; tracking the default branch" };
  }
  return { ...bare, spec: pinnedSpec(parsed, target.tag), tag: target.tag };
}

// Skip probeServer: the actual GET surfaces "connection refused" via
// isServerDownError at fewer round-trips (mirrors the project commands).
function effectiveBaseUrl(opts: BaseOptions): string {
  return opts.baseUrl ?? defaultServerBaseUrl();
}

function noServer(opts: BaseOptions): never {
  emit(
    { error: "rib commands require a running server (`keelson start`)", code: "NO_SERVER" },
    { json: opts.json },
  );
  process.exit(EXIT_NO_SERVER);
}

function failHttp(err: unknown, opts: BaseOptions, label: string): never {
  if (isServerDownError(err)) noServer(opts);
  if (err instanceof HttpError) {
    emit(
      { error: err.message, code: err.status === 404 ? "NOT_FOUND" : "REQUEST_FAILED" },
      { json: opts.json },
    );
    process.exit(err.status === 404 ? EXIT_NOT_FOUND : EXIT_FAIL);
  }
  const message = err instanceof Error ? err.message : String(err);
  emit({ error: `${label}: ${message}`, code: "REQUEST_FAILED" }, { json: opts.json });
  process.exit(EXIT_FAIL);
}

function authLabel(rib: RibSummary): string {
  if (!rib.auth) return "n/a";
  return rib.auth.authenticated ? "authenticated" : "needs auth";
}

// One discovered rib at a glance: identity, the tools it brings, its surface
// tabs, and auth.
function toListItem(rib: RibSummary) {
  return {
    id: rib.id,
    displayName: rib.displayName,
    tools: rib.registered,
    surfaces: rib.surfaces.map((s) => s.id),
    auth: authLabel(rib),
  };
}

// Full detail for one rib: tools, canvas views, surfaces, whether it handles
// board actions, and auth.
function toShowItem(rib: RibSummary) {
  return {
    id: rib.id,
    displayName: rib.displayName,
    tools: rib.registered,
    views: rib.views.map((v) => v.key),
    surfaces: rib.surfaces.map((s) => ({ id: s.id, title: s.title })),
    handlesActions: rib.hasOnAction,
    auth: authLabel(rib),
  };
}

function detectResourceCollision(beforeText: string, afterText: string): string | null {
  const duplicate = findDuplicateRibKeys(afterText)[0];
  if (duplicate) return duplicate;

  try {
    const beforeDeps = parseManifestRibDeps(beforeText);
    const afterDeps = parseManifestRibDeps(afterText);
    for (const [name, source] of beforeDeps) {
      if (afterDeps.has(name) && afterDeps.get(name) !== source) return name;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveRibId(pkgName: string): string {
  return pkgName.replace(/^@keelson\/rib-/, "");
}

function installCause(result: { code: number; stderr: string }): string {
  const detail = result.stderr.trim().split("\n").at(-1)?.trim();
  return detail ? `${detail} (exit ${result.code})` : `exit ${result.code}`;
}

async function rollbackHome(
  home: string,
  snapshot: { manifestText: string; lockText: string | null },
  quiet: boolean,
): Promise<string | null> {
  restoreHome(home, snapshot);
  const reinstallCode = await runBunPm(["install"], home, quiet);
  return reinstallCode === 0
    ? null
    : `rollback restore failed: bun install exited ${reinstallCode}`;
}

function failInstall(
  source: string,
  cause: string,
  opts: BaseOptions,
  pkgName?: string | null,
): never {
  const fallback = pkgName
    ? `keelson rib remove ${resolveRibId(pkgName)} && keelson rib add ${source}`
    : null;
  const message = `bun add ${source} failed: ${cause}`;
  emit({ error: message, code: "INSTALL_FAILED" }, { json: opts.json });
  if (!opts.json && fallback) process.stdout.write(`try: ${fallback}\n`);
  process.exit(EXIT_FAIL);
}

// The ref each rib's manifest entry carries, so a listing distinguishes a rib
// held at a release from one riding a branch without reading package.json.
function manifestPins(home: string): Map<string, string> {
  const pins = new Map<string, string>();
  let deps: Map<string, string>;
  try {
    deps = parseManifestRibDeps(readManifestText(home));
  } catch {
    return pins;
  }
  for (const [pkg, source] of deps) {
    const ref = parseRibSource(source)?.ref;
    if (ref) pins.set(pkg.replace(/^@keelson\/rib-/, ""), ref);
  }
  return pins;
}

export interface RibListOptions extends BaseOptions {
  // Read installed ribs straight from the home's node_modules instead of the
  // running server — works before `keelson start` is up, but only carries ids.
  installed?: boolean;
}

export async function runRibList(opts: RibListOptions): Promise<never> {
  if (opts.installed) {
    const home = resolveKeelsonHome();
    const pins = manifestPins(home);
    const ribs = listedRibs(home).map(({ id, version }) => ({
      id,
      displayName: id,
      version,
      pinned: pins.get(id) ?? null,
    }));
    emit({ data: { ribs, source: "installed", home } }, { json: opts.json });
    process.exit(EXIT_OK);
  }
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const ribs = await listRibs(baseUrl);
    emit({ data: { ribs: ribs.map(toListItem), source: "server" } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "list ribs");
  }
}

export async function runRibAdd(arg: string, opts: RibAddOptions): Promise<never> {
  const trimmed = arg.trim();
  if (trimmed.length === 0) {
    emit({ error: "rib id or source must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const home = ensureHome();
  const pin = await resolveAddPin(resolveRibSource(trimmed), opts.ref);
  if (pin.unreadable !== null) {
    emit(
      {
        error: `could not read releases for ${trimmed}: ${pin.unreadable} — install a specific ref with \`--ref <ref>\` if that is what you want`,
        code: "UNREACHABLE",
      },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  const source = pin.spec;
  const snapshot = snapshotHome(home);
  const before = new Set(installedRibIds(home));
  const firstAdd = await runBunPmCaptured(["add", source], home, opts.json);
  const afterFirstText = readManifestText(home);
  let resourced: string | null = null;
  const collision = detectResourceCollision(snapshot.manifestText, afterFirstText);

  if (firstAdd.code !== 0 || collision !== null) {
    if (collision === null) {
      const rollbackError = await rollbackHome(home, snapshot, opts.json);
      const cause = installCause(firstAdd);
      failInstall(source, rollbackError ? `${cause}; ${rollbackError}` : cause, opts, null);
    }

    restoreHome(home, snapshot);
    const removeCode = await runBunPm(["remove", collision], home, opts.json);
    if (removeCode !== 0) {
      const rollbackError = await rollbackHome(home, snapshot, opts.json);
      const cause = `bun remove ${collision} failed (exit ${removeCode})`;
      failInstall(source, rollbackError ? `${cause}; ${rollbackError}` : cause, opts, collision);
    }

    const retryAdd = await runBunPmCaptured(["add", source], home, opts.json);
    const afterRetryText = readManifestText(home);
    if (retryAdd.code !== 0 || findDuplicateRibKeys(afterRetryText).length > 0) {
      const rollbackError = await rollbackHome(home, snapshot, opts.json);
      const cause = installCause(retryAdd);
      failInstall(source, rollbackError ? `${cause}; ${rollbackError}` : cause, opts, collision);
    }
    resourced = resolveRibId(collision);
  }

  const installed = installedRibIds(home);
  const added = installed.filter((id) => !before.has(id));
  // A rib only activates at server boot; warn when one is already running.
  const server = await probeServer(opts.baseUrl ? { baseUrl: opts.baseUrl } : {});
  emit(
    {
      data: {
        added,
        installed,
        home,
        restartRequired: server !== null,
        resourced,
        pinned: pin.tag,
        ...(pin.unpinned ? { pinNote: pin.unpinned } : {}),
      },
    },
    { json: opts.json },
  );
  if (!opts.json) {
    // An unpinned install is the exception now, so it says so rather than
    // leaving the operator to infer it from a manifest they never open.
    if (pin.unpinned) process.stdout.write(`${pin.unpinned}\n`);
    if (resourced) {
      process.stdout.write(`resourced ${resourced}${pin.tag ? ` at ${pin.tag}` : ""}\n`);
      if (server !== null) {
        process.stdout.write("restart the server (`keelson restart`) to activate the rib\n");
      }
    } else if (added.length > 0) {
      process.stdout.write(`added ${added.join(", ")}${pin.tag ? ` ${pin.tag}` : ""}\n`);
      if (server !== null) {
        process.stdout.write("restart the server (`keelson restart`) to activate the new rib\n");
      }
    } else {
      // bun add succeeded but no new @keelson/rib-* appeared: either an
      // already-installed rib, or a source that isn't a keelson rib package.
      process.stdout.write(
        `no new rib added from ${source} (already installed, or not an @keelson/rib-* package)\n`,
      );
    }
  }
  process.exit(EXIT_OK);
}

export async function runRibRemove(id: string, opts: BaseOptions): Promise<never> {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    emit({ error: "rib id must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const home = resolveKeelsonHome();
  if (!installedRibIds(home).includes(trimmed)) {
    emit({ error: `rib '${trimmed}' is not installed`, code: "NOT_FOUND" }, { json: opts.json });
    process.exit(EXIT_NOT_FOUND);
  }
  const pkg = `@keelson/rib-${trimmed}`;
  const code = await runBunPm(["remove", pkg], home, opts.json);
  if (code !== 0) {
    emit(
      { error: `bun remove ${pkg} failed (exit ${code})`, code: "REMOVE_FAILED" },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  const server = await probeServer(opts.baseUrl ? { baseUrl: opts.baseUrl } : {});
  emit(
    {
      data: {
        removed: trimmed,
        installed: installedRibIds(home),
        restartRequired: server !== null,
      },
    },
    { json: opts.json },
  );
  if (!opts.json) {
    process.stdout.write(`removed ${trimmed}\n`);
    if (server !== null) {
      process.stdout.write("restart the server (`keelson restart`) to deactivate it\n");
    }
  }
  process.exit(EXIT_OK);
}

export async function runRibShow(id: string, opts: BaseOptions): Promise<never> {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    emit({ error: "rib id must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const baseUrl = effectiveBaseUrl(opts);
  try {
    const rib = (await listRibs(baseUrl)).find((r) => r.id === trimmed);
    if (!rib) {
      emit({ error: `no rib named '${trimmed}'`, code: "NOT_FOUND" }, { json: opts.json });
      process.exit(EXIT_NOT_FOUND);
    }
    emit({ data: { rib: toShowItem(rib) } }, { json: opts.json });
    process.exit(EXIT_OK);
  } catch (err) {
    failHttp(err, opts, "show rib");
  }
}
