#!/usr/bin/env sh
# Local end-to-end dry-run of the GitHub-release install path, against
# locally-built tarballs instead of a published release. Builds the artifacts,
# provisions a throwaway $KEELSON_HOME via install.sh, then exercises the
# installed CLI: doctor, optional `rib add`, and the single-zod identity proof
# (the rib-side z and the harness-side z must be the same module instance).
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

echo "==> dry-run complete"
echo "    home=$HOME_DIR  launcher=$KEELSON"
echo "    clean up: rm -rf $HOME_DIR $BIN_DIR"
