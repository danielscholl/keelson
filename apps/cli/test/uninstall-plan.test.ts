// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { KeelsonConfig } from "@keelson/shared/config";
import { deleteCredentials } from "../src/commands/uninstall.ts";
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

describe("deleteCredentials", () => {
  test("reports the accounts that actually held a secret", async () => {
    const held = new Set(["claude", "gateway-ollama"]);
    const result = await deleteCredentials(
      ["claude", "copilot", "gateway-ollama"],
      (_service, account) => held.delete(account),
    );
    expect(result.removed).toEqual(["claude", "gateway-ollama"]);
    expect(result.failed).toEqual([]);
  });

  test("a missing entry is not a failure", async () => {
    const result = await deleteCredentials(["copilot"], () => {
      throw new Error("No entry found in the keyring");
    });
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("a real backend error is reported, not swallowed", async () => {
    const result = await deleteCredentials(["claude"], () => {
      throw new Error("keyring locked by policy");
    });
    expect(result.failed).toEqual(["claude"]);
  });

  // Every secret survives an unloadable keyring, so an empty `removed` here
  // would read as success when nothing was revoked at all.
  test("an unavailable keyring fails every account instead of reporting none", async () => {
    const result = await deleteCredentials(["claude", "copilot"], null);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual(["claude", "copilot"]);
  });

  test("passes keelson's keyring service to the backend", async () => {
    const seen: string[] = [];
    await deleteCredentials(["claude"], (service) => {
      seen.push(service);
      return true;
    });
    expect(seen).toEqual(["keelson"]);
  });
});
