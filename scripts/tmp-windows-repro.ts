// TEMPORARY diagnostic for the windows-latest frozen-lockfile failure.
// Reproduces the ensureWorktreeDeps fixture and prints the lockfile at each
// stage so the CI log shows exactly what bun thinks changed. Deleted once the
// root cause is fixed.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "keelson-repro-"));
console.log("tmp:", tmp);

function sh(cmd: string[], cwd: string): number {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  console.log(`\n$ ${cmd.join(" ")}  (exit ${r.exitCode})`);
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  if (out) console.log(out);
  return r.exitCode ?? 1;
}

function show(label: string, path: string): void {
  const text = readFileSync(path, "utf8");
  console.log(`\n=== ${label} (${Buffer.byteLength(text)} bytes, CR=${text.includes("\r")}) ===`);
  console.log(text);
}

sh(["git", "init", "--initial-branch=main"], tmp);
sh(["git", "config", "user.email", "t@example.com"], tmp);
sh(["git", "config", "user.name", "T"], tmp);
sh(["git", "config", "core.autocrlf", "false"], tmp);
writeFileSync(
  join(tmp, "package.json"),
  `${JSON.stringify({ name: "wt-deps-root", version: "0.0.0", private: true, workspaces: ["pkg"] }, null, 2)}\n`,
);
mkdirSync(join(tmp, "pkg"));
writeFileSync(
  join(tmp, "pkg", "package.json"),
  `${JSON.stringify({ name: "@wt-deps/pkg", version: "0.0.0" }, null, 2)}\n`,
);
sh(["bun", "install"], tmp);
show("bun.lock written by source install", join(tmp, "bun.lock"));

console.log("\n--- frozen install in the SOURCE repo (control) ---");
sh(["bun", "install", "--frozen-lockfile"], tmp);

sh(["git", "add", "package.json", "pkg/package.json", "bun.lock"], tmp);
sh(["git", "commit", "-m", "add workspace"], tmp);

const dest = join(tmp, ".wt", "feature");
sh(["git", "worktree", "add", "-b", "keelson/test/feature", dest], tmp);
show("bun.lock as checked out in the worktree", join(dest, "bun.lock"));
sh(["git", "-C", dest, "status", "--porcelain"], tmp);

console.log("\n--- frozen install in the WORKTREE (the failing case) ---");
const frozen = sh(["bun", "install", "--frozen-lockfile"], dest);
console.log("frozen exit:", frozen);

console.log("\n--- non-frozen install in the worktree, then diff ---");
sh(["bun", "install"], dest);
show("bun.lock after non-frozen install in worktree", join(dest, "bun.lock"));
sh(["git", "-C", dest, "diff", "--", "bun.lock"], tmp);

process.exit(0);
