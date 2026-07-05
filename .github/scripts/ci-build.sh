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

./mach --no-interactive bootstrap --application-choice browser
./mach build
./mach package
