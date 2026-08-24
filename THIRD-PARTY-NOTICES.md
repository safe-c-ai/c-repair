# Third-party notices

## SEI CERT C Coding Standard (reference data)

This project scans C code against rules of the SEI CERT C Coding Standard and
displays **rule identifiers (e.g. `STR31-C`) and rule titles** so users can
identify which rule a finding refers to. This reference data originates from
the SEI CERT C Coding Standard, © Carnegie Mellon University. It is used for
identification/interoperability only; rule descriptions, examples, and
compliant solutions are **not** reproduced.

- CERT® is a registered trademark of Carnegie Mellon University.
- This project is **not affiliated with, sponsored, or endorsed by** Carnegie
  Mellon University or the Software Engineering Institute.
- This tool does **not** provide official conformance certification.
- The rule ID/title reference data is **excluded from this repository's MIT
  license grant** (see LICENSE).

## Bundled runtime components (vsix)

The VS Code extension package (`.vsix`) bundles Python wheels used to run the
local bridge on `127.0.0.1`:

- `repair_api` — built from `services/repair-api` in this repository (MIT).
- `certfix` — the CERT C repair harness (separate repository); the bundled
  wheel's exact version and SHA-256 are recorded in
  `apps/vscode/bridge-dist/MANIFEST.json` at build time.

Python dependencies installed at setup time (FastAPI, uvicorn, httpx, etc.)
are fetched from PyPI under their respective licenses.

## Services

The extension sends the scanned C source to OpenRouter (and the routed model
provider) using the user's own API key (BYOK). No source code is sent to the
authors of this project.
