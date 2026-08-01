// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadKeelsonConfig } from "@keelson/shared/config";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_OK } from "../exit.ts";
import { listedRibIds, resolveKeelsonHome } from "../home.ts";
import { emit } from "../output.ts";
import {
  credentialAccounts,
  PROGRAM_ENTRIES,
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

// The home doubles as a source checkout's data dir in dev (paths.ts walks up to
// <repo>/.keelson), where removing "program files" would delete the developer's
// node_modules. An installed home is the one carrying an @keelson/cli dep.
function assertInstalledHome(home: string, json: boolean): void {
  try {
    const manifest = JSON.parse(readFileSync(join(home, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    if (manifest.dependencies?.["@keelson/cli"]) return;
  } catch {
    // fall through to the shared refusal below
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

// Returns false when the account held nothing, throws on a real backend error.
export type DeleteCredentialFn = (service: string, account: string) => boolean;

async function loadDeleter(): Promise<DeleteCredentialFn | null> {
  try {
    const mod = await import("@napi-rs/keyring");
    return (service, account) => new mod.Entry(service, account).deleteCredential();
  } catch {
    return null;
  }
}

export async function deleteCredentials(
  accounts: readonly string[],
  deleter?: DeleteCredentialFn | null,
): Promise<{ removed: string[]; failed: string[] }> {
  const remove = deleter === undefined ? await loadDeleter() : deleter;
  // A keyring the platform cannot load leaves every secret in place; reporting
  // that as "removed nothing" would read as a clean sweep.
  if (!remove) return { removed: [], failed: [...accounts] };
  const removed: string[] = [];
  const failed: string[] = [];
  for (const account of accounts) {
    try {
      if (remove(KEYRING_SERVICE, account)) removed.push(account);
    } catch (err) {
      // A missing entry is the common case and not a failure; anything else is.
      const message = err instanceof Error ? err.message.toLowerCase() : "";
      if (!message.includes("no entry") && !message.includes("not found")) failed.push(account);
    }
  }
  return { removed, failed };
}

export async function runUninstall(opts: UninstallOptions): Promise<never> {
  const home = resolveKeelsonHome();
  assertInstalledHome(home, opts.json);

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

  const credentials = opts.keepCredentials
    ? { removed: [], failed: [] }
    : await deleteCredentials(credentialAccounts(loadKeelsonConfig(home)));

  const launcher = launcherPath();
  const launcherRemoved = existsSync(launcher);
  rmSync(launcher, { force: true });

  if (opts.purge) {
    rmSync(home, { recursive: true, force: true });
  } else {
    for (const entry of PROGRAM_ENTRIES) {
      rmSync(join(home, entry), { recursive: true, force: true });
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
    if (process.platform === "win32") {
      process.stdout.write(
        `\nkeelson's bin directory may still be on your user PATH; see the uninstall section of the README to remove it\n`,
      );
    }
  }
  process.exit(EXIT_OK);
}
