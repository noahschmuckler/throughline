#!/usr/bin/env bash
# Publish the current Throughline build to the meridian-briefing distributor.
#
# This is the DELIBERATE sync step (run on the Linux dev box AFTER you've verified
# the build locally). It bundles Throughline, then drops three files into the
# sibling meridian-briefing repo's public/throughline/ so the CR DEV server can
# serve them after a normal `git pull`:
#
#   throughline-latest.zip          — the code bundle the installer self-downloads
#   install-throughline.ps1.txt     — the single-file bootstrapper users download
#   throughline-release.json        — {version, sha, build, sha256, date}
#
# It does NOT commit or push — that stays in your hands so the CR DEV `git pull`
# is intentional. The exact git commands are printed at the end.
#
# Usage:
#   bash deploy/publish-throughline.sh                 # date = today (UTC)
#   bash deploy/publish-throughline.sh 2026-06-05      # pin the published date
#   MB_REPO=/path/to/meridian-briefing bash deploy/publish-throughline.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MB_REPO="${MB_REPO:-$ROOT/../meridian-briefing}"
OUT="$MB_REPO/public/throughline"
DATE="${1:-$(date -u +%Y-%m-%d)}"

[ -d "$MB_REPO" ] || { echo "ERROR: meridian-briefing repo not found at $MB_REPO (set MB_REPO=...)." >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "ERROR: 'sha256sum' not found." >&2; exit 1; }

# 1. Build. bundle.sh writes dist/throughline-<stamp>.zip + dist/install-...ps1.txt
bash "$ROOT/deploy/bundle.sh" >/dev/null
ZIP="$(ls -t "$ROOT"/dist/throughline-*.zip | head -1)"
PS1="$(ls -t "$ROOT"/dist/install-throughline-*.ps1.txt | head -1)"
[ -f "$ZIP" ] && [ -f "$PS1" ] || { echo "ERROR: bundle output missing." >&2; exit 1; }

# 2. Metadata.
BUILD="$(basename "$ZIP" | sed -E 's/^throughline-(.*)\.zip$/\1/')"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '0.0.0')"
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "$BUILD")"
SHA256="$(sha256sum "$ZIP" | cut -d' ' -f1)"

# 3. Publish to the distributor's static dir under stable names.
mkdir -p "$OUT"
cp -f "$ZIP" "$OUT/throughline-latest.zip"
cp -f "$PS1" "$OUT/install-throughline.ps1.txt"
cat > "$OUT/throughline-release.json" <<JSON
{
  "version": "$VERSION",
  "sha": "$SHA",
  "build": "$BUILD",
  "sha256": "$SHA256",
  "date": "$DATE"
}
JSON

echo "Published to $OUT :"
echo "  throughline-latest.zip       ($(du -h "$OUT/throughline-latest.zip" | cut -f1), sha256 ${SHA256:0:12}…)"
echo "  install-throughline.ps1.txt"
echo "  throughline-release.json     (v$VERSION · $SHA · $DATE)"
echo
echo "Next — commit + push meridian-briefing, then git pull on the CR DEV server:"
echo "  git -C \"$MB_REPO\" add public/throughline"
echo "  git -C \"$MB_REPO\" commit -m \"Publish Throughline $VERSION ($SHA)\""
echo "  git -C \"$MB_REPO\" push"
