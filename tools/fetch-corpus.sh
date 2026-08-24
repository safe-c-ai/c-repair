#!/usr/bin/env bash
# Real-world C corpus fetcher (docs/REALWORLD_CORPUS.md).
#
# Downloads a curated set of well-known open-source C files into
# ../c-repair-play/corpus/ (OUTSIDE this repository — third-party code is never
# committed here). Local testing only; see the license notes in the doc before
# redistributing anything.
set -euo pipefail

DEST="${1:-$(cd "$(dirname "$0")/../.." && pwd)/c-repair-play/corpus}"
mkdir -p "$DEST"
cd "$DEST"

MANIFEST="$DEST/MANIFEST.txt"
: > "$MANIFEST"

fetch() { # fetch <name> <url>
  echo "fetching $1"
  curl -sL --fail -o "$1" "$2"
  echo "$1  $(sha256sum "$1" | cut -d' ' -f1)  $2  $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
}

# --- small/medium (permissive licenses) --------------------------------------
fetch lua-lapi.c      https://raw.githubusercontent.com/lua/lua/master/lapi.c        # MIT
fetch lua-lgc.c       https://raw.githubusercontent.com/lua/lua/master/lgc.c         # MIT
fetch zlib-inflate.c  https://raw.githubusercontent.com/madler/zlib/master/inflate.c # zlib
fetch zlib-deflate.c  https://raw.githubusercontent.com/madler/zlib/master/deflate.c # zlib
fetch curl-url.c      https://raw.githubusercontent.com/curl/curl/master/lib/url.c   # curl (MIT-like)
fetch curl-http.c     https://raw.githubusercontent.com/curl/curl/master/lib/http.c  # curl (MIT-like)
fetch git-strbuf.c    https://raw.githubusercontent.com/git/git/master/strbuf.c      # GPLv2 (local testing only)

# --- huge: SQLite amalgamation (public domain) -------------------------------
SQLITE_ZIP="sqlite-amalgamation-3530400"
if [ ! -f sqlite3.c ]; then
  echo "fetching ${SQLITE_ZIP} (~2.5MB zip)"
  curl -sL --fail -o sq.zip "https://sqlite.org/2026/${SQLITE_ZIP}.zip"
  unzip -o -q sq.zip "${SQLITE_ZIP}/sqlite3.c" "${SQLITE_ZIP}/sqlite3.h"
  mv "${SQLITE_ZIP}/sqlite3.c" "${SQLITE_ZIP}/sqlite3.h" .
  echo "sqlite3.c  $(sha256sum sqlite3.c | cut -d' ' -f1)  https://sqlite.org/2026/${SQLITE_ZIP}.zip  $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
  rm -rf "${SQLITE_ZIP}" sq.zip || true
fi

echo
echo "corpus ready in: $DEST"
wc -l ./*.c | sort -n
