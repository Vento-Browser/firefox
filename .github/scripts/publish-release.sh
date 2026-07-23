#!/bin/bash
# Release publishing helper for the Vento auto-update pipeline.
#
# Two modes, run in order by the release workflow:
#
#   publish-release.sh stage --artifacts <dir> --staging <dir> [--base-url <url>]
#     Lays the downloaded build artifacts out into the bucket's directory tree
#     (see RELEASE.md) under <staging>, and rewrites each MAR publish.json's
#     mar_url to the final public GCS URL. The whole <staging> tree is then
#     uploaded verbatim to the bucket by upload-cloud-storage.
#
#   publish-release.sh register --staging <dir> --backend <url> --token <jwt>
#     POSTs every publish.json under <staging> to the backend's
#     `POST /api/updates` (ADMIN), which is what makes the backend's update.xml
#     start advertising the new build to clients.
#
# The bucket layout (immutable versioned tree + mutable channel pointers):
#   releases/<version>/<os>/<arch>/<binary>
#   releases/<version>/<os>/<arch>/<marname>.complete.mar
#   latest/<channel>/<os>/<arch>/<generic-binary-name>
set -euo pipefail

# Default public read URL of the bucket. The MAR is fetched straight from GCS by
# the browser's updater; only update.xml itself is served by the backend.
DEFAULT_BASE_URL="https://storage.googleapis.com/vento-releases"

die() { echo "ERROR: $*" >&2; exit 1; }

# Darwin_aarch64-gcc3 -> "macos aarch64"; WINNT_x86_64-msvc -> "windows x86_64".
os_arch_from_target() {
  local target="$1" os arch
  case "${target%%_*}" in
    Darwin) os=macos ;;
    WINNT)  os=windows ;;
    Linux)  os=linux ;;
    *) die "unknown build_target OS in '$target'" ;;
  esac
  arch="${target#*_}"      # aarch64-gcc3
  arch="${arch%%-*}"       # aarch64
  echo "$os $arch"
}

json_get() {
  # Minimal field reader so the script has no jq dependency.
  local file="$1" key="$2"
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$file" "$key"
}

cmd_stage() {
  local artifacts="" staging="" base_url="$DEFAULT_BASE_URL"
  while [ $# -gt 0 ]; do
    case "$1" in
      --artifacts) artifacts="$2"; shift 2 ;;
      --staging)   staging="$2"; shift 2 ;;
      --base-url)  base_url="${2%/}"; shift 2 ;;
      *) die "stage: unknown arg '$1'" ;;
    esac
  done
  [ -n "$artifacts" ] && [ -d "$artifacts" ] || die "stage: --artifacts <dir> required"
  [ -n "$staging" ] || die "stage: --staging <dir> required"
  mkdir -p "$staging"

  local version="" published=0
  # One publish.json per (platform) MAR. Drives the versioned tree + registration.
  while IFS= read -r pj; do
    [ -n "$pj" ] || continue
    local mar="${pj%.publish.json}"
    [ -f "$mar" ] || die "MAR file for $pj not found (expected $mar)"
    local marname; marname="$(basename "$mar")"
    local ver bt ch os arch
    ver="$(json_get "$pj" version)"
    bt="$(json_get "$pj" build_target)"
    ch="$(json_get "$pj" channel)"
    read -r os arch < <(os_arch_from_target "$bt")
    version="$ver"

    local reldir="releases/$ver/$os/$arch"
    mkdir -p "$staging/$reldir"
    cp "$mar" "$staging/$reldir/$marname"

    # Point the registration at the exact object we are about to upload.
    local mar_url="$base_url/$reldir/$marname"
    python3 - "$pj" "$mar_url" "$staging/$reldir/$(basename "$pj")" <<'PY'
import json, sys
src, mar_url, dst = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
d["mar_url"] = mar_url
json.dump(d, open(dst, "w"), indent=2)
PY
    echo "staged MAR  $os/$arch  $marname  ->  $mar_url"
    published=$((published + 1))
  done < <(find "$artifacts" -name '*.publish.json' | sort)

  [ -n "$version" ] || die "no *.publish.json found under $artifacts (nothing to release)"

  # Installer binaries have no publish.json; place them by file type. Versioned
  # copy lives next to the MAR; a generic copy under latest/ gives the website a
  # stable download link that always resolves to the newest build.
  stage_binary() {
    local file="$1" os="$2" arch="$3" generic="$4"
    local reldir="releases/$version/$os/$arch"
    mkdir -p "$staging/$reldir" "$staging/latest/release/$os/$arch"
    cp "$file" "$staging/$reldir/$(basename "$file")"
    cp "$file" "$staging/latest/release/$os/$arch/$generic"
    echo "staged bin  $os/$arch  $(basename "$file")  (+latest/$generic)"
  }
  while IFS= read -r f; do
    [ -n "$f" ] && stage_binary "$f" macos aarch64 Vento.dmg
  done < <(find "$artifacts" -name '*.dmg' | sort)
  while IFS= read -r f; do
    [ -n "$f" ] && stage_binary "$f" windows x86_64 Vento-Setup.exe
  done < <(find "$artifacts" -path '*/install/sea/*.exe' -o -name 'Vento*Setup*.exe' | sort -u)

  echo "Staged release $version: $published MAR(s) for auto-update."
  find "$staging" -type f | sort | sed "s#^$staging/#  #"
}

cmd_register() {
  local staging="" backend="" token=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --staging) staging="$2"; shift 2 ;;
      --backend) backend="${2%/}"; shift 2 ;;
      --token)   token="$2"; shift 2 ;;
      *) die "register: unknown arg '$1'" ;;
    esac
  done
  [ -n "$staging" ] && [ -d "$staging" ] || die "register: --staging <dir> required"
  [ -n "$backend" ] || die "register: --backend <url> required"
  [ -n "$token" ] || die "register: --token <jwt> required"

  local any=0
  while IFS= read -r pj; do
    [ -n "$pj" ] || continue
    any=1
    echo "Registering $(basename "$pj") with $backend/api/updates"
    curl -fsS -X POST "$backend/api/updates" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      --data-binary "@$pj" \
      -o /dev/null -w '  -> HTTP %{http_code}\n'
  done < <(find "$staging" -name '*.publish.json' | sort)
  [ "$any" = 1 ] || die "no publish.json found under $staging"
}

mode="${1:-}"; shift || true
case "$mode" in
  stage)    cmd_stage "$@" ;;
  register) cmd_register "$@" ;;
  *) die "usage: publish-release.sh {stage|register} [options]" ;;
esac
