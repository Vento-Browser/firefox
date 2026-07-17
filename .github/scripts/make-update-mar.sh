#!/bin/bash
# Creates a signed full-update MAR from the app packaged by `mach package`,
# verifies the signature against the cert embedded in the updater, and prints
# the JSON body for publishing via the backend (POST /api/updates, ADMIN).
#
# Usage: make-update-mar.sh -d <nss-db-dir> [-n certname] [-o outdir]
#   -d  NSS database directory holding the MAR signing private key
#   -n  certificate nickname (default: vento-mar-primary)
#   -o  output directory (default: <objdir>/dist/update)
#
# Optional env: MOZ_OBJDIR (objdir autodetected otherwise),
#   MAR_URL_BASE (default https://updates.vento-browser.com/mar) used in the
#   printed publish JSON.
set -euo pipefail

certname="vento-mar-primary"
nssdb=""
outdir=""
while getopts "d:n:o:" opt; do
  case "$opt" in
    d) nssdb="$OPTARG" ;;
    n) certname="$OPTARG" ;;
    o) outdir="$OPTARG" ;;
    *) exit 1 ;;
  esac
done
[ -n "$nssdb" ] || { echo "-d <nss-db-dir> is required" >&2; exit 1; }

topsrcdir="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$topsrcdir"

if [ -n "${MOZ_OBJDIR:-}" ]; then
  objdir="$MOZ_OBJDIR"
else
  objdir="$(ls -td obj-*/config.status 2>/dev/null | head -1 | xargs dirname)"
fi
[ -d "$objdir" ] || { echo "objdir not found" >&2; exit 1; }

subst() {
  grep "'$1':" "$objdir/config.status" | head -1 | sed "s/.*: '//; s/',\$//; s/^\"//; s/\"\$//"
}

appdir="$(find "$objdir/dist" -maxdepth 2 -name '*.app' -not -path '*/bin/*' | head -1)"
if [ -n "$appdir" ]; then
  appini="$appdir/Contents/Resources/application.ini"
else
  # Non-mac: mach package unpacks into dist/<pkgdir> (e.g. dist/firefox)
  appini="$(find "$objdir/dist" -maxdepth 2 -name application.ini -not -path '*/bin/*' | head -1)"
  appdir="$(dirname "$appini")"
fi
[ -f "$appini" ] || { echo "packaged app not found — run ./mach package first" >&2; exit 1; }

version="$(sed -n 's/^Version=//p' "$appini")"
buildid="$(sed -n 's/^BuildID=//p' "$appini")"
os_target="$(subst OS_TARGET)"
xpcom_abi="$(subst TARGET_XPCOM_ABI)"
build_target="${os_target}_${xpcom_abi}"
channel="$(subst MOZ_UPDATE_CHANNEL)"
mar_channel_id="$(subst MAR_CHANNEL_ID)"
[ -n "$mar_channel_id" ] || { echo "MAR_CHANNEL_ID missing from build config" >&2; exit 1; }

outdir="${outdir:-$objdir/dist/update}"
mkdir -p "$outdir"
marname="vento-${version}-${buildid}-${build_target}.complete.mar"

export MAR="$topsrcdir/$objdir/dist/host/bin/mar"
export MOZ_PRODUCT_VERSION="$version"
export MAR_CHANNEL_ID="$mar_channel_id"

echo "Creating full update MAR for $version ($buildid, $build_target, channel $mar_channel_id)"
./tools/update-packaging/make_full_update.sh -q "$outdir/unsigned.mar" "$appdir"

"$objdir/dist/bin/signmar" -d "$nssdb" -n "$certname" -s \
  "$outdir/unsigned.mar" "$outdir/$marname"
rm "$outdir/unsigned.mar"

"$objdir/dist/bin/signmar" \
  -D toolkit/mozapps/update/updater/release_primary.der -v "$outdir/$marname"
echo "Signature verified against embedded release_primary.der"

if command -v shasum >/dev/null; then
  mar_hash="$(shasum -a 512 "$outdir/$marname" | cut -d' ' -f1)"
else
  mar_hash="$(sha512sum "$outdir/$marname" | cut -d' ' -f1)"
fi
mar_size="$(stat -f%z "$outdir/$marname" 2>/dev/null || stat -c%s "$outdir/$marname")"
mar_url="${MAR_URL_BASE:-https://updates.vento-browser.com/mar}/$marname"

cat > "$outdir/$marname.publish.json" <<EOF
{
  "channel": "$channel",
  "build_target": "$build_target",
  "version": "$version",
  "build_id": "$buildid",
  "display_version": "$version",
  "mar_url": "$mar_url",
  "mar_hash": "$mar_hash",
  "mar_size": $mar_size,
  "is_mandatory": false
}
EOF

echo
echo "MAR:     $outdir/$marname"
echo "Publish: curl -X POST \$BACKEND/api/updates -H 'Authorization: Bearer \$ADMIN_TOKEN' \\"
echo "           -H 'Content-Type: application/json' -d @$outdir/$marname.publish.json"
cat "$outdir/$marname.publish.json"
