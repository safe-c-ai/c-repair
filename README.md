# C Repair

**AI-assisted detection, repair, and validation for C coding standards. Currently supports CERT® C.**

C Repair is a VS Code extension (plus a local bridge) that takes a single `.c` file, scans every function for CERT C violations, generates repair candidates with a local model or an API model (OpenRouter, bring-your-own-key), and puts a human in charge of every change: each candidate carries five validation gates (format / compile / violation-removal / semantic / regression) and is applied only on explicit Accept. The invariant: **the output is always `Original C + accepted patches` — nothing else is ever mixed in.**

> Imported from prior private development on 2026-08-24 (history squashed at first public release).

## Install & use

See the [extension overview](apps/vscode/README.md) for installation, requirements, costs and data handling. The [user guide](apps/vscode/docs/user-guide.md) ([日本語](apps/vscode/docs/user-guide.ja.md)) covers local or API setup, Scan, review and Accept. Local model tuning is in the [settings guide](apps/vscode/docs/local-models.md) ([日本語](apps/vscode/docs/local-models.ja.md)). Local inference requires a platform-specific 0.2.0 or later build for Apple Silicon Mac, Windows x64, or Linux / WSL2 x64. See the [change log](apps/vscode/CHANGELOG.md) for upgrade instructions.

## Monorepo layout

```
c-repair/
├── docs/                    design docs (CONTRACT / STATE_MODEL / PRODUCT_FLOW = normative)
├── packages/contract/       JSON Schemas for every API payload
├── packages/core/           hunk application & shared pure logic (single implementation)
├── services/repair-api/     FastAPI bridge wrapping the CertFix harness (localhost only)
├── apps/vscode/             the VS Code extension
└── tests/fixtures/          machine-verified sample flows
```

## Develop

```bash
npm install
npm run validate      # fixture machine-verification (byte-exact)
npm run typecheck
npm run test:vscode   # extension unit tests
npm run test:api      # bridge tests (needs services/repair-api/.venv)
```

For platform-specific VSIX builds, run `npm run package:vsix -- all` (or a single target). Completed artifacts are written to `dist/vsix/dev/<build-id>/`; see [VSIX build and distribution](docs/VSIX_PACKAGING.md).

For development, the bridge prefers `services/repair-api/.venv`. A manually prepared Python 3.10+ environment can be selected with `crepair.bridge.pythonPath`; local MLX preparation uses its dedicated Python environment.

`apps/vscode` + F5 launches the Extension Development Host. The bridge starts automatically (monorepo `.venv` preferred; end users get a `uv`-provisioned environment via *Set Up Bridge*).

## License & attribution

MIT (see [LICENSE](LICENSE)). CERT® is a registered trademark of Carnegie Mellon University; this project is not affiliated with or endorsed by CMU/SEI, does not provide official conformance certification, and does not reproduce rule text — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
