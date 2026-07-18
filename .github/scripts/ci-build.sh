#!/bin/bash
# CI build script for Vento Browser. Runs on macOS directly and on
# Windows inside the MozillaBuild MSYS2 shell.
set -ex

export MOZCONFIG="$PWD/mozconfig-ci"

# Pin the build ID to an explicit UTC timestamp. Without this the ID is
# derived from the runner's local configure time, which can go backwards
# between machines/timezones and break the "newer build_id => update"
# ordering the AUS endpoint relies on. Overridable so a release job can
# supply its own value.
export MOZ_BUILD_DATE="${MOZ_BUILD_DATE:-$(date -u +%Y%m%d%H%M%S)}"

# The local root mozconfig is gitignored upstream, so define the full
# CI config here (keep in sync with the local mozconfig).
cat > "$MOZCONFIG" <<'EOF'
. "$topsrcdir/browser/config/mozconfig"
ac_add_options --with-branding=browser/branding/vento
ac_add_options --enable-update-channel=release
ac_add_options --enable-bootstrap
ac_add_options --disable-tests
mk_add_options AUTOCLOBBER=1
export MOZ_APPUPDATE_HOST=updates.vento-browser.com
export MAR_CHANNEL_ID=vento-release
export ACCEPTED_MAR_CHANNEL_IDS=vento-release
EOF

if [ "$(uname)" = "Darwin" ]; then
  # Apple pulled the CLTools pkg that bootstrap downloads the SDK from
  # (HTTP 403), so use the runner's Xcode SDK and tolerate the failing
  # SDK step in bootstrap; everything else it installs succeeds.
  echo "ac_add_options --with-macos-sdk=$(xcrun --sdk macosx --show-sdk-path)" >> "$MOZCONFIG"
  ./mach --no-interactive bootstrap --application-choice browser \
    || echo "WARNING: mach bootstrap exited non-zero; continuing"
else
  ./mach --no-interactive bootstrap --application-choice browser
fi

./mach build
./mach package

if [ "$(uname)" = "Darwin" ]; then
  # Ad-hoc sign the packaged .app (unsigned bundles are reported as
  # "damaged" by Gatekeeper on Apple Silicon), then rebuild the DMG
  # from the signed app.
  APP=$(find obj-*/dist -maxdepth 2 -name '*.app' | head -1)
  ./mach macos-sign -a "$APP" -c nightly
  DMG=$(/bin/ls obj-*/dist/*.dmg | head -1)
  rm "$DMG"
  ./mach python python/mozbuild/mozbuild/action/make_dmg.py -- \
    --volume-name Vento \
    --dsstore browser/branding/vento/dsstore \
    --background browser/branding/vento/background.png \
    --icon browser/branding/vento/disk.icns \
    "$(dirname "$APP")" "$DMG"
fi
