#!/usr/bin/env node
// Fixture validator for the C Repair Web Prototype (Phase 0).
// Checks fixtures against the contract schemas and the invariants in
// docs/CONTRACT.md / docs/STATE_MODEL.md. See task T0.4.
//
// Uses ajv when available; otherwise falls back to a minimal built-in
// validator (required / type / enum / pattern / const / additionalProperties).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

// Shared canonical implementation (byte-identical with the web UI).
import {
  applyHunks,
  candidatesConflict,
  synthesizedPreludeLineCount,
  MARKER_START,
  MARKER_END,
} from '@c-repair/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCHEMA_DIR = join(ROOT, 'packages', 'contract', 'schemas');
const FIX = join(ROOT, 'tests', 'fixtures');

const errors = [];
const warnings = [];
function err(where, msg) {
  errors.push(`[FAIL] ${where}: ${msg}`);
}
function warn(where, msg) {
  warnings.push(`[WARN] ${where}: ${msg}`);
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------
function readText(p) {
  return readFileSync(p, 'utf8');
}
function readJson(p) {
  return JSON.parse(readText(p));
}
function sha256(text) {
  return 'sha256:' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// Schema validation: ajv if present, else minimal fallback
// ---------------------------------------------------------------------------
let validatorMode = 'ajv';
let compileValidator;

try {
  const { default: Ajv } = await import('ajv');
  const ajv = new Ajv({ allErrors: true, strict: false });
  // Load all schemas so $ref by $id resolves.
  const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'));
  for (const f of schemaFiles) {
    ajv.addSchema(readJson(join(SCHEMA_DIR, f)));
  }
  compileValidator = (schemaId) => {
    const v = ajv.getSchema(schemaId);
    if (!v) throw new Error(`schema not found: ${schemaId}`);
    return (data) => ({ ok: v(data), errors: v.errors || [] });
  };
} catch (e) {
  validatorMode = 'fallback';
  const schemas = {};
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.schema.json'))) {
    const s = readJson(join(SCHEMA_DIR, f));
    schemas[s.$id] = s;
  }
  const resolveRef = (ref, rootSchema) => {
    // Supports "#/definitions/x" within the same schema document.
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
    const parts = ref.slice(2).split('/');
    let node = rootSchema;
    for (const part of parts) node = node[part];
    if (!node) throw new Error(`unresolved $ref: ${ref}`);
    return node;
  };
  const typeOk = (t, val) => {
    switch (t) {
      case 'string': return typeof val === 'string';
      case 'integer': return Number.isInteger(val);
      case 'number': return typeof val === 'number';
      case 'boolean': return typeof val === 'boolean';
      case 'object': return val !== null && typeof val === 'object' && !Array.isArray(val);
      case 'array': return Array.isArray(val);
      case 'null': return val === null;
      default: return true;
    }
  };
  const validateNode = (schema, data, path, root, out) => {
    if (schema.$ref) {
      return validateNode(resolveRef(schema.$ref, root), data, path, root, out);
    }
    if (schema.const !== undefined && data !== schema.const) {
      out.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    }
    if (schema.enum && !schema.enum.includes(data)) {
      out.push(`${path}: must be one of ${JSON.stringify(schema.enum)} (got ${JSON.stringify(data)})`);
    }
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeOk(t, data))) {
        out.push(`${path}: expected type ${types.join('|')} (got ${data === null ? 'null' : typeof data})`);
        return; // further checks meaningless on wrong type
      }
    }
    if (schema.pattern && typeof data === 'string') {
      if (!new RegExp(schema.pattern).test(data)) {
        out.push(`${path}: does not match pattern ${schema.pattern}`);
      }
    }
    if (typeof data === 'number' && schema.minimum !== undefined && data < schema.minimum) {
      out.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (typeOk('object', data) && (schema.properties || schema.required || schema.additionalProperties === false)) {
      for (const req of schema.required || []) {
        if (!(req in data)) out.push(`${path}: missing required property '${req}'`);
      }
      if (schema.additionalProperties === false && schema.properties) {
        for (const k of Object.keys(data)) {
          if (!(k in schema.properties)) out.push(`${path}: unexpected property '${k}'`);
        }
      }
      if (schema.properties) {
        for (const [k, sub] of Object.entries(schema.properties)) {
          if (k in data) validateNode(sub, data[k], `${path}.${k}`, root, out);
        }
      }
      // conditional if/then (used for finding.rule_id when kind=violation)
      if (schema.if && schema.then) {
        const condOut = [];
        validateNode(schema.if, data, path, root, condOut);
        if (condOut.length === 0) validateNode(schema.then, data, path, root, out);
      }
    }
    if (typeOk('array', data) && schema.items) {
      data.forEach((el, i) => validateNode(schema.items, el, `${path}[${i}]`, root, out));
    }
  };
  compileValidator = (schemaId) => {
    const root = schemas[schemaId];
    if (!root) throw new Error(`schema not found: ${schemaId}`);
    return (data) => {
      const out = [];
      validateNode(root, data, '$', root, out);
      return { ok: out.length === 0, errors: out.map((message) => ({ message })) };
    };
  };
}

const SID = (name) => `https://c-repair.local/schemas/${name}.schema.json`;
const validators = {
  source: compileValidator(SID('source-document')),
  augmentation: compileValidator(SID('context-augmentation-set')),
  scan: compileValidator(SID('function-scan-result')),
  candidate: compileValidator(SID('repair-candidate')),
  selection: compileValidator(SID('patch-selection')),
  report: compileValidator(SID('export-report')),
};

function checkSchema(label, kind, data) {
  const { ok, errors: verrs } = validators[kind](data);
  if (!ok) {
    for (const e of verrs) err(label, `schema (${kind}): ${e.message || JSON.stringify(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Hunk application, conflict detection, and prelude synthesis are provided by
// the shared @c-repair/core module (imported above) — the single canonical
// implementation, byte-identical with the web UI.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-set validation
// ---------------------------------------------------------------------------
const SETS = ['sample_sensor', 'sample_clean', 'sample_conflict'];

for (const set of SETS) {
  const label = set;
  const srcPath = join(FIX, 'source', `${set}.c`);
  const augPath = join(FIX, 'context', `${set}.augmentation.json`);
  const scanPath = join(FIX, 'scan-results', `${set}.scan.json`);
  const candPath = join(FIX, 'repair-candidates', `${set}.candidates.json`);
  const selPath = join(FIX, 'selections', `${set}.selection.json`);
  const acceptedPath = join(FIX, 'expected-output', `${set}.accepted.c`);
  const reportPath = join(FIX, 'expected-output', `${set}.report.json`);

  const srcContent = readText(srcPath);
  const acceptedContent = readText(acceptedPath);

  // Build a source-document object for schema check (fixture origin).
  const sourceDoc = {
    source_id: `src-${set.replace(/_/g, '-')}`,
    filename: `${set}.c`,
    language: 'c',
    content: srcContent,
    content_hash: sha256(srcContent),
    size_bytes: Buffer.byteLength(srcContent, 'utf8'),
    origin: 'fixture',
  };
  checkSchema(`${label}/source-document`, 'source', sourceDoc);

  const aug = readJson(augPath);
  const scan = readJson(scanPath);
  const sel = readJson(selPath);
  const report = readJson(reportPath);
  let candidates = [];
  let hasCandidates = true;
  try {
    candidates = readJson(candPath);
  } catch {
    hasCandidates = false;
  }

  checkSchema(`${label}/augmentation`, 'augmentation', aug);
  checkSchema(`${label}/scan`, 'scan', scan);
  checkSchema(`${label}/selection`, 'selection', sel);
  checkSchema(`${label}/report`, 'report', report);
  if (hasCandidates) {
    if (!Array.isArray(candidates)) {
      err(`${label}/candidates`, 'candidates file must be a JSON array');
    } else {
      candidates.forEach((c, i) =>
        checkSchema(`${label}/candidates[${i}] (${c && c.candidate_id})`, 'candidate', c)
      );
    }
  }

  // Check #2: source content_hash matches actual sha256.
  // (source-document is synthesized here; also verify hashes carried by other objects.)
  const realHash = sha256(srcContent);
  for (const [name, obj] of [
    ['augmentation.original_hash', aug.original_hash],
    ['scan.original_hash', scan.original_hash],
    ['selection.original_hash', sel.original_hash],
    ['report.source.original_hash', report.source.original_hash],
  ]) {
    if (obj !== realHash) {
      err(`${label}/${name}`, `hash mismatch: fixture=${obj} actual=${realHash}`);
    }
  }
  if (hasCandidates && Array.isArray(candidates)) {
    candidates.forEach((c) => {
      if (c.original_hash !== realHash) {
        err(`${label}/candidates ${c.candidate_id}`, `original_hash mismatch: ${c.original_hash} != ${realHash}`);
      }
    });
  }

  // Check #6: each function has <= 1 finding (D-003).
  for (const fn of scan.functions) {
    if ((fn.findings || []).length > 1) {
      err(`${label}/scan ${fn.name}`, `has ${fn.findings.length} findings; V1 allows <= 1 (D-003)`);
    }
  }

  // Check #8: prelude_line_count matches synthesized composition.
  const synth = synthesizedPreludeLineCount(aug.items);
  if (aug.prelude_line_count !== synth) {
    err(`${label}/augmentation`, `prelude_line_count=${aug.prelude_line_count} but synthesized=${synth}`);
  }

  // Determine accepted candidate set from the selection.
  const acceptedIds = new Set(
    sel.decisions.filter((d) => d.decision === 'accepted').map((d) => d.candidate_id)
  );
  const acceptedCandidates = (Array.isArray(candidates) ? candidates : []).filter((c) =>
    acceptedIds.has(c.candidate_id)
  );

  // Check #7: accepted candidates must not mutually conflict.
  for (let i = 0; i < acceptedCandidates.length; i++) {
    for (let j = i + 1; j < acceptedCandidates.length; j++) {
      if (candidatesConflict(acceptedCandidates[i], acceptedCandidates[j])) {
        err(
          `${label}/selection`,
          `accepted candidates ${acceptedCandidates[i].candidate_id} and ${acceptedCandidates[j].candidate_id} have intersecting hunks`
        );
      }
    }
  }

  // Conflict set: cand-001 and cand-002 must actually intersect.
  if (set === 'sample_conflict' && Array.isArray(candidates)) {
    const c1 = candidates.find((c) => c.candidate_id === 'cand-001');
    const c2 = candidates.find((c) => c.candidate_id === 'cand-002');
    if (!c1 || !c2) {
      err(`${label}/candidates`, 'expected cand-001 and cand-002 for the conflict set');
    } else if (!candidatesConflict(c1, c2)) {
      err(`${label}/candidates`, 'conflict set expects cand-001 and cand-002 hunks to intersect, but they do not');
    }
  }

  // Check #3: applying accepted hunks to source == expected accepted.c (byte-exact).
  const allAcceptedHunks = acceptedCandidates.flatMap((c) => c.hunks);
  const applied = applyHunks(srcContent, allAcceptedHunks);
  if (applied !== acceptedContent) {
    err(`${label}/expected-output`, 'applied accepted hunks do not byte-match expected accepted.c');
  }

  // Check #4: no prelude marker text in accepted.c.
  if (acceptedContent.includes(MARKER_START) || acceptedContent.includes(MARKER_END) ||
      acceptedContent.includes('C Repair inferred context') ||
      acceptedContent.includes('===== Original source =====')) {
    err(`${label}/expected-output`, 'accepted.c contains prelude marker text');
  }

  // Check #5: report.output.content_hash == sha256 of accepted.c.
  const acceptedHash = sha256(acceptedContent);
  if (report.output.content_hash !== acceptedHash) {
    err(
      `${label}/report`,
      `output.content_hash=${report.output.content_hash} but actual sha256=${acceptedHash}`
    );
  }

  // Warning (D-003): findings[] cardinality is a warning target too (already error above);
  // also warn if a violation finding lacks a rule_id (schema enforces, this is belt+braces).
  for (const fn of scan.functions) {
    for (const f of fn.findings || []) {
      if (f.kind === 'violation' && !f.rule_id) {
        warn(`${label}/scan ${fn.name}`, 'violation finding without rule_id');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`Fixture validation (schema validator: ${validatorMode})`);
console.log(`Sets checked: ${SETS.join(', ')}`);
for (const w of warnings) console.log(w);

if (errors.length > 0) {
  console.error(`\n${errors.length} check(s) FAILED:`);
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`\nAll checks passed (${SETS.length} sets).`);
process.exit(0);
