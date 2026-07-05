#!/bin/bash
# CI build script for Vento Browser. Runs on macOS directly and on
# Windows inside the MozillaBuild MSYS2 shell.
set -ex

export MOZCONFIG="$PWD/mozconfig-ci"

cat > "$MOZCONFIG" <<'EOF'
. "$topsrcdir/mozconfig"
ac_add_options --enable-bootstrap
ac_add_options --disable-tests
mk_add_options AUTOCLOBBER=1
EOF

./mach --no-interactive bootstrap --application-choice browser
./mach build
./mach package
