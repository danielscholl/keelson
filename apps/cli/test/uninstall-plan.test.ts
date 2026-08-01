// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { KeelsonConfig } from "@keelson/shared/config";
import { classifyCredentialAttempts } from "../src/commands/uninstall.ts";
import {
  credentialAccounts,
  PROGRAM_ENTRIES,
  unreachableCredentialRibs,
} from "../src/uninstall-plan.ts";

function config(overrides: Partial<KeelsonConfig> = {}): KeelsonConfig {
  return { ...overrides } as KeelsonConfig;
}

describe("credentialAccounts", () => {
  test("covers the built-in providers keelson stores keys for", () => {
    expect(credentialAccounts(config())).toEqual(["claude", "copilot"]);
  });

  test("includes a keychain account per configured gateway", () => {
    const accounts = credentialAccounts(
      config({
        gateways: [
          { name: "ollama", baseUrl: "http://localhost:11434/v1", protocol: "openai" },
          { name: "open-router", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai" },
        ],
      }),
    );
    expect(accounts).toContain("gateway-ollama");
    expect(accounts).toContain("gateway-open-router");
  });

  // codex and pi keep their own auth files outside the keychain, so listing
  // them here would delete nothing and imply a revocation that never happened.
  test("omits the self-managed providers", () => {
    const accounts = credentialAccounts(config());
    expect(accounts).not.toContain("codex");
    expect(accounts).not.toContain("pi");
  });
});

describe("unreachableCredentialRibs", () => {
  // The keyring resolves by exact (service, account) and cannot enumerate, so
  // rib-stored secrets have to be reported rather than silently left behind.
  test("reports every installed rib, sorted", () => {
    expect(unreachableCredentialRibs(["osdu", "chamber"])).toEqual(["chamber", "osdu"]);
  });

  test("is empty when no ribs are installed", () => {
    expect(unreachableCredentialRibs([])).toEqual([]);
  });
});

describe("PROGRAM_ENTRIES", () => {
  // A non-purge uninstall removes exactly these from the home; anything else
  // there is operator data and must survive.
  test("names only the installer-provisioned bun project files", () => {
    expect([...PROGRAM_ENTRIES]).toEqual(["node_modules", "package.json", "bun.lock", ".npmrc"]);
  });

  test("never touches the data the home exists to hold", () => {
    for (const data of ["keelson.db", "workflows", "commands", "config.json", "rib-osdu"]) {
      expect(PROGRAM_ENTRIES as readonly string[]).not.toContain(data);
    }
  });
});

describe("classifyCredentialAttempts", () => {
  test("reports the accounts that actually held a secret", () => {
    const out = classifyCredentialAttempts(
      ["claude", "copilot", "gateway-ollama"],
      [
        { account: "claude", deleted: true },
        { account: "copilot", deleted: false },
        { account: "gateway-ollama", deleted: true },
      ],
    );
    expect(out.removed).toEqual(["claude", "gateway-ollama"]);
    expect(out.failed).toEqual([]);
  });

  test("a missing entry is not a failure", () => {
    const out = classifyCredentialAttempts(
      ["copilot"],
      [{ account: "copilot", error: "No entry found in the keyring" }],
    );
    expect(out).toEqual({ removed: [], failed: [] });
  });

  test("a real backend error is reported, not swallowed", () => {
    const out = classifyCredentialAttempts(
      ["claude"],
      [{ account: "claude", error: "keyring locked by policy" }],
    );
    expect(out.failed).toEqual(["claude"]);
  });

  // An unloadable keyring makes the worker report an error per account; every
  // secret survives, so an empty `failed` would read as a clean sweep.
  test("a keyring that would not load fails every account", () => {
    const accounts = ["claude", "copilot"];
    const out = classifyCredentialAttempts(
      accounts,
      accounts.map((account) => ({ account, error: "Cannot find module @napi-rs/keyring" })),
    );
    expect(out.failed).toEqual(accounts);
  });

  // A worker that dies mid-list leaves later accounts unreported. Treating an
  // absent result as success would claim a revocation that never ran.
  test("an unreported account counts as failed, not clean", () => {
    const out = classifyCredentialAttempts(
      ["claude", "copilot"],
      [{ account: "claude", deleted: true }],
    );
    expect(out.removed).toEqual(["claude"]);
    expect(out.failed).toEqual(["copilot"]);
  });
});
