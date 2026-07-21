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

# Expose the exact source revision on about:buildconfig so the "Built from"
# link points at the Vento fork. MPL 2.0 (3.2) requires that recipients of
# the binaries can obtain the corresponding Source Code Form; about:license
# refers them to this page for the URL. Without these the source section is
# omitted (source-repo.h is empty) and there is no link to the modified
# source. configure reads these from the environment.
export MOZ_SOURCE_REPO="${MOZ_SOURCE_REPO:-https://github.com/Vento-Browser/firefox}"
export MOZ_SOURCE_CHANGESET="${MOZ_SOURCE_CHANGESET:-${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}}"
export MOZ_INCLUDE_SOURCE_INFO=1

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
  APP=$(find obj-*/dist -maxdepth 2 -name '*.app' | head -1)
  DMG=$(/bin/ls obj-*/dist/*.dmg | head -1)

  # When an Apple Developer ID certificate is configured (secrets present),
  # do a real production signing so Gatekeeper accepts the build on users'
  # machines. Otherwise fall back to ad-hoc signing, which still avoids the
  # "damaged" error locally but is not distributable. This keeps the workflow
  # green before the signing secrets are configured.
  IDENTITY=""
  if [ -n "${MACOS_CERTIFICATE_P12_B64:-}" ]; then
    KEYCHAIN="${RUNNER_TEMP:-/tmp}/vento-signing.keychain-db"
    KEYCHAIN_PW="$(uuidgen)"
    security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
    security set-keychain-settings -lut 21600 "$KEYCHAIN"
    security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
    P12="$(mktemp)"
    echo "$MACOS_CERTIFICATE_P12_B64" | base64 -d > "$P12"
    security import "$P12" -k "$KEYCHAIN" -P "${MACOS_CERTIFICATE_PASSWORD:-}" \
      -T /usr/bin/codesign
    rm -f "$P12"
    # Let codesign use the imported private key without an interactive prompt.
    security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null
    # Prepend our keychain to the search list so codesign can find the identity.
    security list-keychains -d user -s "$KEYCHAIN" \
      $(security list-keychains -d user | sed 's/[" ]//g')

    IDENTITY="${MACOS_SIGN_IDENTITY:-$(security find-identity -v -p codesigning "$KEYCHAIN" \
      | awk -F'"' '/Developer ID Application/ {print $2; exit}')}"
    if [ -z "$IDENTITY" ]; then
      echo "ERROR: no Developer ID Application identity found in the keychain" >&2
      exit 1
    fi
    echo "Signing with Developer ID identity: $IDENTITY"
    ./mach macos-sign -a "$APP" -s "$IDENTITY" \
      -e production-without-restricted -c release
  else
    echo "MACOS_CERTIFICATE_P12_B64 not set - using ad-hoc signing (not distributable)"
    ./mach macos-sign -a "$APP" -c nightly
  fi

  # Rebuild the DMG from the (re-)signed app.
  rm "$DMG"
  ./mach python python/mozbuild/mozbuild/action/make_dmg.py -- \
    --volume-name Vento \
    --dsstore browser/branding/vento/dsstore \
    --background browser/branding/vento/background.png \
    --icon browser/branding/vento/disk.icns \
    "$(dirname "$APP")" "$DMG"

  if [ -n "$IDENTITY" ]; then
    # Sign the DMG container, then notarize it with notarytool using an App
    # Store Connect API key and staple the ticket so the download validates
    # offline.
    codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp "$DMG"
    API_KEY_FILE="$(mktemp).p8"
    echo "$MACOS_NOTARY_API_KEY_B64" | base64 -d > "$API_KEY_FILE"
    xcrun notarytool submit "$DMG" \
      --key "$API_KEY_FILE" \
      --key-id "$MACOS_NOTARY_API_KEY_ID" \
      --issuer "$MACOS_NOTARY_API_ISSUER_ID" \
      --wait
    rm -f "$API_KEY_FILE"
    xcrun stapler staple "$DMG"
  fi
fi
