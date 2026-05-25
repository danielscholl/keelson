// Prepack rewriter — strips workspace-only knobs from package.json so the
// published tarball ships a pure dist/-only contract. Paired with
// restore-package-json.ts which `postpack` runs to put package.json back.
//
// What gets stripped:
//   - `bun` condition from every exports entry (points at ./src/*.ts which
//     isn't in the published `files` allowlist; leaving it in would break
//     Bun consumers of the tarball)
//   - The `prepack` and `postpack` scripts themselves (consumers of the
//     installed package shouldn't re-trigger these on their own packs)
//
// If a previous publish failed between prepack and postpack, the .bak file
// is still on disk. We restore from it first so the prepack is idempotent.

import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgPath = path.join(here, "..", "package.json");
const backupPath = `${pkgPath}.bak`;

if (fs.existsSync(backupPath)) {
  fs.copyFileSync(backupPath, pkgPath);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
fs.copyFileSync(pkgPath, backupPath);

const exportsField = pkg.exports as Record<string, unknown> | undefined;
if (exportsField) {
  for (const [key, entry] of Object.entries(exportsField)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && "bun" in entry) {
      const { bun: _bun, ...rest } = entry as Record<string, unknown>;
      exportsField[key] = rest;
    }
  }
}

const scripts = pkg.scripts as Record<string, string> | undefined;
if (scripts) {
  delete scripts.prepack;
  delete scripts.postpack;
}

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
