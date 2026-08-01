// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { readKeelsonConfig } from "@keelson/shared/config";
import pkg from "../../package.json" with { type: "json" };
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { listedRibIds, resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";
import {
  credentialAccounts,
  PROGRAM_ENTRIES,
  UNINSTALL_MARKER,
  uninstallMarkerContents,
  unreachableCredentialRibs,
} from "../uninstall-plan.ts";
import { serveStop } from "./serve.ts";

const KEYRING_SERVICE = "keelson";

export interface UninstallOptions {
  json: boolean;
  purge: boolean;
  yes: boolean;
  keepCredentials: boolean;
  force: boolean;
}

// Mirrors the launcher location both installers write to.
export function launcherPath(): string {
  const override = process.env.KEELSON_BIN_DIR?.trim();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || homedir();
    return join(override || join(base, "keelson", "bin"), "keelson.cmd");
  }
  return join(override || join(homedir(), ".local", "bin"), "keelson");
}

function fail(message: string, code: string, json: boolean): never {
  emit({ error: message, code }, { json });
  process.exit(code === "BAD_INPUTS" ? EXIT_BAD_ARGS : EXIT_FAIL);
}

export type HomeProgramState = "installed" | "foreign" | "uninstalled" | "unknown";

// The home doubles as a source checkout's data dir in dev (paths.ts walks up to
// <repo>/.keelson), where removing "program files" would delete the developer's
// node_modules. An installed home is the one carrying an @keelson/cli dep; a
// manifest we cannot read is still evidence that something else owns the
// node_modules beside it, so it counts as foreign rather than as an absence.
export function classifyHomeProgram(home: string): HomeProgramState {
  let raw: string;
  try {
    raw = readFileSync(join(home, "package.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "foreign";
    return existsSync(join(home, UNINSTALL_MARKER)) ? "uninstalled" : "unknown";
  }
  try {
    const manifest = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return manifest.dependencies?.["@keelson/cli"] ? "installed" : "foreign";
  } catch {
    return "foreign";
  }
}

function assertRemovableHome(home: string, purge: boolean, json: boolean): void {
  const state = classifyHomeProgram(home);
  if (state === "installed") return;
  // A prior run took the program files and left the marker saying so. --purge
  // may finish the job; a plain run has nothing left to remove and would only
  // revoke keychain entries the operator never asked about.
  if (state === "uninstalled") {
    if (purge) return;
    fail(
      `${home} has no keelson program files left — a prior \`keelson uninstall\` already removed them. Re-run with --purge to delete the home itself`,
      "NOT_INSTALLED",
      json,
    );
  }
  if (state === "unknown") {
    fail(
      `${home} is not a keelson home: no package.json, and no record of an uninstall that left one behind. Nothing was removed`,
      "NOT_INSTALLED",
      json,
    );
  }
  fail(
    `${home} is not an installed keelson home (no @keelson/cli dependency); in a source checkout, remove it with git`,
    "NOT_INSTALLED",
    json,
  );
}

async function confirm(home: string, purge: boolean): Promise<boolean> {
  const what = purge
    ? `DELETE the entire keelson home at ${home}, including keelson.db, workflows, and rib data`
    : `remove keelson's program files from ${home} (your database, workflows, and config stay)`;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`This will ${what}.\nProceed? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// One raw attempt, as reported by the worker. `deleted` is false when the
// account simply held nothing.
export interface CredentialAttempt {
  account: string;
  deleted?: boolean;
  error?: string;
}

export interface CredentialOutcome {
  removed: string[];
  failed: string[];
}

// The one definition of what counts as a failure, applied by the parent so the
// rule stays in TypeScript and under test rather than inside the worker string.
// A missing entry is the common case and not a failure; anything else is.
export function classifyCredentialAttempts(
  accounts: readonly string[],
  attempts: readonly CredentialAttempt[],
): CredentialOutcome {
  const byAccount = new Map(attempts.map((a) => [a.account, a]));
  const removed: string[] = [];
  const failed: string[] = [];
  for (const account of accounts) {
    const attempt = byAccount.get(account);
    // An account the worker never reported on is unaccounted for, not clean.
    if (!attempt) {
      failed.push(account);
      continue;
    }
    if (attempt.error !== undefined) {
      const message = attempt.error.toLowerCase();
      if (!message.includes("no entry") && !message.includes("not found")) failed.push(account);
      continue;
    }
    if (attempt.deleted) removed.push(account);
  }
  return { removed, failed };
}

// Windows keeps a loaded native addon locked until the owning process exits, so
// deleting credentials in-process would leave @napi-rs/keyring's .node file held
// open inside the very node_modules tree the next step removes — an EPERM after
// the launcher and secrets are already gone. The worker exits first, releasing
// the lock; it only reports, and the parent classifies.
const CREDENTIAL_WORKER = `
const accounts = JSON.parse(process.env.KEELSON_UNINSTALL_ACCOUNTS || "[]");
const out = [];
try {
  const { Entry } = await import("@napi-rs/keyring");
  for (const account of accounts) {
    try {
      out.push({ account, deleted: new Entry(${JSON.stringify(KEYRING_SERVICE)}, account).deleteCredential() });
    } catch (err) {
      out.push({ account, error: String((err && err.message) || err) });
    }
  }
} catch (err) {
  for (const account of accounts) out.push({ account, error: String((err && err.message) || err) });
}
process.stdout.write(JSON.stringify(out));
`;

export async function deleteCredentials(
  accounts: readonly string[],
  home: string,
): Promise<CredentialOutcome> {
  if (accounts.length === 0) return { removed: [], failed: [] };
  let attempts: CredentialAttempt[] = [];
  try {
    // cwd = home so the worker resolves the keyring the install actually uses.
    const proc = Bun.spawn(["bun", "-e", CREDENTIAL_WORKER], {
      cwd: home,
      env: { ...process.env, KEELSON_UNINSTALL_ACCOUNTS: JSON.stringify(accounts) },
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return { removed: [], failed: [...accounts] };
    attempts = JSON.parse(stdout) as CredentialAttempt[];
  } catch {
    // A worker that could not run leaves every secret in place; reporting that
    // as "removed nothing" would read as a clean sweep.
    return { removed: [], failed: [...accounts] };
  }
  return classifyCredentialAttempts(accounts, attempts);
}

export async function runUninstall(opts: UninstallOptions): Promise<never> {
  const home = resolveKeelsonHome();
  assertRemovableHome(home, opts.purge, opts.json);

  if (!opts.yes) {
    if (opts.json || !process.stdin.isTTY) {
      fail(
        "uninstall is destructive and needs confirmation; re-run with --yes",
        "BAD_INPUTS",
        opts.json,
      );
    }
    if (!(await confirm(home, opts.purge))) {
      emit({ data: { cancelled: true, home } }, { json: opts.json });
      process.exit(EXIT_OK);
    }
  }

  // Resolved before anything happens — including the server stop — so a config
  // that cannot be read costs nothing. readKeelsonConfig, not loadKeelsonConfig:
  // the latter degrades a malformed file to {}, which here would silently drop
  // every configured gateway from the deletion list and then destroy the home
  // that named them, exiting 0 with those secrets still in the keychain.
  // --keep-credentials is the explicit way past it.
  let accounts: string[] = [];
  if (!opts.keepCredentials) {
    const configRead = readKeelsonConfig(home);
    if (!configRead.ok) {
      fail(
        `cannot read ${configRead.path} (${configRead.reason}), so the gateways it configures cannot be revoked. Nothing was removed — fix the file, or re-run with --keep-credentials to uninstall without touching the keychain`,
        "BAD_CONFIG",
        opts.json,
      );
    }
    accounts = credentialAccounts(configRead.config);
  }

  const ribs = listedRibIds(home);
  // Removing the program files out from under a live server leaves a process
  // holding an open database with no code behind it, so a stop that failed
  // aborts the uninstall rather than being noted and ignored.
  const stop = await serveStop(home);
  const stopError = "error" in stop.payload ? String(stop.payload.error) : null;
  if (stopError && !opts.force) {
    fail(
      `could not stop the server: ${stopError}. Nothing was removed — re-run with --force to uninstall anyway`,
      "SERVER_RUNNING",
      opts.json,
    );
  }
  const serverStatus = stopError
    ? "not stopped (forced)"
    : String((stop.payload as { data?: { status?: unknown } }).data?.status ?? "stopped");

  const credentials: CredentialOutcome = opts.keepCredentials
    ? { removed: [], failed: [] }
    : await deleteCredentials(accounts, home);

  const launcher = launcherPath();
  const launcherRemoved = existsSync(launcher);
  rmSync(launcher, { force: true });

  let marker: string | null = null;
  if (opts.purge) {
    rmSync(home, { recursive: true, force: true });
  } else {
    for (const entry of PROGRAM_ENTRIES) {
      rmSync(join(home, entry), { recursive: true, force: true });
    }
    // Without this a later --purge cannot tell this home from any other
    // directory that has no package.json, and refuses rather than guess.
    try {
      const path = join(home, UNINSTALL_MARKER);
      writeFileSync(path, uninstallMarkerContents(pkg.version, new Date().toISOString()));
      marker = path;
    } catch {
      marker = null;
    }
  }

  const ribCredentialsMayRemain = opts.keepCredentials ? [] : unreachableCredentialRibs(ribs);
  emit(
    {
      data: {
        home,
        purged: opts.purge,
        serverStatus,
        launcher: launcherRemoved ? launcher : null,
        credentialsRemoved: credentials.removed,
        credentialsFailed: credentials.failed,
        ribCredentialsMayRemain,
        dataKept: !opts.purge,
        marker,
      },
    },
    { json: opts.json },
  );

  if (!opts.json) {
    process.stdout.write(
      opts.purge ? `\nremoved ${home}\n` : `\nremoved keelson's program files from ${home}\n`,
    );
    if (!opts.purge) {
      process.stdout.write(
        `kept your data there (keelson.db, workflows/, commands/, config.json, rib data)\n`,
      );
      // This run took the keelson command too, so naming --purge here would
      // point at something the operator can no longer type.
      process.stdout.write(`to discard that data as well, remove ${home} yourself\n`);
      if (!marker) {
        process.stdout.write(
          `could not write ${UNINSTALL_MARKER} to the home; a later \`keelson uninstall --purge\` will refuse it\n`,
        );
      }
    }
    if (launcherRemoved) process.stdout.write(`removed launcher ${launcher}\n`);
    if (credentials.removed.length > 0) {
      process.stdout.write(`revoked keychain entries: ${credentials.removed.join(", ")}\n`);
    }
    if (credentials.failed.length > 0) {
      process.stdout.write(
        `could not remove keychain entries: ${credentials.failed.join(", ")} — remove them by hand\n`,
      );
    }
    // Saying nothing here would read as a clean sweep; the keyring cannot be
    // enumerated, so a rib's own secrets are outside what this command can find.
    if (ribCredentialsMayRemain.length > 0) {
      process.stdout.write(
        `rib credentials cannot be enumerated from the keychain; check entries under the 'keelson' service for: ${ribCredentialsMayRemain
          .map((id) => `rib_${id}_*`)
          .join(", ")}\n`,
      );
    }
    // A launcher installed to a custom KEELSON_BIN_DIR is not discoverable
    // later — the generated launcher persists only KEELSON_HOME — so name the
    // path that was checked rather than let silence imply it was removed.
    if (!launcherRemoved) {
      process.stdout.write(
        `no launcher at ${launcher}; if you installed with KEELSON_BIN_DIR set, remove the launcher there by hand\n`,
      );
    }
    if (process.platform === "win32") {
      process.stdout.write(
        `\nkeelson's bin directory may still be on your user PATH; see the uninstall section of the README to remove it\n`,
      );
    }
  }
  // Everything else is done, but a credential that survived means the promised
  // revocation did not happen — exit non-zero so automation can see it.
  process.exit(credentials.failed.length > 0 ? EXIT_FAIL : EXIT_OK);
}
