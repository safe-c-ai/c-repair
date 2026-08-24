// Unit tests for the pure Context Review decision / messaging helpers (V2b,
// design §3). Pure Node, no `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideReview,
  checkResultMessage,
  contextStateFor,
  contextStateLabel,
  contextIncompleteLabel,
  scanIncompletenessWarning,
} from '../src/session/contextReview';

// --- decideReview -----------------------------------------------------------

test('when-needed with items opens the Review', () => {
  assert.equal(decideReview('when-needed', 2), 'review');
});

test('when-needed with zero items goes direct (self-contained file)', () => {
  assert.equal(decideReview('when-needed', 0), 'direct');
});

test('always with items opens the Review; with zero items goes direct', () => {
  assert.equal(decideReview('always', 2), 'review');
  // An empty Review is meaningless, so `always` still skips it (see report).
  assert.equal(decideReview('always', 0), 'direct');
});

test('never always skips the Review, even with items', () => {
  assert.equal(decideReview('never', 2), 'skip');
  assert.equal(decideReview('never', 0), 'skip');
});

// --- checkResultMessage -----------------------------------------------------

test('a compiling context is non-blocking and says so', () => {
  const msg = checkResultMessage({ compiles: true, missing_symbols: [] });
  assert.equal(msg.blocking, false);
  assert.match(msg.text, /compiles/);
});

test('a still-missing context is blocking and names the symbols', () => {
  const msg = checkResultMessage({ compiles: false, missing_symbols: ['read_sensor', 'threshold'] });
  assert.equal(msg.blocking, true);
  assert.match(msg.text, /read_sensor, threshold/);
  assert.match(msg.text, /skipped/);
});

test('a non-compiling context with no named symbols still blocks', () => {
  const msg = checkResultMessage({ compiles: false, missing_symbols: [] });
  assert.equal(msg.blocking, true);
});

// --- contextStateFor / contextStateLabel ------------------------------------

test('no items -> none', () => {
  assert.equal(contextStateFor([]), 'none');
  assert.equal(contextStateLabel('none', 0), 'context: none');
});

test('all confirmed -> confirmed', () => {
  assert.equal(contextStateFor([{ confirmed: true }, { confirmed: true }]), 'confirmed');
  assert.equal(contextStateLabel('confirmed', 2), 'context: 2 items (confirmed)');
  assert.equal(contextStateLabel('confirmed', 1), 'context: 1 item (confirmed)');
});

test('any unconfirmed item -> assumption-dependent', () => {
  assert.equal(
    contextStateFor([{ confirmed: true }, { confirmed: false }]),
    'assumption-dependent',
  );
  assert.equal(
    contextStateLabel('assumption-dependent', 2),
    'context: 2 items (assumption-dependent)',
  );
});

// --- context completeness (Codex review round) --------------------------------

test('no check ran (undefined) or complete (0) -> no incompleteness copy', () => {
  assert.equal(contextIncompleteLabel(undefined), undefined);
  assert.equal(contextIncompleteLabel(0), undefined);
  assert.equal(scanIncompletenessWarning(undefined), undefined);
  assert.equal(scanIncompletenessWarning(0), undefined);
});

test('incomplete context -> tree label names the residual count', () => {
  const label = contextIncompleteLabel(7);
  assert.ok(label);
  assert.match(label!, /context incomplete \(7 symbols still missing\)/);
  assert.match(label!, /findings may be incomplete/);
  // Singular form.
  assert.match(contextIncompleteLabel(1)!, /1 symbol still missing/);
});

test('incomplete context -> scan warning says 0 violations is no guarantee', () => {
  const warning = scanIncompletenessWarning(3);
  assert.ok(warning);
  assert.match(warning!, /Context incomplete \(3 symbols still missing\)/);
  assert.match(warning!, /detection may have missed violations/);
  assert.match(warning!, /0 violations is not a safety guarantee/);
});

test('completeness copy is a distinct axis from assumption-dependent wording', () => {
  // The §2 assumption-dependent phrasing (confirmed=false provenance) must not
  // be conflated with completeness (still_missing > 0): different words.
  assert.doesNotMatch(contextIncompleteLabel(2)!, /assumption/);
  assert.doesNotMatch(scanIncompletenessWarning(2)!, /assumption/);
});
