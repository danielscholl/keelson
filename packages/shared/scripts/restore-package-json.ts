// Postpack restorer — reverts the workspace-only package.json that
// prepare-publish.ts moved aside. If the backup is missing the prepack was
// either skipped or already restored; either way there's nothing to do.

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
  fs.unlinkSync(backupPath);
}
