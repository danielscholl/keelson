#!/usr/bin/env bun
// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").
//
// Produces the GitHub-release artifacts in dist/release/:
//   - keelson-cli.tgz     bundled CLI+server (shared/zod/keyring kept external)
//   - keelson-shared.tgz  the single @keelson/shared the home seeds for ribs
//   - install.sh          provisions $KEELSON_HOME and drops a launcher on PATH
//   - install.ps1         the same provisioning for Windows (keelson.cmd launcher)
// Reused by the local dry-run (scripts/dry-run-install.sh) and .github/workflows/release.yml.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "release");
const CLI_PKG_DIR = join(OUT, "cli");
// Track @keelson/shared's manifest so the CLI tarball version + `@keelson/shared`
// peer range match the shared tarball, and the CLI's direct zod dep matches the
// zod shared brings in (one resolved zod → schema identity holds, even under a
// non-hoisting/isolated install where a transitive sibling wouldn't resolve).
const SHARED_PKG = JSON.parse(
  readFileSync(join(ROOT, "packages", "shared", "package.json"), "utf8"),
) as { version: string; dependencies: Record<string, string> };
const VERSION = SHARED_PKG.version;
const ZOD_RANGE = SHARED_PKG.dependencies.zod;
// Provider SDK ranges come from @keelson/providers so the release always ships
// the same SDK versions the repo tests against.
const PROVIDERS_PKG = JSON.parse(
  readFileSync(join(ROOT, "packages", "providers", "package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const CLAUDE_SDK_RANGE = PROVIDERS_PKG.dependencies["@anthropic-ai/claude-agent-sdk"];
const COPILOT_SDK_RANGE = PROVIDERS_PKG.dependencies["@github/copilot-sdk"];
// A missing range would be dropped by JSON.stringify below, silently shipping a
// manifest without the SDK while the bundle still marks it external.
if (!CLAUDE_SDK_RANGE || !COPILOT_SDK_RANGE) {
  throw new Error(
    "packages/providers/package.json must declare @anthropic-ai/claude-agent-sdk and @github/copilot-sdk dependencies",
  );
}
const REPO = "danielscholl/keelson";
// The starter-asset dirs shipped in the cli tarball and seeded into a fresh home
// on first run. One list, used for both staging and the package `files` array,
// so the tarball can't ship a dir the manifest omits (or vice versa).
const STARTER_KINDS = ["workflows", "commands", "scripts"] as const;
// Merges the cli + shared tarball pins into the home manifest, preserving any
// ribs added via `keelson rib add` (object-key set → no clobber, no duplicate
// keys). Env-var driven and shared verbatim by both installers so the two
// provisioning paths cannot drift.
const MERGE_MANIFEST_JS =
  'const fs=require("fs");const p=process.env.KEELSON_HOME+"/package.json";const pkg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{name:"keelson-home",private:true};pkg.dependencies=Object.assign({},pkg.dependencies,{"@keelson/cli":process.env.CLI_TARBALL,"@keelson/shared":process.env.SHARED_TARBALL});fs.writeFileSync(p,JSON.stringify(pkg,null,2)+"\\n");';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(CLI_PKG_DIR, "dist"), { recursive: true });

// 1. Bundle the CLI. server/providers/skills/workflows/commander are inlined;
//    @keelson/shared, zod, and @napi-rs/keyring stay external so they resolve
//    to the home's single copy at runtime (one zod → schema identity holds
//    across the harness↔rib boundary). The provider SDKs must also stay
//    external: each one locates a sibling package at runtime relative to its
//    own module path (claude-agent-sdk resolves its per-platform native CLI
//    binary, copilot-sdk resolves the @github/copilot CLI it spawns), so
//    inlining them breaks that resolution and chat fails on both providers.
console.log("[release] bundling @keelson/cli");
await $`bun build ${join(ROOT, "apps/cli/bin/keelson.ts")} --target=bun --outfile ${join(
  CLI_PKG_DIR,
  "dist",
  "keelson.js",
)} --external @keelson/shared --external zod --external @napi-rs/keyring --external @anthropic-ai/claude-agent-sdk --external @github/copilot-sdk`;

// 2. CLI release manifest. shared is an optional peer (the home provides it);
//    keyring is a real native dep bun fetches per-platform; the provider SDKs
//    bring their own runtime siblings (claude's per-platform binary via its
//    optionalDependencies, copilot's CLI via its @github/copilot dep).
const cliPkg = {
  name: "@keelson/cli",
  version: VERSION,
  type: "module",
  bin: { keelson: "./dist/keelson.js" },
  dependencies: {
    "@anthropic-ai/claude-agent-sdk": CLAUDE_SDK_RANGE,
    "@github/copilot-sdk": COPILOT_SDK_RANGE,
    "@napi-rs/keyring": "1.3.0",
    zod: ZOD_RANGE,
  },
  peerDependencies: { "@keelson/shared": `^${VERSION}` },
  peerDependenciesMeta: { "@keelson/shared": { optional: true } },
  files: ["dist", "web", ...STARTER_KINDS, "LICENSE", "NOTICE"],
};
writeFileSync(join(CLI_PKG_DIR, "package.json"), `${JSON.stringify(cliPkg, null, 2)}\n`);
for (const f of ["LICENSE", "NOTICE"]) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(CLI_PKG_DIR, f));
}

// 2b. Build the SPA and ship it inside the cli tarball at `web/`. The server
//     (inlined in the bundle at dist/keelson.js) resolves `../web` and serves it
//     at the root, so `keelson service` gives an installed user the browser UI —
//     no separate Vite dev server. The build is version-locked to the cli.
console.log("[release] building @keelson/web");
await $`cd ${ROOT} && bun --filter @keelson/web build`.quiet();
const webDist = join(ROOT, "apps", "web", "dist");
if (!existsSync(join(webDist, "index.html"))) {
  throw new Error(`expected a built SPA at ${webDist} (apps/web build produced no index.html)`);
}
cpSync(webDist, join(CLI_PKG_DIR, "web"), { recursive: true });

// 2c. Ship the repo's starter kit next to dist/ — the starter workflows plus
//     the command/script files they reference — so the runtime seeds them into
//     a fresh home on first run (seedStarterAssets in @keelson/workflows
//     resolves these dirs relative to the bundle). Staging ships every non-dot
//     file; the seed's per-kind predicate is authoritative on what's relevant.
for (const kind of STARTER_KINDS) {
  const srcDir = join(ROOT, ".keelson", kind);
  const files = readdirSync(srcDir).filter((n) => !n.startsWith("."));
  if (files.length === 0) {
    throw new Error(`expected starter ${kind} in ${srcDir}`);
  }
  mkdirSync(join(CLI_PKG_DIR, kind), { recursive: true });
  for (const n of files) {
    cpSync(join(srcDir, n), join(CLI_PKG_DIR, kind, n), { recursive: true });
  }
}

// 3. Pack the CLI package.
console.log("[release] packing @keelson/cli");
await $`cd ${CLI_PKG_DIR} && bun pm pack --destination ${OUT}`.quiet();

// 4. Build + pack @keelson/shared. Its prepack strips the bun condition (so the
//    tarball resolves via dist/); postpack restores the dev manifest.
console.log("[release] packing @keelson/shared");
await $`cd ${join(ROOT, "packages", "shared")} && bun pm pack --destination ${OUT}`.quiet();

// 5. Rename the versioned tarballs to stable asset names so install.sh can pull
//    them from the /releases/latest/download/<name> redirect.
stableName(OUT, "keelson-cli", "keelson-cli.tgz");
stableName(OUT, "keelson-shared", "keelson-shared.tgz");

// 6. install.sh / install.ps1 — see the heredoc-built launchers below.
writeFileSync(join(OUT, "install.sh"), installScript(REPO, VERSION));
await $`chmod +x ${join(OUT, "install.sh")}`;
writeFileSync(join(OUT, "install.ps1"), installPs1Script(REPO, VERSION));

console.log(`[release] artifacts in ${OUT}`);
for (const f of readdirSync(OUT).sort()) console.log(`  - ${f}`);

function stableName(dir: string, prefix: string, target: string): void {
  // Match the versioned `<prefix>-<version>.tgz` form specifically, so a prior
  // stable `<prefix>.tgz` (no trailing dash) can never be picked as the source.
  const match = readdirSync(dir).find((n) => n.startsWith(`${prefix}-`) && n.endsWith(".tgz"));
  if (!match) throw new Error(`expected a ${prefix}-*.tgz in ${dir}`);
  renameSync(join(dir, match), join(dir, target));
}

function installScript(repo: string, version: string): string {
  return `#!/usr/bin/env sh
# Keelson installer. Provisions $KEELSON_HOME as a managed Bun project (the
# single node_modules that holds the CLI, @keelson/shared, and your ribs) and
# drops a launcher on PATH. Re-run to upgrade: this installer is itself
# versioned, so a re-run from a newer release rewrites the home to that
# version's tarballs and \`bun install\` picks them up.
set -eu

KEELSON_VERSION="${version}"
KEELSON_HOME="\${KEELSON_HOME:-$HOME/.keelson}"
BIN_DIR="\${KEELSON_BIN_DIR:-$HOME/.local/bin}"
# Pin the home to this release's versioned download URLs (not /latest/), so the
# dependency string changes between versions — that is what lets \`bun install\`
# re-resolve on a re-run instead of serving the URL-keyed cache. Override either
# tarball via env for local dry-runs against locally-built artifacts.
BASE="https://github.com/${repo}/releases/download/v\${KEELSON_VERSION}"
CLI_TARBALL="\${KEELSON_CLI_TARBALL:-$BASE/keelson-cli.tgz}"
SHARED_TARBALL="\${KEELSON_SHARED_TARBALL:-$BASE/keelson-shared.tgz}"

if ! command -v bun >/dev/null 2>&1; then
  echo "keelson requires Bun on PATH — install it from https://bun.sh and re-run." >&2
  exit 1
fi

mkdir -p "$KEELSON_HOME" "$BIN_DIR"
# Canonicalize to absolute paths so the launcher (which bakes in KEELSON_HOME)
# resolves from any directory, even if a relative KEELSON_HOME was supplied.
KEELSON_HOME="$(cd "$KEELSON_HOME" && pwd)"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"
# Merge cli + shared into the home manifest every run, preserving any ribs added
# via \`keelson rib add\`. A re-run with a new CLI_TARBALL updates those two
# deps and leaves ribs intact.
KEELSON_HOME="$KEELSON_HOME" CLI_TARBALL="$CLI_TARBALL" SHARED_TARBALL="$SHARED_TARBALL" bun -e '${MERGE_MANIFEST_JS}'

( cd "$KEELSON_HOME" && bun install )

cat > "$BIN_DIR/keelson" <<LAUNCH
#!/usr/bin/env sh
export KEELSON_HOME="\\\${KEELSON_HOME:-$KEELSON_HOME}"
exec bun "$KEELSON_HOME/node_modules/@keelson/cli/dist/keelson.js" "\\$@"
LAUNCH
chmod +x "$BIN_DIR/keelson"

echo "keelson v$KEELSON_VERSION installed to $KEELSON_HOME"
echo "launcher: $BIN_DIR/keelson  (ensure $BIN_DIR is on PATH)"
echo "next: keelson rib add https://github.com/danielscholl/keelson-rib-chamber && keelson service"
`;
}

// Windows can't use install.sh even under Git Bash: MSYS's pwd canonicalizes
// the home to a /c/Users/... form that the native-Bun CLI can't resolve, and
// the extensionless sh launcher is invisible to PowerShell/cmd. This mirrors
// install.sh step for step and drops a keelson.cmd launcher instead.
function installPs1Script(repo: string, version: string): string {
  return `# Keelson installer for Windows (PowerShell 5.1+ / pwsh). Provisions
# KEELSON_HOME as a managed Bun project (the single node_modules that holds the
# CLI, @keelson/shared, and your ribs) and drops a keelson.cmd launcher on the
# user PATH. Re-run to upgrade: this installer is itself versioned, so a re-run
# from a newer release rewrites the home to that version's tarballs and
# \`bun install\` picks them up.
$ErrorActionPreference = "Stop"

$KeelsonVersion = "${version}"
$KeelsonHome = if ($env:KEELSON_HOME) { $env:KEELSON_HOME } else { Join-Path $env:USERPROFILE ".keelson" }
$BinDir = if ($env:KEELSON_BIN_DIR) { $env:KEELSON_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "keelson\\bin" }
# Pin the home to this release's versioned download URLs (not /latest/), so the
# dependency string changes between versions — that is what lets \`bun install\`
# re-resolve on a re-run instead of serving the URL-keyed cache. Override either
# tarball via env for local dry-runs against locally-built artifacts.
$Base = "https://github.com/${repo}/releases/download/v$KeelsonVersion"
$CliTarball = if ($env:KEELSON_CLI_TARBALL) { $env:KEELSON_CLI_TARBALL } else { "$Base/keelson-cli.tgz" }
$SharedTarball = if ($env:KEELSON_SHARED_TARBALL) { $env:KEELSON_SHARED_TARBALL } else { "$Base/keelson-shared.tgz" }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw "keelson requires Bun on PATH - install it from https://bun.sh and re-run."
}

New-Item -ItemType Directory -Force -Path $KeelsonHome | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
# Canonicalize to absolute paths so the launcher (which bakes in KEELSON_HOME)
# resolves from any directory, even if a relative KEELSON_HOME was supplied.
$KeelsonHome = (Resolve-Path $KeelsonHome).Path
$BinDir = (Resolve-Path $BinDir).Path

# Merge cli + shared into the home manifest every run, preserving any ribs
# added via \`keelson rib add\` — the same env-driven bun one-liner install.sh
# runs. The env overrides are scoped to this invocation and restored after.
$SavedHome = $env:KEELSON_HOME
$env:KEELSON_HOME = $KeelsonHome
$env:CLI_TARBALL = $CliTarball
$env:SHARED_TARBALL = $SharedTarball
try {
  bun -e '${MERGE_MANIFEST_JS}'
  if ($LASTEXITCODE -ne 0) { throw "manifest merge failed (exit $LASTEXITCODE)" }
} finally {
  $env:KEELSON_HOME = $SavedHome
  Remove-Item Env:CLI_TARBALL -ErrorAction SilentlyContinue
  Remove-Item Env:SHARED_TARBALL -ErrorAction SilentlyContinue
}

Push-Location $KeelsonHome
try {
  bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

# A .cmd launcher runs from cmd.exe and PowerShell alike with no
# execution-policy friction. The default home is baked as %USERPROFILE% so the
# launcher stays pure ASCII even for user names cmd's ANSI codepage can't
# represent; a custom KEELSON_HOME is baked literally.
$HomeForCmd = if ($env:KEELSON_HOME) { $KeelsonHome } else { "%USERPROFILE%\\.keelson" }
$Launcher = @(
  "@echo off",
  "setlocal",
  "if not defined KEELSON_HOME set ""KEELSON_HOME=$HomeForCmd""",
  "bun ""%KEELSON_HOME%\\node_modules\\@keelson\\cli\\dist\\keelson.js"" %*"
)
Set-Content -Path (Join-Path $BinDir "keelson.cmd") -Value $Launcher -Encoding ascii

# Make the launcher reachable: append BinDir to the user PATH once (machine
# PATH untouched), and to this session so \`keelson\` works immediately.
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ";") -contains $BinDir)) {
  $NewPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
  Write-Host "added $BinDir to your user PATH (restart other shells to pick it up)"
}
if (-not (($env:Path -split ";") -contains $BinDir)) {
  $env:Path = "$env:Path;$BinDir"
}

Write-Host "keelson v$KeelsonVersion installed to $KeelsonHome"
Write-Host "launcher: $BinDir\\keelson.cmd"
Write-Host "next: keelson rib add https://github.com/danielscholl/keelson-rib-chamber; keelson service"
`;
}
