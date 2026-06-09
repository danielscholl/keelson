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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "release");
const CLI_PKG_DIR = join(OUT, "cli");
const VERSION = "0.1.0";
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
  dependencies: { "@napi-rs/keyring": "1.3.0" },
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
# Write the manifest only on first install; never clobber an existing one — it
# carries the ribs added via \`keelson rib add\`. A re-run just reinstalls from
# the existing manifest, leaving cli/shared and every rib dep intact.
if [ ! -f "$KEELSON_HOME/package.json" ]; then
  cat > "$KEELSON_HOME/package.json" <<JSON
{
  "name": "keelson-home",
  "private": true,
  "dependencies": {
    "@keelson/cli": "$CLI_TARBALL",
    "@keelson/shared": "$SHARED_TARBALL"
  }
}
JSON
fi

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
