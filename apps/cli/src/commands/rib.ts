// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { resolve } from "node:path";
import type { RibSummary } from "@keelson/shared";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_NO_SERVER, EXIT_NOT_FOUND, EXIT_OK } from "../exit.ts";
import { ensureHome, installedRibIds, resolveKeelsonHome } from "../home.ts";
import { listRibs } from "../http/ribs-client.ts";
import { HttpError, isServerDownError } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { DEFAULT_SERVER_BASE_URL, probeServer } from "../server-probe.ts";

interface BaseOptions {
  json: boolean;
  baseUrl?: string;
}

// First-party ribs the CLI knows how to fetch by bare id. Anything else passed
// to `rib add` is treated as a bun-installable spec (path, github:owner/repo,
// git URL, or npm name).
const KNOWN_RIBS: Record<string, string> = {
  chamber: "github:danielscholl/keelson-rib-chamber",
  osdu: "github:danielscholl/keelson-rib-osdu",
};

// A known id → its github source; a relative path (`./my-rib`) → absolute
// against the invoking shell's cwd, because `bun add` runs with cwd=home and a
// bare relative spec would otherwise resolve under the home; everything else
// (absolute path, github:/git URL, npm name) passes through unchanged.
function resolveRibSource(arg: string): string {
  const known = KNOWN_RIBS[arg];
  if (known) return known;
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
  return opts.baseUrl ?? DEFAULT_SERVER_BASE_URL;
}

function noServer(opts: BaseOptions): never {
  emit(
    { error: "rib commands require `keelson serve` to be running", code: "NO_SERVER" },
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
  // running server — works before `keelson serve` is up, but only carries ids.
  installed?: boolean;
}

export async function runRibList(opts: RibListOptions): Promise<never> {
  if (opts.installed) {
    const home = resolveKeelsonHome();
    const ribs = installedRibIds(home).map((id) => ({ id, displayName: id }));
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
    const label = added.length > 0 ? added.join(", ") : source;
    process.stdout.write(`added ${label}\n`);
    if (server !== null) {
      process.stdout.write("restart `keelson serve` to activate the new rib\n");
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
      process.stdout.write("restart `keelson serve` to deactivate it\n");
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
