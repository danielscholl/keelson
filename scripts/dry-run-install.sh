#!/usr/bin/env sh
# Local end-to-end dry-run of the GitHub-release install and removal paths,
# against locally-built tarballs instead of a published release. Builds the
# artifacts, provisions a throwaway $KEELSON_HOME via install.sh, exercises the
# installed CLI (doctor, optional `rib add`, and the single-zod identity proof —
# the rib-side z and the harness-side z must be the same module instance), then
# takes the home back out with `keelson uninstall`.
#
# Usage: scripts/dry-run-install.sh [path-or-id-of-a-rib-to-add]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REL="$ROOT/dist/release"
RIB="${1:-}"

echo "==> building release artifacts"
bun "$ROOT/scripts/build-release.ts" >/dev/null

HOME_DIR="$(mktemp -d)/keelson"
BIN_DIR="$(mktemp -d)/bin"

echo "==> installing into $HOME_DIR (from local tarballs)"
KEELSON_HOME="$HOME_DIR" KEELSON_BIN_DIR="$BIN_DIR" \
  KEELSON_CLI_TARBALL="$REL/keelson-cli.tgz" \
  KEELSON_SHARED_TARBALL="$REL/keelson-shared.tgz" \
  sh "$REL/install.sh"

KEELSON="$BIN_DIR/keelson"

echo "==> keelson doctor"
"$KEELSON" doctor || true

if [ -n "$RIB" ]; then
  echo "==> keelson rib add $RIB"
  "$KEELSON" rib add "$RIB"
  echo "==> keelson rib list --installed"
  "$KEELSON" rib list --installed

  echo "==> re-running install.sh must preserve the added rib (no clobber)"
  KEELSON_HOME="$HOME_DIR" KEELSON_BIN_DIR="$BIN_DIR" \
    KEELSON_CLI_TARBALL="file:$REL/keelson-cli.tgz" \
    KEELSON_SHARED_TARBALL="file:$REL/keelson-shared.tgz" \
    sh "$REL/install.sh" >/dev/null
  if grep -q '@keelson/rib-' "$HOME_DIR/package.json"; then
    echo "    OK: rib dep survived the re-run"
  else
    echo "    FAIL: re-run clobbered the rib dep" >&2
    exit 1
  fi
fi

echo "==> zod identity proof"
cat > "$HOME_DIR/.zod-proof.ts" <<'EOF'
import { z as sharedZ } from "@keelson/shared";
import { z as zodZ } from "zod";
const json = zodZ.toJSONSchema(sharedZ.object({ city: sharedZ.string() }));
if (sharedZ !== zodZ) {
  console.error("FAIL: two zod module instances in the home tree");
  process.exit(1);
}
console.log("OK: single zod; toJSONSchema:", JSON.stringify(json));
EOF
( cd "$HOME_DIR" && bun .zod-proof.ts )
rm -f "$HOME_DIR/.zod-proof.ts"

# The Windows launcher can't be run here, so assert its one load-bearing
# property instead: the CLI is resolved from where it was installed, so a
# KEELSON_HOME pointed at a bare data home still finds the program.
echo "==> install.ps1 launcher resolves the CLI from the install location"
if grep -qF '%KEELSON_PROGRAM%\node_modules' "$REL/install.ps1"; then
  echo "    OK: launcher execs %KEELSON_PROGRAM%"
else
  echo "    FAIL: launcher no longer resolves the CLI from %KEELSON_PROGRAM%" >&2
  exit 1
fi

# --keep-credentials throughout: the keychain is per-user, not per-home, so a
# dry-run that revoked entries would take the developer's real provider logins
# with it.
echo "==> keelson uninstall (program files only)"
printf 'db' > "$HOME_DIR/keelson.db"
KEELSON_HOME="$HOME_DIR" KEELSON_BIN_DIR="$BIN_DIR" \
  "$KEELSON" uninstall --yes --keep-credentials
for gone in node_modules package.json bun.lock; do
  if [ -e "$HOME_DIR/$gone" ]; then
    echo "    FAIL: $gone survived the uninstall" >&2
    exit 1
  fi
done
for kept in keelson.db workflows commands; do
  if [ ! -e "$HOME_DIR/$kept" ]; then
    echo "    FAIL: uninstall took $kept, which is operator data" >&2
    exit 1
  fi
done
if [ -e "$KEELSON" ]; then
  echo "    FAIL: launcher survived the uninstall" >&2
  exit 1
fi
echo "    OK: program files and launcher gone, data kept"

# A plain run takes the installed CLI with it, so an operator's own second step
# is `rm -rf` rather than this. Running it from source is how the guard itself
# gets exercised: a home whose program files a prior run already removed must
# still be purgeable, not refused as if it were somebody else's project.
echo "==> keelson uninstall --purge (finishes the job)"
KEELSON_HOME="$HOME_DIR" KEELSON_BIN_DIR="$BIN_DIR" \
  bun "$ROOT/apps/cli/bin/keelson.ts" uninstall --yes --purge --keep-credentials
if [ -e "$HOME_DIR" ]; then
  echo "    FAIL: --purge left $HOME_DIR behind" >&2
  exit 1
fi
echo "    OK: home removed"

echo "==> dry-run complete"
