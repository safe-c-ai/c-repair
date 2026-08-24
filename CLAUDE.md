# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

C Repair: a VS Code extension (apps/vscode) + local FastAPI bridge (services/repair-api) that scans a single `.c` file for CERT C violations and generates human-reviewed LLM repair candidates. Normative docs: `docs/CONTRACT.md`, `docs/STATE_MODEL.md`, `docs/PRODUCT_FLOW.md`. (References like "D-0xx" in design docs point to internal decision records not included in this repository.)

## Core invariant

**Accepted output = Original C + accepted repair patches** — prelude/inferred-context text must never leak into results. Hunks are Original-coordinate, overlap = conflict (D-004). Machine verification (schema validation, byte-exact fixture comparison) is the acceptance bar.

## Commands

- `npm run validate` — fixture machine-verification
- `npm run typecheck` / `npm run test:vscode` — extension
- `npm run test:api` — bridge (needs `services/repair-api/.venv`)
- `apps/vscode` + F5 — Extension Development Host

## Rules

- Do not re-implement the CertFix engine's detection/repair logic in this repo; the bridge adapts it.
- Keep files LF-only. Do not log or persist user source code.
- Display names may say "C Repair"; internal IDs (`crepair.*`, `CREPAIR_*`) must not change.
