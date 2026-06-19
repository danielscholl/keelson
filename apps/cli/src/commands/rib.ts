// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { resolve } from "node:path";
import type { RibSummary } from "@keelson/shared";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { ensureHome, installedRibIds, listedRibIds, resolveKeelsonHome } from "../home.ts";
import { listRibs } from "../http/ribs-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { defaultServerBaseUrl, probeServer } from "../server-probe.ts";

interface BaseOptions {
  json: boolean;
  baseUrl?: string;
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

// Run `bun <args>` in the home and return its exit code. In JSON mode bun's
// output is discarded (`ignore`) so the envelope is the only thing on stdout —
// and, critically, piped-but-undrained stdio would deadlock once bun's output
// exceeds the OS pipe buffer (a `bun add github:…` clone easily does). Human
// mode inherits bun's progress.
async function runBunPm(args: string[], home: string, quiet: boolean): Promise<number> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: home,
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return await proc.exited;
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

export interface RibListOptions extends BaseOptions {
  // Read installed ribs straight from the home's node_modules instead of the
  // running server — works before `keelson start` is up, but only carries ids.
  installed?: boolean;
}

export async function runRibList(opts: RibListOptions): Promise<never> {
  if (opts.installed) {
    const home = resolveKeelsonHome();
    const ribs = listedRibIds(home).map((id) => ({ id, displayName: id }));
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

export async function runRibAdd(arg: string, opts: BaseOptions): Promise<never> {
  const trimmed = arg.trim();
  if (trimmed.length === 0) {
    emit({ error: "rib id or source must not be empty", code: "BAD_INPUTS" }, { json: opts.json });
    process.exit(EXIT_BAD_ARGS);
  }
  const home = ensureHome();
  const source = resolveRibSource(trimmed);
  const before = new Set(installedRibIds(home));
  const code = await runBunPm(["add", source], home, opts.json);
  if (code !== 0) {
    emit(
      { error: `bun add ${source} failed (exit ${code})`, code: "INSTALL_FAILED" },
      { json: opts.json },
    );
    process.exit(EXIT_FAIL);
  }
  const installed = installedRibIds(home);
  const added = installed.filter((id) => !before.has(id));
  // A rib only activates at server boot; warn when one is already running.
  const server = await probeServer(opts.baseUrl ? { baseUrl: opts.baseUrl } : {});
  emit({ data: { added, installed, home, restartRequired: server !== null } }, { json: opts.json });
  if (!opts.json) {
    if (added.length > 0) {
      process.stdout.write(`added ${added.join(", ")}\n`);
      if (server !== null) {
        process.stdout.write(
          "restart the server (`keelson stop && keelson start`) to activate the new rib\n",
        );
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
      process.stdout.write(
        "restart the server (`keelson stop && keelson start`) to deactivate it\n",
      );
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
