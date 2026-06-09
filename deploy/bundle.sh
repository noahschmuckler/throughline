#!/usr/bin/env bash
# Bundle Throughline for orange-device deployment.
#
# Produces  dist/throughline-<sha>.zip  plus  dist/install-throughline-<sha>.ps1.txt
#
# The installer is a SELF-DOWNLOADING bootstrapper: it fetches the zip from the
# meridian-briefing distributor at run time, so the zip does NOT need to sit
# beside it. The normal distribution path is `deploy/publish-throughline.sh`,
# which copies these two files (+ a manifest) into meridian-briefing/public/
# throughline/ under stable names. bundle.sh is the building block it calls.
#
# Unlike atom_sandbox, Throughline's Node server has NO npm runtime deps (only
# node: builtins + global fetch), so there is no node_modules to vendor — the
# bundle is just source. We also do NOT ship data/ or the seed scripts: orange
# starts BLANK and points THROUGHLINE_DB at a OneDrive folder.
#
# Workflow (normal): cd ~/GitHub_Repos/throughline && bash deploy/publish-throughline.sh
# Workflow (this script standalone): bash deploy/bundle.sh  → inspect dist/.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v zip >/dev/null || { echo "ERROR: 'zip' not installed (apt install zip)." >&2; exit 1; }
command -v npm >/dev/null || { echo "ERROR: 'npm' not installed (needed to vendor prod deps)." >&2; exit 1; }

mkdir -p dist
SHA="$(date -u +%Y%m%dT%H%M%SZ)"
ZIP="dist/throughline-${SHA}.zip"
PS1="dist/install-throughline-${SHA}.ps1.txt"

echo "Bundling Throughline @ ${SHA}"

# The Node server gained runtime deps (@azure/msal-node + turndown, for the Loop/
# Deloop Microsoft Graph import) — so the bundle must VENDOR production
# node_modules (orange has no npm-install step). Stage a clean prod-only install
# in a temp dir so the dev tree's node_modules (incl. wrangler) is left intact.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp package.json package-lock.json "$STAGE"/ 2>/dev/null || cp package.json "$STAGE"/
( cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --silent )
echo "  vendored prod node_modules ($(du -sh "$STAGE/node_modules" | cut -f1))"

# Runtime essentials only. Excludes the Worker (src/), wrangler config, the seed
# scripts (orange ships blank), data/, and dev cruft. node_modules is added from
# the staging dir below (prod-only).
rm -f "$ZIP"
zip -qr "$ZIP" \
  package.json \
  server.js \
  dethreader.ps1 \
  lib/ \
  shared/ \
  public/ \
  .env.example \
  README.md \
  CLAUDE.md \
  -x '*.DS_Store' \
  -x '*/.git/*' \
  -x '*.env' \
  -x 'data/*' \
  -x 'logs/*'
( cd "$STAGE" && zip -qrg "$ROOT/$ZIP" node_modules )

echo "  wrote $ZIP ($(du -h "$ZIP" | cut -f1))"

# Stamp the SHA into the installer, convert LF->CRLF (PowerShell-friendly), and
# prepend a UTF-8 BOM so Windows PowerShell 5.1 reads it as UTF-8.
TMP="$(mktemp)"
sed "s/{{SHA}}/${SHA}/g" "deploy/install-throughline.ps1" | sed 's/$/\r/' > "$TMP"
{ printf '\xEF\xBB\xBF'; cat "$TMP"; } > "$PS1"
rm -f "$TMP"
echo "  wrote $PS1"

cat <<EOF

Built dist/. To distribute, run:  bash deploy/publish-throughline.sh
  (copies these into meridian-briefing/public/throughline/ under stable names;
   users then download the installer from the Throughline tile on meridian-briefing
   and it self-downloads this zip + opens the in-app setup wizard).

See deploy/README-orange.md for the operator guide + the shared-OneDrive caveat.
EOF
