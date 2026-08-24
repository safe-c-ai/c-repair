#!/usr/bin/env bash
# bootstrap-uv.sh — uv bootstrap PoC for the C Repair harness bridge (V0-4).
#
# Proves a Dockerless, uv-driven path (VSCODE_PIVOT_PLAN §3) that a VS Code
# extension could reproduce:
#   1. ensure `uv` is on PATH (install via the official installer if missing),
#   2. create an isolated venv (`.venv-uv-poc`, independent of the working
#      `.venv` so the existing dev environment is never touched),
#   3. install this repair-api package and CertFix (NON-editable, so no
#      egg-info / *.egg-link is written into certfix-dev),
#   4. generate a random CREPAIR_BRIDGE_TOKEN and start the bridge in the
#      background with Bearer-token auth required,
#   5. curl /health with the token and print the identity JSON,
#   6. stop the bridge.
#
# The token is never printed. The script is idempotent and cleans up the bridge
# process on exit. Network access is required for step 1 (only when uv is
# absent) and for the uv installs.
#
# Usage:
#   services/repair-api/scripts/bootstrap-uv.sh
#
# Env overrides:
#   CREPAIR_UV_HOME   install prefix for the official uv installer (default: ~/.local)
#   CERTFIX_SRC       path to the CertFix source to install (default: /work/certfix/certfix-dev)
#   CREPAIR_BRIDGE_PORT  bridge port (default: 8799)

set -euo pipefail

# --- paths ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"            # services/repair-api
VENV_DIR="${API_DIR}/.venv-uv-poc"
# Path to the CertFix engine checkout (separate repository; not included here).
CERTFIX_SRC="${CERTFIX_SRC:-/work/certfix/certfix-dev}"
CREPAIR_UV_HOME="${CREPAIR_UV_HOME:-${HOME}/.local}"
PORT="${CREPAIR_BRIDGE_PORT:-8799}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"

log() { printf '[bootstrap-uv] %s\n' "$*"; }

BRIDGE_PID=""
cleanup() {
  if [[ -n "${BRIDGE_PID}" ]] && kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    log "stopping bridge (pid ${BRIDGE_PID})"
    kill "${BRIDGE_PID}" 2>/dev/null || true
    wait "${BRIDGE_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- 1. ensure uv -----------------------------------------------------------
if command -v uv >/dev/null 2>&1; then
  log "uv already on PATH: $(uv --version)"
else
  log "uv not found; installing via official installer into ${CREPAIR_UV_HOME}"
  export UV_INSTALL_DIR="${CREPAIR_UV_HOME}/bin"
  export XDG_BIN_HOME="${CREPAIR_UV_HOME}/bin"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${CREPAIR_UV_HOME}/bin:${PATH}"
  command -v uv >/dev/null 2>&1 || { log "ERROR: uv install failed"; exit 1; }
  log "installed uv: $(uv --version)"
fi

# --- 2. isolated venv -------------------------------------------------------
log "creating isolated venv at ${VENV_DIR}"
rm -rf "${VENV_DIR}"
uv venv --python 3.10 "${VENV_DIR}"

# --- 3. installs (NON-editable certfix; guardrail) --------------------------
log "installing repair-api (with dev extras) into the PoC venv"
VIRTUAL_ENV="${VENV_DIR}" uv pip install --python "${VENV_DIR}/bin/python" "${API_DIR}[dev]"

log "installing CertFix NON-editable from ${CERTFIX_SRC}"
VIRTUAL_ENV="${VENV_DIR}" uv pip install --python "${VENV_DIR}/bin/python" "${CERTFIX_SRC}"

PYBIN="${VENV_DIR}/bin/python"

# --- 4. random token + background bridge ------------------------------------
CREPAIR_BRIDGE_TOKEN="$("${PYBIN}" -c 'import secrets;print(secrets.token_urlsafe(32))')"
export CREPAIR_BRIDGE_TOKEN
log "generated bridge token (value hidden), starting bridge on 127.0.0.1:${PORT}"

"${PYBIN}" -m uvicorn repair_api.main:app \
  --host 127.0.0.1 --port "${PORT}" --log-level warning \
  >/tmp/crepair-uv-poc-bridge.log 2>&1 &
BRIDGE_PID=$!

# --- 5. wait for /health then curl with token -------------------------------
log "waiting for /health to accept the token"
ok=""
for _ in $(seq 1 40); do
  if code="$(curl -s -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer ${CREPAIR_BRIDGE_TOKEN}" "${HEALTH_URL}" 2>/dev/null)" \
     && [[ "${code}" == "200" ]]; then
    ok="1"; break
  fi
  sleep 0.25
done

if [[ -z "${ok}" ]]; then
  log "ERROR: bridge did not become healthy. Bridge log:"
  cat /tmp/crepair-uv-poc-bridge.log || true
  exit 1
fi

# Negative control: without the token the same endpoint must return 401.
noauth_code="$(curl -s -o /dev/null -w '%{http_code}' "${HEALTH_URL}" 2>/dev/null || true)"
log "auth check: no-token request -> HTTP ${noauth_code} (expect 401)"

log "identity JSON from ${HEALTH_URL}:"
curl -s -H "Authorization: Bearer ${CREPAIR_BRIDGE_TOKEN}" "${HEALTH_URL}"
echo

log "SUCCESS: uv bootstrap PoC completed."
