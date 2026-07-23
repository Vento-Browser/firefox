#!/bin/bash
# Unpacks the MAR signing NSS DB from MAR_SIGNING_NSSDB_B64 and generates the
# signed full-update MAR by delegating to make-update-mar.sh. Shared by the
# macOS and Windows build jobs so the extraction logic lives in one place and
# needs no PowerShell/bash escaping on Windows.
#
# The secret is `tar czf - -C <nssdb-parent> nssdb | base64` of the NSS DB that
# holds the MAR signing private key. When the secret is unset this is a no-op
# success, so the build workflow stays green before signing is configured.
set -euo pipefail

if [ -z "${MAR_SIGNING_NSSDB_B64:-}" ]; then
  echo "MAR_SIGNING_NSSDB_B64 secret not set - skipping MAR generation"
  exit 0
fi

nssdb="$(mktemp -d)"
echo "$MAR_SIGNING_NSSDB_B64" | base64 -d | tar -xzf - -C "$nssdb"
keyfile="$(find "$nssdb" \( -name key4.db -o -name key3.db \) | head -1)"
dbdir="$([ -n "$keyfile" ] && dirname "$keyfile" || echo "$nssdb")"

topsrcdir="$(cd "$(dirname "$0")/../.." && pwd)"
"$topsrcdir/.github/scripts/make-update-mar.sh" -d "sql:$dbdir"
