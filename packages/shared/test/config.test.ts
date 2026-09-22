// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILT_IN_PROVIDER_IDS,
  isRibWorkflowGrantAllowed,
  type KeelsonConfig,
  loadKeelsonConfig,
  readKeelsonConfig,
  resolveDefaultProvider,
  resolveEnabledProviders,
  resolveMcpSettings,
  resolveRibApprovalGrants,
  resolveRibWorkflowGrants,
  resolveWorkflowPreflight,
} from "../src/config.ts";

const KNOWN = BUILT_IN_PROVIDER_IDS;
const silent = () => {};

describe("loadKeelsonConfig", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-config-"));
    delete process.env.KEELSON_CONFIG;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  function writeConfig(body: string): void {
    writeFileSync(join(home, "config.json"), body);
  }

  test("missing file returns an empty config (defaults apply)", () => {
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  // An unknown key is stripped rather than rejected, so a grant that does not
  // round-trip through the reader would look like it took effect and quietly
  // grant nothing.
  test("retains crossRibGrants written to disk", () => {
    writeConfig(
      JSON.stringify({
        providers: { copilot: true },
        crossRibGrants: { chamber: { osdu: ["*"] }, squad: { osdu: ["osdu_release"] } },
      }),
    );
    expect(loadKeelsonConfig(home).crossRibGrants).toEqual({
      chamber: { osdu: ["*"] },
      squad: { osdu: ["osdu_release"] },
    });
  });

  test("retains ribApprovalGrants written to disk", () => {
    writeConfig(JSON.stringify({ ribApprovalGrants: { chat: ["fix-issue"] } }));
    expect(loadKeelsonConfig(home).ribApprovalGrants).toEqual({ chat: ["fix-issue"] });
  });

  test("ignores a malformed crossRibGrants rather than failing boot", () => {
    writeConfig(
      JSON.stringify({ defaultProvider: "copilot", crossRibGrants: { chamber: "osdu" } }),
    );
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  test("reads a valid config", () => {
    writeConfig(JSON.stringify({ providers: { claude: true }, defaultProvider: "claude" }));
    expect(loadKeelsonConfig(home)).toEqual({
      providers: { claude: true },
      defaultProvider: "claude",
    });
  });

  test("invalid JSON degrades to {} without throwing", () => {
    writeConfig("{ not json");
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  test("shape mismatch degrades to {} without throwing", () => {
    // providers values must be booleans
    writeConfig(JSON.stringify({ providers: { claude: "yes" } }));
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  test("unknown top-level keys are stripped, known ones kept", () => {
    writeConfig(JSON.stringify({ defaultProvider: "copilot", future: { x: 1 } }));
    expect(loadKeelsonConfig(home)).toEqual({ defaultProvider: "copilot" });
  });

  test("reads claude.auth when valid", () => {
    writeConfig(JSON.stringify({ providers: { claude: true }, claude: { auth: "subscription" } }));
    expect(loadKeelsonConfig(home)).toEqual({
      providers: { claude: true },
      claude: { auth: "subscription" },
    });
  });

  test("an invalid claude.auth value degrades the config to {}", () => {
    writeConfig(JSON.stringify({ claude: { auth: "bogus" } }));
    expect(loadKeelsonConfig(home)).toEqual({});
  });

  test("KEELSON_CONFIG overrides the home path", () => {
    const other = mkdtempSync(join(tmpdir(), "keelson-config-alt-"));
    try {
      writeFileSync(join(other, "config.json"), JSON.stringify({ defaultProvider: "stub" }));
      process.env.KEELSON_CONFIG = join(other, "config.json");
      expect(loadKeelsonConfig(home)).toEqual({ defaultProvider: "stub" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// loadKeelsonConfig collapses "declares nothing" and "could not be read" into the
// same {}. readKeelsonConfig keeps them apart for the callers that assert something
// about the file's contents, without changing what loadKeelsonConfig hands anyone.
describe("readKeelsonConfig", () => {
  let home: string;
  const envBefore = process.env.KEELSON_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keelson-config-read-"));
    delete process.env.KEELSON_CONFIG;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.KEELSON_CONFIG;
    else process.env.KEELSON_CONFIG = envBefore;
  });

  function writeConfig(body: string): void {
    writeFileSync(join(home, "config.json"), body);
  }

  test("a missing file declares nothing, which is not a failure", () => {
    expect(readKeelsonConfig(home)).toEqual({ ok: true, config: {} });
  });

  test("a valid file returns its config", () => {
    writeConfig(JSON.stringify({ defaultProvider: "claude" }));
    expect(readKeelsonConfig(home)).toEqual({ ok: true, config: { defaultProvider: "claude" } });
  });

  test("invalid JSON is a failure carrying the path and the reason", () => {
    writeConfig("{ not json");
    const result = readKeelsonConfig(home);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.path).toBe(join(home, "config.json"));
    expect(result.reason).toContain("invalid JSON");
  });

  test("a shape mismatch is a failure naming where it failed", () => {
    writeConfig(JSON.stringify({ crossRibGrants: { chamber: { osdu: "osdu_security" } } }));
    const result = readKeelsonConfig(home);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toContain("crossRibGrants.chamber.osdu");
  });

  // The tolerant contract every other caller depends on is unchanged: whatever
  // readKeelsonConfig rejects, loadKeelsonConfig still degrades to {}.
  test("loadKeelsonConfig still degrades every failure readKeelsonConfig reports", () => {
    writeConfig(JSON.stringify({ providers: { claude: "yes" } }));
    expect(readKeelsonConfig(home).ok).toBe(false);
    expect(loadKeelsonConfig(home)).toEqual({});
  });
});

describe("resolveEnabledProviders", () => {
  test("empty config → defaults: copilot only (stub, claude, pi off)", () => {
    const enabled = resolveEnabledProviders({ config: {}, known: KNOWN, onWarn: silent });
    expect(enabled).toEqual(["copilot"]);
  });

  test("config flips claude on and copilot off", () => {
    const config: KeelsonConfig = { providers: { claude: true, copilot: false } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual(["claude"]);
  });

  test("output preserves canonical (known) order, not config order", () => {
    const config: KeelsonConfig = { providers: { claude: true } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual([
      "copilot",
      "claude",
    ]);
  });

  test("KEELSON_PROVIDERS env is an exact override, ignoring config + defaults", () => {
    const config: KeelsonConfig = { providers: { claude: true, copilot: false } };
    expect(
      resolveEnabledProviders({ config, envProviders: "claude", known: KNOWN, onWarn: silent }),
    ).toEqual(["claude"]);
  });

  test("env override: dedupes, lowercases, drops unknowns", () => {
    expect(
      resolveEnabledProviders({
        config: {},
        envProviders: "STUB, copilot ,stub,nope",
        known: KNOWN,
        onWarn: silent,
      }),
    ).toEqual(["stub", "copilot"]);
  });

  test("empty/whitespace env falls through to config/defaults (not an empty list)", () => {
    expect(
      resolveEnabledProviders({ config: {}, envProviders: "   ", known: KNOWN, onWarn: silent }),
    ).toEqual(["copilot"]);
  });

  test("unknown provider in config map is ignored", () => {
    const config: KeelsonConfig = { providers: { ollama: true } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual(["copilot"]);
  });

  test("pi is a known provider, opt-in via config", () => {
    const config: KeelsonConfig = { providers: { pi: true } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual([
      "copilot",
      "pi",
    ]);
  });

  test("codex is a known provider, opt-in via config (after pi in registration order)", () => {
    const config: KeelsonConfig = { providers: { codex: true } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual([
      "copilot",
      "codex",
    ]);
  });

  test("stub is off by default, opt-in via config", () => {
    const config: KeelsonConfig = { providers: { stub: true } };
    expect(resolveEnabledProviders({ config, known: KNOWN, onWarn: silent })).toEqual([
      "stub",
      "copilot",
    ]);
  });
});

describe("resolveDefaultProvider", () => {
  test("honors config.defaultProvider when registered", () => {
    expect(
      resolveDefaultProvider({ defaultProvider: "claude" }, ["stub", "copilot", "claude"]),
    ).toBe("claude");
  });

  test("ignores config.defaultProvider when not registered, prefers copilot", () => {
    expect(resolveDefaultProvider({ defaultProvider: "claude" }, ["stub", "copilot"])).toBe(
      "copilot",
    );
  });

  test("prefers copilot when no config preference", () => {
    expect(resolveDefaultProvider({}, ["stub", "copilot", "claude"])).toBe("copilot");
  });

  test("falls to first real provider when copilot absent (claude-only)", () => {
    expect(resolveDefaultProvider({}, ["stub", "claude"])).toBe("claude");
  });

  test("falls to stub when nothing real is registered", () => {
    expect(resolveDefaultProvider({}, ["stub", "workflow"])).toBe("stub");
  });

  test("returns undefined when nothing is registered", () => {
    expect(resolveDefaultProvider({}, [])).toBeUndefined();
  });

  test("never returns the synthetic 'workflow' provider as the default", () => {
    expect(resolveDefaultProvider({}, ["workflow"])).toBeUndefined();
    expect(resolveDefaultProvider({ defaultProvider: "workflow" }, ["workflow"])).toBeUndefined();
  });
});

describe("resolveWorkflowPreflight", () => {
  const envBefore = process.env.KEELSON_WORKFLOW_PREFLIGHT;

  beforeEach(() => {
    delete process.env.KEELSON_WORKFLOW_PREFLIGHT;
  });

  afterEach(() => {
    if (envBefore === undefined) delete process.env.KEELSON_WORKFLOW_PREFLIGHT;
    else process.env.KEELSON_WORKFLOW_PREFLIGHT = envBefore;
  });

  test("defaults to enabled", () => {
    expect(resolveWorkflowPreflight({})).toBe(true);
  });

  test("honors the config value", () => {
    expect(resolveWorkflowPreflight({ workflowPreflight: false })).toBe(false);
    expect(resolveWorkflowPreflight({ workflowPreflight: true })).toBe(true);
  });

  test.each(["0", "false", "off", " FALSE "])(
    "environment value %s disables a configured preflight",
    (value) => {
      process.env.KEELSON_WORKFLOW_PREFLIGHT = value;
      expect(resolveWorkflowPreflight({ workflowPreflight: true })).toBe(false);
    },
  );

  test("an explicit false overrides environment and config", () => {
    process.env.KEELSON_WORKFLOW_PREFLIGHT = "1";
    expect(resolveWorkflowPreflight({ workflowPreflight: true }, false)).toBe(false);
  });
});

describe("resolveMcpSettings", () => {
  test("defaults: enabled, state-changing exposed, no token, no denylist", () => {
    expect(resolveMcpSettings({}, {})).toEqual({
      enabled: true,
      exposeStateChanging: true,
      toolDenylist: [],
      requireToken: false,
    });
  });

  test("exposeStateChanging is the one default that config can switch off", () => {
    expect(
      resolveMcpSettings({ mcp: { exposeStateChanging: false } }, {}).exposeStateChanging,
    ).toBe(false);
  });

  test("KEELSON_MCP_EXPOSE_STATE_CHANGING=0 forces read-only over a default/true config", () => {
    const env = { KEELSON_MCP_EXPOSE_STATE_CHANGING: "0" };
    expect(resolveMcpSettings({}, env).exposeStateChanging).toBe(false);
    expect(
      resolveMcpSettings({ mcp: { exposeStateChanging: true } }, env).exposeStateChanging,
    ).toBe(false);
  });

  test("config values are honored", () => {
    expect(
      resolveMcpSettings(
        {
          mcp: {
            enabled: false,
            exposeStateChanging: true,
            requireToken: true,
            toolDenylist: ["a"],
          },
        },
        {},
      ),
    ).toEqual({
      enabled: false,
      exposeStateChanging: true,
      toolDenylist: ["a"],
      requireToken: true,
    });
  });

  test("env overrides win over config and merge denylists", () => {
    const out = resolveMcpSettings(
      { mcp: { enabled: true, exposeStateChanging: false, toolDenylist: ["a"] } },
      {
        KEELSON_MCP_DISABLED: "1",
        KEELSON_MCP_EXPOSE_STATE_CHANGING: "1",
        KEELSON_MCP_REQUIRE_TOKEN: "1",
        KEELSON_MCP_DENYLIST: "b, c ,a",
      },
    );
    expect(out.enabled).toBe(false);
    expect(out.exposeStateChanging).toBe(true);
    expect(out.requireToken).toBe(true);
    expect(out.toolDenylist).toEqual(["a", "b", "c"]);
  });
});

describe("resolveRibWorkflowGrants", () => {
  test("denies a rib with no entry", () => {
    const grants = resolveRibWorkflowGrants({}, {});
    expect(isRibWorkflowGrantAllowed(grants, "chat", "fix-issue")).toBe(false);
  });

  test("grants only the named workflows to the named rib", () => {
    const grants = resolveRibWorkflowGrants({ ribWorkflowGrants: { chat: ["fix-issue"] } }, {});
    expect(isRibWorkflowGrantAllowed(grants, "chat", "fix-issue")).toBe(true);
    expect(isRibWorkflowGrantAllowed(grants, "chat", "resolve-pr")).toBe(false);
    expect(isRibWorkflowGrantAllowed(grants, "squad", "fix-issue")).toBe(false);
  });

  test("unions the env string with the config and trims both", () => {
    const grants = resolveRibWorkflowGrants(
      { ribWorkflowGrants: { chat: [" fix-issue "] } },
      { KEELSON_RIB_WORKFLOW_GRANTS: "chat: resolve-pr ; squad:*; malformed" },
    );
    expect(isRibWorkflowGrantAllowed(grants, "chat", "fix-issue")).toBe(true);
    expect(isRibWorkflowGrantAllowed(grants, "chat", "resolve-pr")).toBe(true);
    expect(isRibWorkflowGrantAllowed(grants, "squad", "anything")).toBe(true);
    expect(grants.has("malformed")).toBe(false);
  });
});

describe("resolveRibApprovalGrants", () => {
  test("denies a rib with no entry, even one granted the workflow's start", () => {
    const grants = resolveRibApprovalGrants({ ribWorkflowGrants: { chat: ["fix-issue"] } }, {});
    expect(isRibWorkflowGrantAllowed(grants, "chat", "fix-issue")).toBe(false);
  });

  test("unions the env string with the config", () => {
    const grants = resolveRibApprovalGrants(
      { ribApprovalGrants: { chat: ["fix-issue"] } },
      { KEELSON_RIB_APPROVAL_GRANTS: "chat:resolve-pr" },
    );
    expect(isRibWorkflowGrantAllowed(grants, "chat", "fix-issue")).toBe(true);
    expect(isRibWorkflowGrantAllowed(grants, "chat", "resolve-pr")).toBe(true);
    expect(isRibWorkflowGrantAllowed(grants, "chat", "plan-act-evaluate")).toBe(false);
  });
});
