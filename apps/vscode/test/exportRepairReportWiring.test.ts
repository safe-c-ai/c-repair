// Wiring tests for Export Repair Report:
//   (1) ScanSession.dispositionFor records the D-023 override correctly on the
//       single-accept path (setAcceptedWithWarning) and NOT on the bulk-accept
//       path (setDecision), matching the two extension.ts accept sites; and
//   (2) the `crepair.exportRepairReport` command is declared (contributes.commands)
//       with the "C Repair" category, and is wired into the TreeView view/title.
// Pure Node — no `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ScanSession } from '../src/session/ScanSession';
import { flatProperties } from './configSections';
import type {
  FunctionScanResult,
  SourceDocument,
  ContextAugmentationSet,
} from '@c-repair/contract';

const SAMPLE = 'int main(void) { return 0; }\n';

function sha(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

function makeSession(): ScanSession {
  const scan: FunctionScanResult = {
    scan_id: 'scan-1',
    source_id: 'src-1',
    original_hash: sha(SAMPLE),
    context_revision_id: 'rev-1',
    rule_profile: { id: 'cert-c', version: '1' },
    adapter: { id: 'a', version: '1' },
    harness: { id: 'certfix', version: '0.4.1' },
    functions: [],
  };
  const source: SourceDocument = {
    source_id: 'src-1',
    filename: 'a.c',
    language: 'c',
    content: SAMPLE,
    content_hash: sha(SAMPLE),
    size_bytes: Buffer.byteLength(SAMPLE, 'utf8'),
    origin: 'vscode_document',
  };
  const confirmed: ContextAugmentationSet = {
    set_id: 'set-1',
    source_id: 'src-1',
    original_hash: sha(SAMPLE),
    status: 'confirmed',
    context_revision_id: 'rev-1',
    prelude_line_count: 0,
    items: [],
  };
  return new ScanSession(
    ScanSession.makeSnapshot('file:///a.c', 'a.c', SAMPLE),
    'rev-1',
    scan,
    source,
    confirmed,
  );
}

// --- (1) override recording on both accept paths ------------------------------

test('dispositionFor: single accept over a judgment warning records overrode=true', () => {
  const s = makeSession();
  // The single-accept path calls setAcceptedWithWarning (extension.ts line 2682).
  s.setAcceptedWithWarning('cand-1');
  assert.deepEqual(s.dispositionFor('cand-1'), { decision: 'accepted', overrode: true });
});

test('dispositionFor: plain single accept records overrode=false', () => {
  const s = makeSession();
  // The no-warning single-accept path (extension.ts line 2683).
  s.setDecision('cand-1', 'accepted');
  assert.deepEqual(s.dispositionFor('cand-1'), { decision: 'accepted', overrode: false });
});

test('dispositionFor: bulk accept records overrode=false (bulk never overrides, D-014)', () => {
  const s = makeSession();
  // The bulk-accept path (extension.ts line 2791) uses setDecision only; judgment
  // gates are SKIPPED in bulk (needsConfirmation), never overridden.
  s.setDecision('cand-b', 'accepted');
  assert.deepEqual(s.dispositionFor('cand-b'), { decision: 'accepted', overrode: false });
});

test('dispositionFor: rejected / pending are never overrides', () => {
  const s = makeSession();
  s.setDecision('cand-r', 'rejected');
  assert.deepEqual(s.dispositionFor('cand-r'), { decision: 'rejected', overrode: false });
  // Untouched candidate is pending.
  assert.deepEqual(s.dispositionFor('cand-p'), { decision: 'pending', overrode: false });
});

test('dispositionFor: re-deciding a warned accept to rejected clears the override', () => {
  const s = makeSession();
  s.setAcceptedWithWarning('cand-1');
  assert.equal(s.dispositionFor('cand-1').overrode, true);
  s.setDecision('cand-1', 'rejected'); // setDecision clears the override flag
  assert.deepEqual(s.dispositionFor('cand-1'), { decision: 'rejected', overrode: false });
});

// --- (2) command declaration + menu wiring ------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    menus: { 'view/title': { command: string; when: string }[] };
  };
};

test('crepair.exportRepairReport command is declared under the "C Repair" category', () => {
  const cmd = pkg.contributes.commands.find((c) => c.command === 'crepair.exportRepairReport');
  assert.ok(cmd, 'the exportRepairReport command is declared');
  assert.equal(cmd?.category, 'C Repair');
  assert.equal(cmd?.title, 'Export Repair Report');
});

test('crepair.exportRepairReport is wired into the TreeView view/title', () => {
  const inTitle = pkg.contributes.menus['view/title'].some(
    (m) => m.command === 'crepair.exportRepairReport' && m.when === 'view == crepairResults',
  );
  assert.ok(inTitle, 'the report command appears in the Scan Results view title');
});

test('crepair.report.includeRejectedProposals is declared with default FALSE (lean record)', () => {
  const prop = flatProperties()['crepair.report.includeRejectedProposals'];
  assert.ok(prop, 'the setting is declared');
  assert.equal(prop?.type, 'boolean');
  // Default false: rejected diffs are opt-in reference material — the exported
  // report stays a lean decision record unless the reviewer explicitly opts in.
  assert.equal(prop?.default, false);
});
