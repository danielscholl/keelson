// Prepack rewriter — strips workspace-only knobs from package.json so the
// published tarball ships a pure dist/-only contract. Paired with
// restore-package-json.ts which `postpack` runs to put package.json back.
//
// Strips the `bun` condition from every exports entry (it points at
// ./src/*.ts, which isn't in the published `files` allowlist; leaving it
// in would break Bun consumers of the tarball).
//
// We deliberately DO NOT strip `scripts.prepack` / `scripts.postpack`. npm
// reads lifecycle scripts once at the start of the pack/publish flow, so
// removing `postpack` here would not actually skip the restore for the
// current run — but it would risk the published manifest losing the script
// that's load-bearing for the restore step if the pack ever races with a
// re-read. The scripts reference `./scripts/*.ts` which isn't in the
// tarball's `files` allowlist, so a consumer who tries `npm pack` on the
// installed package fails loudly with a file-not-found rather than silently
// mutating their copy.
//
// If a previous publish failed between prepack and postpack, the .bak file
// is still on disk. We restore from it first so the prepack is idempotent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (vs `new URL(...).pathname`) is the Windows- and
// percent-encoding-safe way to turn import.meta.url into a usable path.
const here = path.dirname(fileURLToPath(import.meta.url));
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

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
