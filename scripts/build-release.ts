#!/usr/bin/env bun
// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").
//
// Produces the GitHub-release artifacts in dist/release/:
//   - keelson-cli.tgz     bundled CLI+server (shared/zod/keyring kept external)
//   - keelson-shared.tgz  the single @keelson/shared the home seeds for ribs
//   - install.sh          provisions $KEELSON_HOME and drops a launcher on PATH
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
const REPO = "danielscholl/keelson";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(CLI_PKG_DIR, "dist"), { recursive: true });

// 1. Bundle the CLI. server/providers/skills/workflows/commander are inlined;
//    @keelson/shared, zod, and @napi-rs/keyring stay external so they resolve
//    to the home's single copy at runtime (one zod → schema identity holds
//    across the harness↔rib boundary).
console.log("[release] bundling @keelson/cli");
await $`bun build ${join(ROOT, "apps/cli/bin/keelson.ts")} --target=bun --outfile ${join(
  CLI_PKG_DIR,
  "dist",
  "keelson.js",
)} --external @keelson/shared --external zod --external @napi-rs/keyring`;

// 2. CLI release manifest. shared is an optional peer (the home provides it);
//    keyring is a real native dep bun fetches per-platform.
const cliPkg = {
  name: "@keelson/cli",
  version: VERSION,
  type: "module",
  bin: { keelson: "./dist/keelson.js" },
  dependencies: { "@napi-rs/keyring": "1.3.0", zod: ZOD_RANGE },
  peerDependencies: { "@keelson/shared": `^${VERSION}` },
  peerDependenciesMeta: { "@keelson/shared": { optional: true } },
  files: ["dist", "LICENSE", "NOTICE"],
};
writeFileSync(join(CLI_PKG_DIR, "package.json"), `${JSON.stringify(cliPkg, null, 2)}\n`);
for (const f of ["LICENSE", "NOTICE"]) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(CLI_PKG_DIR, f));
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

// 6. install.sh — see the heredoc-built launcher below.
writeFileSync(join(OUT, "install.sh"), installScript(REPO));
await $`chmod +x ${join(OUT, "install.sh")}`;

console.log(`[release] artifacts in ${OUT}`);
for (const f of readdirSync(OUT).sort()) console.log(`  - ${f}`);

function stableName(dir: string, prefix: string, target: string): void {
  // Match the versioned `<prefix>-<version>.tgz` form specifically, so a prior
  // stable `<prefix>.tgz` (no trailing dash) can never be picked as the source.
  const match = readdirSync(dir).find((n) => n.startsWith(`${prefix}-`) && n.endsWith(".tgz"));
  if (!match) throw new Error(`expected a ${prefix}-*.tgz in ${dir}`);
  renameSync(join(dir, match), join(dir, target));
}

function installScript(repo: string): string {
  return `#!/usr/bin/env sh
# Keelson installer. Provisions $KEELSON_HOME as a managed Bun project (the
# single node_modules that holds the CLI, @keelson/shared, and your ribs) and
# drops a launcher on PATH. Safe to re-run to repair the install.
set -eu

KEELSON_HOME="\${KEELSON_HOME:-$HOME/.keelson}"
BIN_DIR="\${KEELSON_BIN_DIR:-$HOME/.local/bin}"
BASE="https://github.com/${repo}/releases/latest/download"
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
# via \`keelson rib add\` (object-key set → no clobber, no duplicate keys). A
# re-run with a new CLI_TARBALL updates those two deps and leaves ribs intact.
KEELSON_HOME="$KEELSON_HOME" CLI_TARBALL="$CLI_TARBALL" SHARED_TARBALL="$SHARED_TARBALL" bun -e 'const fs=require("fs");const p=process.env.KEELSON_HOME+"/package.json";const pkg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{name:"keelson-home",private:true};pkg.dependencies=Object.assign({},pkg.dependencies,{"@keelson/cli":process.env.CLI_TARBALL,"@keelson/shared":process.env.SHARED_TARBALL});fs.writeFileSync(p,JSON.stringify(pkg,null,2)+"\\n");'

( cd "$KEELSON_HOME" && bun install )

cat > "$BIN_DIR/keelson" <<LAUNCH
#!/usr/bin/env sh
export KEELSON_HOME="\\\${KEELSON_HOME:-$KEELSON_HOME}"
exec bun "$KEELSON_HOME/node_modules/@keelson/cli/dist/keelson.js" "\\$@"
LAUNCH
chmod +x "$BIN_DIR/keelson"

echo "keelson installed to $KEELSON_HOME"
echo "launcher: $BIN_DIR/keelson  (ensure $BIN_DIR is on PATH)"
echo "next: keelson rib add chamber && keelson serve"
`;
}
