#!/usr/bin/env bash
# Bundle Throughline for orange-device deployment.
#
# Produces  dist/throughline-<sha>.zip  plus  dist/install-throughline-<sha>.ps1.txt
# (a PowerShell installer that expects the zip to be extracted alongside it).
#
# Unlike atom_sandbox, Throughline's Node server has NO npm runtime deps (only
# node: builtins + global fetch), so there is no node_modules to vendor — the
# bundle is just source. We also do NOT ship data/ or the seed scripts: orange
# starts BLANK and points THROUGHLINE_DB at a OneDrive folder.
#
# Workflow:
#   1. cd ~/GitHub_Repos/throughline
#   2. bash deploy/bundle.sh
#   3. Move both dist files to OneDrive (synced folder, or your tailscale flow).
#   4. On orange: rename .ps1.txt -> .ps1, extract the zip alongside it, run it.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v zip >/dev/null || { echo "ERROR: 'zip' not installed (apt install zip)." >&2; exit 1; }

mkdir -p dist
SHA="$(date -u +%Y%m%dT%H%M%SZ)"
ZIP="dist/throughline-${SHA}.zip"
PS1="dist/install-throughline-${SHA}.ps1.txt"

echo "Bundling Throughline @ ${SHA}"

# Runtime essentials only. Excludes the Worker (src/), wrangler config, the seed
# scripts (orange ships blank), data/, node_modules (none), and dev cruft.
rm -f "$ZIP"
zip -qr "$ZIP" \
  package.json \
  server.js \
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

echo "  wrote $ZIP ($(du -h "$ZIP" | cut -f1))"

# Stamp the SHA into the installer, convert LF->CRLF (PowerShell-friendly), and
# prepend a UTF-8 BOM so Windows PowerShell 5.1 reads it as UTF-8.
TMP="$(mktemp)"
sed "s/{{SHA}}/${SHA}/g" "deploy/install-throughline.ps1" | sed 's/$/\r/' > "$TMP"
{ printf '\xEF\xBB\xBF'; cat "$TMP"; } > "$PS1"
rm -f "$TMP"
echo "  wrote $PS1"

cat <<EOF

Next steps (on the orange box):
  1. Save the .ps1.txt to %USERPROFILE%\\throughline-deploy\\ and rename to .ps1
  2. Extract the .zip alongside it (so install-throughline-${SHA}.ps1 sits next
     to a folder named throughline-${SHA}\\  or  throughline\\)
  3. Run it:
       & "\$env:USERPROFILE\\throughline-deploy\\install-throughline-${SHA}.ps1"
  4. Edit %USERPROFILE%\\throughline\\.env:
       THROUGHLINE_DB=C:\\Users\\<you>\\OneDrive - <org>\\Throughline\\state.json
       LLM_PROVIDER=cdsapi
     then restart:
       Stop-ScheduledTask -TaskName ThroughlineServer ; Start-ScheduledTask -TaskName ThroughlineServer
  5. Open http://127.0.0.1:8787

See deploy/README-orange.md for the full operator guide + the shared-OneDrive caveat.
EOF
