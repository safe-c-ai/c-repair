#!/usr/bin/env bash
# build-bridge-dist.sh — V3b (D-036): build the bridge wheels and stage them for
# the vsix under apps/vscode/bridge-dist/ with a sha256 MANIFEST.
#
#   1. Copy certfix-dev to a temp dir (excluding .git / venvs / caches) and build
#      its wheel FROM THE COPY — the source tree is never written to. The
#      no-write guarantee is checked mechanically: `git status --porcelain` of
#      certfix-dev must be IDENTICAL before and after the build (the tree may
#      carry pre-existing local modifications that are not ours; what this build
#      must prove is that it added none — hence unchanged-comparison, not
#      empty-comparison).
#   2. Build the repair-api wheel (our own repo; in-tree source, separate
#      out-dir).
#   3. Stage both wheels into apps/vscode/bridge-dist/ and write MANIFEST.json
#      ({"format": 1, "files": [{file, sha256, size}]}) — the bootstrap verifies
#      each wheel against it before installing (V3a hand-off).
#
# bridge-dist/ is a build product: gitignored, never committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Path to the CertFix engine checkout (separate repository; not included here).
CERTFIX_SRC="${CERTFIX_SRC:-/work/certfix/certfix-dev}"
REPAIR_API_SRC="$ROOT/services/repair-api"
DIST_DIR="$ROOT/apps/vscode/bridge-dist"

if [ ! -f "$CERTFIX_SRC/pyproject.toml" ]; then
  echo "FATAL: certfix source not found at $CERTFIX_SRC (set CERTFIX_SRC)" >&2
  exit 1
fi

# --- no-write guard: snapshot certfix-dev's status before anything runs -------
porcelain_before="$(git -C "$CERTFIX_SRC" status --porcelain)"
if [ -n "$porcelain_before" ]; then
  echo "note: certfix-dev carries PRE-EXISTING local modifications (not from this build):"
  echo "$porcelain_before" | sed 's/^/  /'
  echo "note: the build only asserts it adds none."
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- tool selection: uv preferred, pip wheel fallback -------------------------
BUILDER=""
if command -v uv >/dev/null 2>&1; then
  BUILDER="uv"
elif command -v python3 >/dev/null 2>&1; then
  BUILDER="pip"
else
  echo "FATAL: neither uv nor python3 is available to build wheels" >&2
  exit 1
fi
echo "wheel builder: $BUILDER"

build_wheel() { # <src-dir> <out-dir>
  local src="$1" out="$2"
  if [ "$BUILDER" = "uv" ]; then
    (cd "$src" && uv build --wheel --out-dir "$out")
  else
    python3 -m pip wheel --no-deps -w "$out" "$src"
  fi
}

# --- 1. certfix: copy out-of-tree, then build from the copy -------------------
echo "copying certfix-dev to a temp tree (no source-tree writes)…"
CERTFIX_COPY="$TMP/certfix"
mkdir -p "$CERTFIX_COPY"
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude '.git' --exclude '.venv*' --exclude '__pycache__' \
    --exclude '*.egg-info' --exclude 'dist' --exclude 'build' \
    --exclude '.pytest_cache' --exclude '.ruff_cache' \
    "$CERTFIX_SRC/" "$CERTFIX_COPY/"
else
  cp -r "$CERTFIX_SRC/." "$CERTFIX_COPY/"
  rm -rf "$CERTFIX_COPY/.git" "$CERTFIX_COPY"/.venv* \
    "$CERTFIX_COPY/dist" "$CERTFIX_COPY/build" \
    "$CERTFIX_COPY/.pytest_cache" "$CERTFIX_COPY/.ruff_cache"
  find "$CERTFIX_COPY" -name '__pycache__' -type d -prune -exec rm -rf {} + || true
  find "$CERTFIX_COPY" -name '*.egg-info' -type d -prune -exec rm -rf {} + || true
fi

OUT_CERTFIX="$TMP/out-certfix"
mkdir -p "$OUT_CERTFIX"
echo "building certfix wheel (from the copy)…"
build_wheel "$CERTFIX_COPY" "$OUT_CERTFIX"

# --- 2. repair-api: our own repo; separate out-dir ----------------------------
OUT_REPAIR="$TMP/out-repair-api"
mkdir -p "$OUT_REPAIR"
echo "building repair-api wheel…"
build_wheel "$REPAIR_API_SRC" "$OUT_REPAIR"

# --- no-write guard: certfix-dev must be EXACTLY as we found it ---------------
porcelain_after="$(git -C "$CERTFIX_SRC" status --porcelain)"
if [ "$porcelain_before" != "$porcelain_after" ]; then
  echo "FATAL: the build modified certfix-dev (stop-line violation). New status entries:" >&2
  diff <(echo "$porcelain_before") <(echo "$porcelain_after") >&2 || true
  exit 1
fi
echo "certfix-dev no-write check: OK (status unchanged)"

# --- 3. stage into bridge-dist/ + MANIFEST.json -------------------------------
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
cp "$OUT_CERTFIX"/*.whl "$OUT_REPAIR"/*.whl "$DIST_DIR/"

python3 - "$DIST_DIR" <<'PY'
import hashlib
import json
import os
import sys

dist = sys.argv[1]
files = sorted(f for f in os.listdir(dist) if f.endswith(".whl"))
entries = []
for name in files:
    path = os.path.join(dist, name)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    entries.append({"file": name, "sha256": digest, "size": os.path.getsize(path)})
manifest = {"format": 1, "files": entries}
with open(os.path.join(dist, "MANIFEST.json"), "w", encoding="utf-8") as fh:
    fh.write(json.dumps(manifest, indent=2) + "\n")
print(f"MANIFEST.json: {len(entries)} wheel(s)")
PY

# --- wheel content check (round 23): the bundled config must ship ------------
python3 - "$DIST_DIR" <<'PY'
import os
import sys
import zipfile

dist = sys.argv[1]
target = "repair_api/config/deepseek-v4-flash-openrouter.yaml"
checked = False
for name in os.listdir(dist):
    if name.startswith("repair_api-") and name.endswith(".whl"):
        names = zipfile.ZipFile(os.path.join(dist, name)).namelist()
        if target not in names:
            print(f"FATAL: {name} does not contain {target} (a wheel-only "
                  "install would report an empty model)", file=sys.stderr)
            sys.exit(1)
        checked = True
if not checked:
    print("FATAL: no repair_api wheel found in bridge-dist", file=sys.stderr)
    sys.exit(1)
print("wheel config check: OK")
PY

echo "bridge-dist ready:"
ls -la "$DIST_DIR"
