#!/bin/bash
# CI build script for Vento Browser. Runs on macOS directly and on
# Windows inside the MozillaBuild MSYS2 shell.
set -ex

export MOZCONFIG="$PWD/mozconfig-ci"

# The local root mozconfig is gitignored upstream, so define the full
# CI config here (keep in sync with the local mozconfig).
cat > "$MOZCONFIG" <<'EOF'
. "$topsrcdir/browser/config/mozconfig"
ac_add_options --with-branding=browser/branding/vento
ac_add_options --enable-bootstrap
ac_add_options --disable-tests
mk_add_options AUTOCLOBBER=1
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
