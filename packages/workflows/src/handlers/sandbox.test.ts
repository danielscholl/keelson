// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { hostLauncher } from "./launcher.ts";
import {
  type CreateSandboxPolicyOptions,
  createOperatorSandboxPolicy,
  createSandboxLaunchDir,
  createSandboxPolicy,
  defaultSandboxProfile,
  disposeSandboxLaunchDir,
  mergeSandboxProfiles,
  parseMainWorktree,
  pickSandboxEnv,
  prepareSandboxScratch,
  resolveSandboxPath,
  type SandboxProfile,
  type SandboxRuntime,
  sandboxUnavailableMessage,
  writeSandboxBody,
} from "./sandbox.ts";
import { SubprocessSpawnError } from "./subprocess.ts";

// Every path is built from these roots with the platform path module, so the
// expectations hold on Windows too.
const ROOT = resolve(tmpdir(), "keelson-sandbox-policy");
const HOST_HOME = join(ROOT, "user");
const HOME = join(ROOT, "keelson-home");
const DB = join(HOME, "keelson.db");
const CWD = join(ROOT, "repo");
const ARTIFACTS = join(ROOT, "artifacts", "run-1");
const BIN = join(ROOT, "bin");
const TOOL_DIR = join(ROOT, "tools", "bin");

const fakeRuntime: SandboxRuntime = {
  backend: "fake",
  createLauncher: () => hostLauncher,
};

function policyOptions(
  overrides: Partial<CreateSandboxPolicyOptions> = {},
): CreateSandboxPolicyOptions {
  return {
    floor: false,
    defaultEnabled: false,
    home: HOME,
    dbPath: DB,
    bundledBinDir: BIN,
    resolveGitCommonDir: () => undefined,
    resolveRepoRoot: () => undefined,
    hostHome: HOST_HOME,
    hostPath: [TOOL_DIR, "relative/dir"].join(delimiter),
    exists: () => false,
    canonical: (p) => p,
    ...overrides,
  };
}

const ctx = { cwd: CWD, artifactsDir: ARTIFACTS };

describe("resolve: precedence and floor", () => {
  test("default off: a node that does not choose runs unconfined", () => {
    const policy = createSandboxPolicy(policyOptions());
    expect(policy.resolve(undefined, ctx)).toEqual({ profile: null, outcome: "off" });
  });

  test("default off: an explicit enabled: true still resolves a profile and fails closed without a runtime", () => {
    const policy = createSandboxPolicy(policyOptions());
    const res = policy.resolve({ enabled: true }, ctx);
    expect(res.profile?.enabled).toBe(true);
    expect(res.outcome).toBe("off");
    expect(res.fail).toBe(sandboxUnavailableMessage("no sandbox runtime is installed", false));
    expect(res.fail).toContain("keelson sandbox install");
    expect(res.fail).toContain("sandbox: { enabled: false }");
  });

  test("default on: a node opting out runs unconfined; others need the runtime", () => {
    const policy = createSandboxPolicy(policyOptions({ defaultEnabled: true }));
    expect(policy.resolve({ enabled: false }, ctx)).toEqual({ profile: null, outcome: "off" });
    expect(policy.resolve(undefined, ctx).fail).toContain("sandbox required but unavailable");
  });

  test("node beats workflow beats the default", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    expect(policy.resolve(undefined, { ...ctx, workflowSandbox: { enabled: true } }).outcome).toBe(
      "mxc",
    );
    expect(
      policy.resolve({ enabled: false }, { ...ctx, workflowSandbox: { enabled: true } }).outcome,
    ).toBe("off");
    const onByDefault = createSandboxPolicy(
      policyOptions({ defaultEnabled: true, runtime: fakeRuntime }),
    );
    expect(
      onByDefault.resolve(undefined, { ...ctx, workflowSandbox: { enabled: false } }).profile,
    ).toBeNull();
  });

  test("the floor ignores enabled: false and names its own opt-out in the failure", () => {
    const policy = createSandboxPolicy(policyOptions({ floor: true }));
    const res = policy.resolve({ enabled: false }, { ...ctx, workflowSandbox: { enabled: false } });
    expect(res.profile?.enabled).toBe(true);
    expect(res.fail).toContain("KEELSON_SANDBOX=required");
    expect(res.fail).not.toContain("set `sandbox: { enabled: false }`");
  });

  test("with a runtime the node runs in it and reports its backend", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime, floor: true }));
    const res = policy.resolve(undefined, ctx);
    expect(res).toMatchObject({ outcome: "mxc", backend: "fake" });
    expect(res.fail).toBeUndefined();
  });

  test("a prompt node is confined by its provider, or fails closed when it cannot be", () => {
    const policy = createSandboxPolicy(policyOptions({ floor: true }));
    expect(
      policy.resolve(undefined, { ...ctx, provider: { id: "claude", support: "native" } }),
    ).toMatchObject({ outcome: "provider", backend: "claude" });
    const res = policy.resolve(undefined, { ...ctx, provider: { id: "stub", support: "none" } });
    expect(res.outcome).toBe("off");
    expect(res.fail).toContain("provider 'stub' cannot sandbox its tools");
    expect(res.fail).toContain("switch to a provider that can sandbox");
    expect(res.fail).toContain("KEELSON_SANDBOX=required");
    expect(res.fail).not.toContain("keelson sandbox install");
  });

  test("a prompt node can run git: its config reads, and a worktree's shared git dir writes", () => {
    const gitDir = join(ROOT, "main-repo", ".git");
    const gitconfig = join(HOST_HOME, ".gitconfig");
    const xdg = join(HOST_HOME, ".config", "git");
    const present = new Set([gitconfig, xdg, join(xdg, "credentials")]);
    const policy = createSandboxPolicy(
      policyOptions({
        floor: true,
        resolveGitCommonDir: () => gitDir,
        exists: (p) => present.has(p),
      }),
    );
    const res = policy.resolve(undefined, {
      ...ctx,
      provider: { id: "copilot", support: "native" },
    });
    expect(res.profile?.filesystem.readwrite).toEqual([CWD, ARTIFACTS, gitDir]);
    expect(res.profile?.filesystem.readonly).toEqual([gitconfig]);
    expect(res.profile?.network.outbound).toBe("deny");
  });

  test("a provider with no tools of its own runs as is, even under the floor", () => {
    const policy = createSandboxPolicy(policyOptions({ floor: true }));
    expect(
      policy.resolve(undefined, { ...ctx, provider: { id: "stub", support: "unneeded" } }),
    ).toEqual({ profile: null, outcome: "off", backend: "unneeded" });
  });

  test("a provider failure without the floor names the node opt-out, not the install", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const res = policy.resolve(
      { enabled: true },
      { ...ctx, provider: { id: "stub", support: "none" } },
    );
    expect(res.fail).toBe(
      "sandbox required but unavailable: provider 'stub' cannot sandbox its tools; switch to a provider that can sandbox or set `sandbox: { enabled: false }` on the node",
    );
  });

  test("a `..` path fails the node with a readable reason", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const res = policy.resolve({ enabled: true, filesystem: { readwrite: ["../escape"] } }, ctx);
    expect(res.profile).toBeNull();
    expect(res.fail).toBe("sandbox path '../escape' contains '..'; write the path it means");
  });

  test("the git common dir is added when a worktree's .git lives outside cwd", () => {
    const gitDir = join(ROOT, "main-repo", ".git");
    const policy = createSandboxPolicy(
      policyOptions({ runtime: fakeRuntime, resolveGitCommonDir: () => gitDir }),
    );
    expect(policy.resolve({ enabled: true }, ctx).profile?.filesystem.readwrite).toContain(gitDir);
    const inside = createSandboxPolicy(
      policyOptions({ runtime: fakeRuntime, resolveGitCommonDir: () => join(CWD, ".git") }),
    );
    expect(inside.resolve({ enabled: true }, ctx).profile?.filesystem.readwrite).toEqual([
      CWD,
      ARTIFACTS,
    ]);
  });

  test("git is never consulted for a node that resolves unsandboxed", () => {
    let calls = 0;
    const policy = createSandboxPolicy(
      policyOptions({
        resolveGitCommonDir: () => {
          calls++;
          return undefined;
        },
      }),
    );
    policy.resolve(undefined, ctx);
    expect(calls).toBe(0);
  });
});

describe("the built-in profile", () => {
  const built = defaultSandboxProfile({
    cwd: CWD,
    artifactsDir: ARTIFACTS,
    home: HOME,
    dbPath: DB,
    bundledBinDir: BIN,
    hostHome: HOST_HOME,
    hostPath: [TOOL_DIR, join(HOST_HOME, ".bun", "bin"), "relative"].join(delimiter),
    exists: (p) => p === join(HOST_HOME, ".bun"),
  });

  test("writes only to cwd and the artifacts dir; network denied", () => {
    expect(built.filesystem.readwrite).toEqual([CWD, ARTIFACTS]);
    expect(built.network).toEqual({ outbound: "deny" });
    expect(built.env).toEqual([]);
  });

  test("reads the bundled bin, keelson scripts, git config, existing toolchains, and PATH dirs", () => {
    expect(built.filesystem.readonly).toEqual([
      BIN,
      join(HOME, "scripts"),
      join(HOME, "node_modules"),
      join(HOST_HOME, ".gitconfig"),
      join(HOST_HOME, ".config", "git", "config"),
      join(HOST_HOME, ".config", "git", "ignore"),
      join(HOST_HOME, ".config", "git", "attributes"),
      join(HOST_HOME, ".bun"),
      TOOL_DIR,
    ]);
  });

  test("denies credentials and keelson's own database, server state, and config", () => {
    const denied = built.filesystem.denied;
    for (const p of [
      join(HOST_HOME, ".ssh"),
      join(HOST_HOME, ".aws"),
      join(HOST_HOME, ".config", "gh"),
      join(HOST_HOME, ".git-credentials"),
      join(HOST_HOME, ".config", "git", "credentials"),
      join(HOST_HOME, ".claude"),
      DB,
      `${DB}-wal`,
      `${DB}-shm`,
      join(HOME, "server.json"),
      join(HOME, "config.json"),
    ]) {
      expect(denied).toContain(p);
    }
  });
});

describe("toolchain prefixes", () => {
  test("app bundles are readable when the host has them", () => {
    const withApps = defaultSandboxProfile({
      cwd: CWD,
      home: HOME,
      dbPath: DB,
      bundledBinDir: BIN,
      hostHome: HOST_HOME,
      hostPath: "",
      exists: (p) => p === "/Applications",
    });
    expect(withApps.filesystem.readonly).toContain("/Applications");
    const without = defaultSandboxProfile({
      cwd: CWD,
      home: HOME,
      dbPath: DB,
      bundledBinDir: BIN,
      hostHome: HOST_HOME,
      hostPath: "",
      exists: () => false,
    });
    expect(without.filesystem.readonly).not.toContain("/Applications");
  });
});

describe("mergeSandboxProfiles", () => {
  const base: SandboxProfile = {
    enabled: false,
    filesystem: { readwrite: [CWD], readonly: [BIN], denied: [join(HOST_HOME, ".ssh")] },
    network: { outbound: "deny" },
    env: ["KEEP"],
  };
  const opts = { cwd: CWD, hostHome: HOST_HOME };

  test("paths and env add; enabled and network override", () => {
    expect(
      mergeSandboxProfiles(
        base,
        {
          enabled: true,
          filesystem: { readwrite: ["out"], readonly: ["~/data"], denied: [join(ROOT, "x")] },
          network: { outbound: "allow", loopback: true },
          env: ["GH_TOKEN", "KEEP"],
        },
        opts,
      ),
    ).toEqual({
      enabled: true,
      filesystem: {
        readwrite: [CWD, join(CWD, "out")],
        readonly: [BIN, join(HOST_HOME, "data")],
        denied: [join(HOST_HOME, ".ssh"), join(ROOT, "x")],
      },
      network: { outbound: "allow", loopback: true },
      env: ["KEEP", "GH_TOKEN"],
    });
  });

  test("an author cannot remove a default deny", () => {
    const merged = mergeSandboxProfiles(base, { filesystem: { readwrite: ["~/.ssh"] } }, opts);
    expect(merged.filesystem.denied).toContain(join(HOST_HOME, ".ssh"));
  });

  test("backend keys merge per SDK", () => {
    const merged = mergeSandboxProfiles(
      { ...base, backend: { claude: { a: 1 } } },
      { backend: { claude: { b: 2 }, codex: { mode: "read-only" } } },
      opts,
    );
    expect(merged.backend).toEqual({ claude: { a: 1, b: 2 }, codex: { mode: "read-only" } });
  });
});

describe("resolveSandboxPath", () => {
  const opts = { cwd: CWD, hostHome: HOST_HOME };
  test("~ is the host home, relative is against cwd, absolute is normalized", () => {
    expect(resolveSandboxPath("~", opts)).toBe(HOST_HOME);
    expect(resolveSandboxPath("~/.cache", opts)).toBe(join(HOST_HOME, ".cache"));
    expect(resolveSandboxPath("build/out", opts)).toBe(join(CWD, "build", "out"));
    expect(resolveSandboxPath(join(ROOT, "abs"), opts)).toBe(join(ROOT, "abs"));
  });

  test("`..` is refused in any position", () => {
    for (const raw of ["..", "../x", "a/../b", `${ROOT}/../etc`, "a\\..\\b"]) {
      expect(() => resolveSandboxPath(raw, opts)).toThrow("contains '..'");
    }
  });

  test("$REPO_ROOT names the repository root when one is known", () => {
    const repo = join(ROOT, "repo");
    const inWorktree = {
      cwd: join(repo, ".worktrees", "run-1"),
      hostHome: HOST_HOME,
      repoRoot: () => repo,
    };
    expect(resolveSandboxPath("$REPO_ROOT", inWorktree)).toBe(repo);
    expect(resolveSandboxPath("$REPO_ROOT/.beads", inWorktree)).toBe(join(repo, ".beads"));
    expect(() => resolveSandboxPath("$REPO_ROOT/../x", inWorktree)).toThrow("contains '..'");
  });

  test("$REPO_ROOT outside a checkout fails with the reason", () => {
    expect(() => resolveSandboxPath("$REPO_ROOT/.beads", opts)).toThrow(
      "not inside a git checkout",
    );
    expect(() => resolveSandboxPath("$REPO_ROOT", { ...opts, repoRoot: () => undefined })).toThrow(
      "not inside a git checkout",
    );
    expect(resolveSandboxPath("$REPO_ROOTS", { ...opts, repoRoot: () => ROOT })).toBe(
      join(CWD, "$REPO_ROOTS"),
    );
  });

  test("the root is looked up only when a path uses the token", () => {
    let calls = 0;
    const lazy = {
      ...opts,
      repoRoot: () => {
        calls += 1;
        return ROOT;
      },
    };
    resolveSandboxPath("~/x", lazy);
    resolveSandboxPath("plain", lazy);
    expect(calls).toBe(0);
    resolveSandboxPath("$REPO_ROOT/a", lazy);
    expect(calls).toBe(1);
  });
});

describe("parseMainWorktree", () => {
  test("takes the first entry, which is the main worktree", () => {
    const out = [
      "worktree /super/lib",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/main",
      "",
      "worktree /super/lib/.worktrees/run-1",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/run-1",
      "",
    ].join("\n");
    expect(parseMainWorktree(out)).toBe("/super/lib");
  });

  test("a bare repository names no checkout", () => {
    expect(parseMainWorktree("worktree /srv/bare.git\nbare\n\n")).toBeUndefined();
    expect(parseMainWorktree("")).toBeUndefined();
  });

  test("CRLF output parses", () => {
    expect(
      parseMainWorktree("worktree C:/src/repo\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n"),
    ).toBe("C:/src/repo");
  });
});

describe("pickSandboxEnv", () => {
  const scratch = join(ROOT, "scratch");
  const host = {
    KEELSON_RUN_ID: "r1",
    KEELSON_NODE_a_OUTPUT: "x",
    ARTIFACTS_DIR: ARTIFACTS,
    PATH: TOOL_DIR,
    LANG: "en_US.UTF-8",
    TERM: "xterm",
    GH_TOKEN: "secret",
    ANTHROPIC_API_KEY: "secret",
    HOME: HOST_HOME,
    NPM_TOKEN: "secret",
  };

  test("keeps the KEELSON_* channel and locale/PATH, drops tokens, and moves HOME/TMPDIR/caches", () => {
    expect(pickSandboxEnv(host, { scratch, hostHome: HOST_HOME })).toEqual({
      KEELSON_RUN_ID: "r1",
      KEELSON_NODE_a_OUTPUT: "x",
      ARTIFACTS_DIR: ARTIFACTS,
      PATH: TOOL_DIR,
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      HOME: join(scratch, "home"),
      TMPDIR: join(scratch, "tmp"),
      UV_CACHE_DIR: join(scratch, "cache", "uv"),
      BUN_INSTALL_CACHE_DIR: join(scratch, "cache", "bun"),
      GIT_CONFIG_GLOBAL: join(HOST_HOME, ".gitconfig"),
    });
  });

  test("a name the profile allows passes through", () => {
    const env = pickSandboxEnv(host, { scratch, hostHome: HOST_HOME, allow: ["GH_TOKEN"] });
    expect(env.GH_TOKEN).toBe("secret");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("launcherFor and envFor", () => {
  test("hands the runtime the profile with scratch made writable", () => {
    const seen: SandboxProfile[] = [];
    const policy = createSandboxPolicy(
      policyOptions({
        runtime: {
          backend: "fake",
          createLauncher: (profile) => {
            seen.push(profile);
            return hostLauncher;
          },
        },
      }),
    );
    const profile = policy.resolve({ enabled: true }, { cwd: CWD }).profile;
    if (!profile) throw new Error("expected a profile");
    const outside = join(ROOT, "scratch-outside");
    const launch = join(ROOT, "launch-1");
    policy.launcherFor(profile, outside, launch);
    expect(seen[0]?.filesystem.readwrite).toContain(outside);
    expect(seen[0]?.filesystem.readonly).toContain(launch);
    expect(seen[0]?.filesystem.readwrite).not.toContain(launch);
    expect(policy.envFor({ GH_TOKEN: "x" }, profile, outside).GH_TOKEN).toBeUndefined();
  });

  test("envFor names the keelson home, since HOME moves into scratch", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const profile = policy.resolve({ enabled: true }, { cwd: CWD }).profile;
    if (!profile) throw new Error("expected a profile");
    const scratch = join(ROOT, "scratch-home");
    expect(policy.envFor({}, profile, scratch).KEELSON_HOME).toBe(HOME);
    expect(policy.envFor({ KEELSON_HOME: "/elsewhere" }, profile, scratch).KEELSON_HOME).toBe(
      "/elsewhere",
    );
  });

  test("refuses a launch dir a sandboxed process could write", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const profile = policy.resolve({ enabled: true }, { cwd: CWD }).profile;
    if (!profile) throw new Error("expected a profile");
    expect(() => policy.launcherFor(profile, join(ROOT, "s"), join(CWD, "launch"))).toThrow(
      SubprocessSpawnError,
    );
    expect(() => policy.launcherFor(profile, join(ROOT, "s"), join(ROOT, "s", "launch"))).toThrow(
      "inside a writable grant",
    );
  });

  test("a runtime's refusal fails the node closed", () => {
    const policy = createSandboxPolicy(
      policyOptions({
        runtime: { ...fakeRuntime, refusal: () => "no host allowlists here" },
      }),
    );
    expect(policy.resolve({ enabled: true }, { cwd: CWD })).toMatchObject({
      outcome: "off",
      fail: "sandbox cannot be enforced: no host allowlists here",
    });
  });

  test("refuses to build a launcher without a runtime", () => {
    const policy = createSandboxPolicy(policyOptions());
    const profile = policy.resolve({ enabled: true }, ctx).profile;
    if (!profile) throw new Error("expected a profile");
    expect(() => policy.launcherFor(profile, ROOT, join(ROOT, "launch"))).toThrow(
      "without a sandbox runtime",
    );
  });
});

describe("createOperatorSandboxPolicy", () => {
  test("operator paths overlay the default and operator denies land last", () => {
    const policy = createOperatorSandboxPolicy(
      {
        floor: false,
        default: true,
        settings: {
          filesystem: {
            readwrite: [join(ROOT, "cache")],
            readonly: [],
            denied: [join(CWD, "secrets")],
          },
          network: { outbound: "allow" },
          env: ["CI"],
        },
      },
      {
        home: HOME,
        dbPath: DB,
        bundledBinDir: BIN,
        runtime: fakeRuntime,
        resolveGitCommonDir: () => undefined,
      },
    );
    const res = policy.resolve(
      { filesystem: { readwrite: ["secrets"] }, network: { outbound: "deny" } },
      ctx,
    );
    expect(res.profile?.filesystem.readwrite).toContain(join(ROOT, "cache"));
    expect(res.profile?.filesystem.denied).toContain(join(CWD, "secrets"));
    expect(res.profile?.network.outbound).toBe("deny");
    expect(res.profile?.env).toEqual(["CI"]);
  });
});

describe("prepareSandboxScratch", () => {
  test("creates <artifacts>/sandbox/<node>/ with home, tmp, and caches", () => {
    const artifacts = mkdtempSync(join(tmpdir(), "keelson-scratch-"));
    try {
      const scratch = prepareSandboxScratch(artifacts, "build:step");
      expect(scratch).toBe(join(artifacts, "sandbox", "build_step"));
      for (const dir of ["home", "tmp", join("cache", "uv")]) {
        expect(statSync(join(scratch, dir)).isDirectory()).toBe(true);
      }
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  });

  test("falls back to a temp dir without an artifacts dir", () => {
    const scratch = prepareSandboxScratch(undefined, "n1");
    try {
      expect(existsSync(join(scratch, "home"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("prompt-node default", () => {
  test("defers to the provider: working dirs and git writable, nothing else granted or denied", () => {
    const policy = createSandboxPolicy(
      policyOptions({ floor: true, resolveGitCommonDir: () => join(ROOT, "main", ".git") }),
    );
    const res = policy.resolve(undefined, { ...ctx, provider: { id: "codex", support: "native" } });
    expect(res.outcome).toBe("provider");
    expect(res.profile?.filesystem).toEqual({
      readwrite: [CWD, ARTIFACTS, join(ROOT, "main", ".git")],
      readonly: [],
      denied: [],
    });
    expect(res.profile?.network).toEqual({ outbound: "deny" });
  });

  test("operator denies still reach prompt nodes; bash keeps the hardened default", () => {
    const denied = join(CWD, "secrets");
    const policy = createSandboxPolicy(
      policyOptions({ floor: true, runtime: fakeRuntime, operatorDenied: [denied] }),
    );
    const prompt = policy.resolve(undefined, {
      ...ctx,
      provider: { id: "codex", support: "native" },
    });
    expect(prompt.profile?.filesystem.denied).toEqual([denied]);
    const bash = policy.resolve(undefined, ctx);
    expect(bash.profile?.filesystem.denied).toContain(join(HOST_HOME, ".ssh"));
    expect(bash.profile?.filesystem.denied).toContain(denied);
  });
});

describe("$REPO_ROOT grants", () => {
  const repo = join(ROOT, "repo");
  const worktree = join(repo, ".worktrees", "run-1");
  const gitCommonDir = join(repo, ".git");

  test("a worktree node can grant a path under the main checkout", () => {
    const policy = createSandboxPolicy(
      policyOptions({
        runtime: fakeRuntime,
        resolveGitCommonDir: () => gitCommonDir,
        resolveRepoRoot: () => repo,
      }),
    );
    const profile = policy.resolve(
      { enabled: true, filesystem: { readwrite: ["$REPO_ROOT/.beads"] } },
      { cwd: worktree },
    ).profile;
    expect(profile?.filesystem.readwrite).toContain(join(repo, ".beads"));
    expect(profile?.filesystem.readwrite).toContain(worktree);
    expect(profile?.filesystem.readwrite).toContain(gitCommonDir);
    expect(profile?.filesystem.readwrite).not.toContain(repo);
  });

  test("a submodule or separate git dir still names its own checkout", () => {
    const sub = join(ROOT, "super", "lib");
    const policy = createSandboxPolicy(
      policyOptions({
        runtime: fakeRuntime,
        resolveGitCommonDir: () => join(ROOT, "super", ".git", "modules", "lib"),
        resolveRepoRoot: () => sub,
      }),
    );
    const profile = policy.resolve(
      { enabled: true, filesystem: { readonly: ["$REPO_ROOT/.beads"] } },
      { cwd: join(sub, ".worktrees", "run-1") },
    ).profile;
    expect(profile?.filesystem.readonly).toContain(join(sub, ".beads"));
    expect(profile?.filesystem.readonly).not.toContain(
      join(ROOT, "super", ".git", "modules", ".beads"),
    );
  });

  test("outside a checkout the node fails closed with the reason", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const res = policy.resolve(
      { enabled: true, filesystem: { readonly: ["$REPO_ROOT/.beads"] } },
      { cwd: CWD },
    );
    expect(res.profile).toBeNull();
    expect(res.fail).toContain("not inside a git checkout");
  });
});

describe("readable paths", () => {
  test("a disjoint rib path is granted read-only", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const rib = join(ROOT, "ribs", "touchline");
    const profile = policy.resolve({ enabled: true }, { cwd: CWD, readable: [rib] }).profile;
    expect(profile?.filesystem.readonly).toContain(rib);
  });

  test("a rib path that covers or sits inside a writable root never restricts it", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const parent = resolve(CWD, "..");
    const child = join(CWD, "pipeline");
    const profile = policy.resolve(
      { enabled: true },
      { cwd: CWD, readable: [parent, CWD, child] },
    ).profile;
    expect(profile?.filesystem.readonly).not.toContain(parent);
    expect(profile?.filesystem.readonly).not.toContain(CWD);
    expect(profile?.filesystem.readonly).not.toContain(child);
    expect(profile?.filesystem.readwrite).toContain(CWD);
  });
});

describe("webSearchMode: live", () => {
  const provider = { id: "copilot", support: "native" as const };

  test("a prompt node that does not choose gets outbound network", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const live = policy.resolve({ enabled: true }, { cwd: CWD, provider, webSearchLive: true });
    expect(live.profile?.network.outbound).toBe("allow");
    const quiet = policy.resolve({ enabled: true }, { cwd: CWD, provider });
    expect(quiet.profile?.network.outbound).toBe("deny");
  });

  test("the host's shell for a live-web prompt turn gets outbound network too", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const shell = policy.resolve({ enabled: true }, { cwd: CWD, webSearchLive: true });
    expect(shell.profile?.network.outbound).toBe("allow");
    expect(shell.profile?.filesystem.denied.length).toBeGreaterThan(0);
  });

  test("an explicit node or workflow choice wins, and a node without the flag is unaffected", () => {
    const policy = createSandboxPolicy(policyOptions({ runtime: fakeRuntime }));
    const nodeDeny = policy.resolve(
      { enabled: true, network: { outbound: "deny" } },
      { cwd: CWD, provider, webSearchLive: true },
    );
    expect(nodeDeny.profile?.network.outbound).toBe("deny");
    const workflowDeny = policy.resolve(
      { enabled: true },
      {
        cwd: CWD,
        provider,
        webSearchLive: true,
        workflowSandbox: { network: { outbound: "deny" } },
      },
    );
    expect(workflowDeny.profile?.network.outbound).toBe("deny");
    const bash = policy.resolve({ enabled: true }, { cwd: CWD });
    expect(bash.profile?.network.outbound).toBe("deny");
  });
});

describe("launch files", () => {
  test("a launch dir is private, and disposing it removes everything in it", () => {
    const dir = createSandboxLaunchDir();
    writeSandboxBody(dir, "body.sh", "echo hi");
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    disposeSandboxLaunchDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "writeSandboxBody never follows or reuses a path that already exists",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "keelson-launch-test-"));
      try {
        const victim = join(dir, "victim.txt");
        writeFileSync(victim, "untouched");
        symlinkSync(victim, join(dir, "body.sh"));
        expect(() => writeSandboxBody(dir, "body.sh", "rm -rf ~")).toThrow();
        expect(readFileSync(victim, "utf8")).toBe("untouched");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
