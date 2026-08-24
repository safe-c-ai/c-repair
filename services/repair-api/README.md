# repair-api

CertFix in-process scan service for the C Repair Web Prototype (Phase 3a).

A small FastAPI service that composes Augmented C from a `SourceDocument` +
confirmed `ContextAugmentationSet`, runs CertFix's `Detector.check_file`, and
returns a `FunctionScanResult` (contract JSON). `repair` is Phase 3b (returns
501).

## Stop-line (PHASE3A_DESIGN.md §7)

- Bind **localhost only** (`--host 127.0.0.1`). Never expose `0.0.0.0`.
- Source content is **never logged** (hashes and line numbers only).
- The per-job temp dir holding Augmented C is always deleted.

## venv setup

CertFix is **not** a declared dependency of this package. It is installed into
the venv as a **non-editable** install so that no `egg-info` / `*.egg-link` is
written into `certfix-dev` (a hard guardrail).

```bash
cd services/repair-api

# 1. create venv (do NOT `pip install --upgrade pip` inside it — the base pip works)
python3 -m venv .venv
. .venv/bin/activate

# 2. install this service + dev deps (fastapi / uvicorn / pydantic / pytest / httpx / jsonschema)
pip install -e ".[dev]"

# 3. install CertFix NON-editable (note: no -e). Provides `import certfix`.
pip install "$CERTFIX_SRC"   # path to your CertFix engine checkout (separate repository)
```

Verify no egg-info was written into certfix-dev:

```bash
git -C "$CERTFIX_SRC" status --short   # must be unchanged
```

## uv bootstrap (PoC)

`scripts/bootstrap-uv.sh` is a Dockerless, one-shot proof of the distribution
path a VS Code extension could reproduce (VSCODE_PIVOT_PLAN §3). It:

1. ensures `uv` is on PATH (installs it via the official installer into
   `$CREPAIR_UV_HOME`, default `~/.local`, when missing);
2. creates an **isolated** venv at `.venv-uv-poc` (gitignored; never touches the
   working `.venv`);
3. `uv pip install`s this package and CertFix **non-editable** (no egg-info is
   written into certfix-dev);
4. generates a random `CREPAIR_BRIDGE_TOKEN`, starts the bridge in the
   background with Bearer auth required, curls `/health` with the token
   (and confirms a no-token request gets `401`), prints the identity JSON, then
   stops the bridge.

```bash
services/repair-api/scripts/bootstrap-uv.sh
# ... -> {"status":"ok","harness":{"id":"certfix","version":"0.4.1"}, ...
#         "contract_version":"1","capabilities":{...,"rules_count":115,...}}
```

The token value is never printed. Env overrides: `CREPAIR_UV_HOME`,
`CERTFIX_SRC`, `CREPAIR_BRIDGE_PORT`. Linux-verified; Windows/macOS bootstrap is
tracked as an open item (VSCODE_PIVOT_PLAN §9).

## Running the server

```bash
export OPENROUTER_API_KEY=...            # required for /scan (LLM detection); not needed for /health or tests
uvicorn repair_api.main:app --host 127.0.0.1 --port 8787
```

`/health` returns the harness + adapter identity, contract version, and
capabilities. It requires no API key (but is subject to Bearer-token auth when
enabled — see below):

```bash
curl -s http://127.0.0.1:8787/health
# {"status":"ok",
#  "harness":{"id":"certfix","version":"0.4.1"},
#  "adapter":{"id":"certfix-inprocess","version":"0.1.0"},
#  "contract_version":"1",
#  "capabilities":{"rule_profile":"cert-c","rules_count":115,
#    "gates":["format","compile","violation_removal","semantic","regression"],
#    "routes":["api"],
#    "model":"deepseek/deepseek-v4-flash","provider_order":["DeepInfra"]}}
```

`rules_count` is read dynamically from the bundled CertFix rule catalog
(`total_rules`), falling back to `115` (certfix `docs/SUPPORTED_RULES.md`).

> Identity field naming: the harness identity is `harness` (was `engine` before
> the D-017a rename — CertFix is a harness / workflow, not an engine).

## Live repair smoke (opt-in)

`scripts/live-repair-smoke.mjs` drives the full repair flow over HTTP against a
running bridge: `/context/infer` -> `/context/confirm` -> `/scan` -> picks the
first `violation` finding -> `/repair`, then applies the returned hunks with the
shared `@c-repair/core` `applyHunks` and verifies **no prelude marker leaks** into
the result. It calls a real LLM, so the bridge must have `OPENROUTER_API_KEY` set.

```bash
# 1. start the bridge (needs OPENROUTER_API_KEY for /scan + /repair)
export OPENROUTER_API_KEY=...
uvicorn repair_api.main:app --host 127.0.0.1 --port 8787

# 2. run the smoke against a C file (base URL and token are optional)
node scripts/live-repair-smoke.mjs <file.c> [base-url] [token]
# e.g. node scripts/live-repair-smoke.mjs ../../tests/fixtures/commented.c
```

`base-url` defaults to `http://127.0.0.1:8787`; `token` defaults to
`$CREPAIR_BRIDGE_TOKEN` (needed only when the bridge runs with Bearer auth). The
script prints the scan/repair timings, candidate status, per-gate validations,
and the applied target-function region, then exits non-zero if a prelude marker
leaked through the hunks.

## Bearer token auth (D-017d)

Set `CREPAIR_BRIDGE_TOKEN` before starting the bridge to require
`Authorization: Bearer <token>` on **every** endpoint (including `/health`).
Missing or mismatched tokens get `401`. When the env var is unset (or empty),
the bridge runs unauthenticated — the dev mode used by the Web regression bench
and pytest. The token value is never logged.

```bash
export CREPAIR_BRIDGE_TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
uvicorn repair_api.main:app --host 127.0.0.1 --port 8787
curl -s -H "Authorization: Bearer $CREPAIR_BRIDGE_TOKEN" http://127.0.0.1:8787/health
```

## Endpoints (PHASE3A_DESIGN.md §2)

| endpoint | behavior |
|---|---|
| `GET /health` | `{status, harness{id,version}, adapter{id,version}, contract_version, capabilities{rule_profile, rules_count, gates[], routes[], model, provider_order[]}}` |
| `POST /context/infer` | `{source_document}` -> empty **draft** set (Phase 3a; items empty, `prelude_line_count=4`) |
| `POST /context/confirm` | `{context_augmentation_set}` -> confirmed set with deterministic `context_revision_id` (idempotent) |
| `POST /scan` | `{source_document, context_augmentation_set, compile_include_paths?}` -> `FunctionScanResult`. 409 if set is not confirmed or `original_hash` mismatches. `compile_include_paths` (D-020) is accepted but **ignored** (scan runs no compile gate) |
| `POST /repair` | `{source_document, context_augmentation_set, function_id, finding, compile_include_paths?}` -> `RepairCandidate`. 409 (unconfirmed / hash mismatch), 422 (non-violation finding). `compile_include_paths` (D-020) is merged into the compile `-I` paths |

### Compile include paths (D-020)

`ScanRequest` / `RepairRequest` accept an optional `compile_include_paths:
[string]` (default `[]`). These are **bridge-API** (request envelope) fields — the
6 contract schemas are unchanged. On `/repair`, they are merged (append,
de-duplicated, order-preserving) into the effective compile config's
`include_paths`, which certfix turns into `-I <path>` args for **both** the
baseline (unrepaired) compile pre-check and the candidate compile gate. This lets
a real project's `.c` — whose missing declarations live in project headers —
compile, so `compile: skipped` is avoided without any LLM. Paths are not
existence-checked (gcc reports bad ones); only the **count** is logged, never
contents. On `/scan` the field is accepted for symmetry but ignored (no compile
gate). Omitting it reproduces the pre-D-020 behaviour exactly.

## Config

`config/deepseek-v4-flash-openrouter.yaml` is a **copy** of the CertFix bundled config
(detection `timeout` adjusted to 120s). Runtime never references a `certfix-dev`
path. Set `OPENROUTER_API_KEY` in the environment for real detection.

### Model / provider overrides (D-019)

All config loading goes through `repair_api.config_override.load_effective_config`,
which reads the bundled YAML and then applies these optional env overrides (the
VS Code extension sets them at bridge spawn). **With none set, the effective
config is bit-identical to `Config.load(CONFIG_PATH)`** — default behaviour is
unchanged.

| Env var | Effect |
| --- | --- |
| `CREPAIR_CONFIG_PATH` | Load this YAML instead of the bundled one (full escape hatch). The overrides below still apply on top of it. |
| `CREPAIR_MODEL_ID` | Replace `detection.api.model` and every `models.*.api.model`. |
| `CREPAIR_PROVIDER_ORDER` | Comma-separated provider order for `extra_body.provider.order` (detection + all roles). **An explicit empty string removes the pin** (OpenRouter automatic routing). Unset = leave the YAML value. |
| `CREPAIR_ALLOW_FALLBACKS` | `true`/`false` for `extra_body.provider.allow_fallbacks`. |

The **effective** model + provider are reported in `/health` under
`capabilities.model` and `capabilities.provider_order` (an empty array = OpenRouter
automatic routing). These are additive; `contract_version` stays `"1"` and the 6
contract schemas are untouched. Only model / provider identifiers pass through the
override layer — no secret is read or logged.

## Tests

Unit tests use a **fake** `InferenceBackend` (no LLM is ever called):

```bash
. .venv/bin/activate
pytest
```

From the monorepo root: `npm run test:api` (assumes the venv above exists at
`services/repair-api/.venv`).
