// Unit tests for the /health compatibility + pin logic (VSCODE_V1B_DESIGN §7).
// Pure Node, no `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkHealthCompat,
  effectiveModelLabel,
  effectiveProviderLabel,
  effectiveReasoningLabel,
  harnessPinLabel,
  isHarnessInPin,
  parseHealth,
} from '../src/bridge/health';

function goodBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    harness: { id: 'certfix', version: '0.4.1' },
    adapter: { id: 'certfix-inprocess', version: '0.1.0' },
    contract_version: '1',
    capabilities: {
      rule_profile: 'cert-c',
      rules_count: 115,
      gates: ['format', 'compile', 'violation_removal', 'semantic', 'regression'],
      routes: ['api'],
      model: 'deepseek/deepseek-v4-flash-0731',
      provider_order: ['DeepInfra'],
      reasoning_effort: 'xhigh',
    },
    ...overrides,
  };
}

test('isHarnessInPin: 0.4.x is in pin', () => {
  assert.equal(isHarnessInPin('0.4.0'), true);
  assert.equal(isHarnessInPin('0.4.1'), true);
  assert.equal(isHarnessInPin('0.4.99'), true);
  assert.equal(isHarnessInPin('0.4.1-rc1'), true);
  assert.equal(isHarnessInPin(' 0.4.2 '), true);
});

test('isHarnessInPin: other minor/major is out of pin', () => {
  assert.equal(isHarnessInPin('0.3.9'), false);
  assert.equal(isHarnessInPin('0.5.0'), false);
  assert.equal(isHarnessInPin('1.4.0'), false);
  assert.equal(isHarnessInPin('nonsense'), false);
  assert.equal(isHarnessInPin(''), false);
});

test('harnessPinLabel is 0.4.x', () => {
  assert.equal(harnessPinLabel(), '0.4.x');
});

test('parseHealth accepts a well-formed body', () => {
  const h = parseHealth(goodBody());
  assert.ok(h);
  assert.equal(h?.contract_version, '1');
  assert.equal(h?.harness.version, '0.4.1');
  assert.equal(h?.capabilities.rules_count, 115);
});

test('parseHealth rejects malformed bodies', () => {
  assert.equal(parseHealth(null), null);
  assert.equal(parseHealth('ok'), null);
  assert.equal(parseHealth(goodBody({ harness: { id: 'x' } })), null); // missing version
  assert.equal(parseHealth(goodBody({ contract_version: 1 })), null); // wrong type
  assert.equal(
    parseHealth(goodBody({ capabilities: { rule_profile: 'cert-c' } })),
    null,
  ); // incomplete capabilities
});

test('checkHealthCompat: matching contract + pinned harness => ok, in pin', () => {
  const r = checkHealthCompat(goodBody());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.harnessInPin, true);
});

test('checkHealthCompat: harness out of pin => ok but harnessInPin false', () => {
  const r = checkHealthCompat(goodBody({ harness: { id: 'certfix', version: '0.5.0' } }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.harnessInPin, false);
});

test('checkHealthCompat: contract_version mismatch => fatal', () => {
  const r = checkHealthCompat(goodBody({ contract_version: '2' }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /contract_version mismatch/);
});

test('checkHealthCompat: malformed body => fatal', () => {
  const r = checkHealthCompat({ status: 'ok' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /malformed/);
});

// --- D-019 effective model / provider ---------------------------------------

test('parseHealth captures effective model + provider_order when present', () => {
  const h = parseHealth(goodBody());
  assert.ok(h);
  assert.equal(h?.capabilities.model, 'deepseek/deepseek-v4-flash-0731');
  assert.deepEqual(h?.capabilities.provider_order, ['DeepInfra']);
});

test('parseHealth tolerates a bridge omitting the D-019 fields (back-compat)', () => {
  const caps = {
    rule_profile: 'cert-c',
    rules_count: 115,
    gates: ['format'],
    routes: ['api'],
  };
  const h = parseHealth(goodBody({ capabilities: caps }));
  assert.ok(h, 'older bridge without model/provider still parses');
  assert.equal(h?.capabilities.model, undefined);
  assert.equal(h?.capabilities.provider_order, undefined);
});

test('effectiveProviderLabel: pinned order joins with an arrow', () => {
  const h = parseHealth(goodBody());
  assert.equal(effectiveProviderLabel(h!.capabilities), 'DeepInfra');
  const two = parseHealth(
    goodBody({
      capabilities: {
        rule_profile: 'cert-c',
        rules_count: 1,
        gates: ['x'],
        routes: ['api'],
        model: 'm',
        provider_order: ['A', 'B'],
      },
    }),
  );
  assert.equal(effectiveProviderLabel(two!.capabilities), 'A → B');
});

test('effectiveProviderLabel: empty / missing order => automatic routing', () => {
  const empty = parseHealth(
    goodBody({
      capabilities: {
        rule_profile: 'cert-c',
        rules_count: 1,
        gates: ['x'],
        routes: ['api'],
        model: 'm',
        provider_order: [],
      },
    }),
  );
  assert.equal(effectiveProviderLabel(empty!.capabilities), 'OpenRouter automatic routing');
  assert.equal(effectiveProviderLabel(undefined), 'OpenRouter automatic routing');
});

test('effectiveModelLabel: falls back to "unknown" when absent', () => {
  const h = parseHealth(goodBody());
  assert.equal(effectiveModelLabel(h!.capabilities), 'deepseek/deepseek-v4-flash-0731');
  assert.equal(effectiveModelLabel(undefined), 'unknown');
});

// --- D-028 effective reasoning effort ---------------------------------------

test('parseHealth captures reasoning_effort when present', () => {
  const h = parseHealth(goodBody());
  assert.equal(h?.capabilities.reasoning_effort, 'xhigh');
});

test('parseHealth tolerates a bridge omitting reasoning_effort (back-compat)', () => {
  const caps = {
    rule_profile: 'cert-c',
    rules_count: 115,
    gates: ['format'],
    routes: ['api'],
    model: 'm',
    provider_order: ['DeepInfra'],
  };
  const h = parseHealth(goodBody({ capabilities: caps }));
  assert.ok(h, 'older bridge without reasoning_effort still parses');
  assert.equal(h?.capabilities.reasoning_effort, undefined);
});

test('effectiveReasoningLabel: a level renders verbatim; off/default/missing map', () => {
  const h = parseHealth(goodBody());
  assert.equal(effectiveReasoningLabel(h!.capabilities), 'xhigh');
  assert.equal(effectiveReasoningLabel({ ...h!.capabilities, reasoning_effort: 'off' }), 'disabled');
  assert.equal(
    effectiveReasoningLabel({ ...h!.capabilities, reasoning_effort: 'default' }),
    'config default',
  );
  // Missing => null so the tooltip omits the reasoning line entirely.
  assert.equal(effectiveReasoningLabel({ ...h!.capabilities, reasoning_effort: undefined }), null);
  assert.equal(effectiveReasoningLabel(undefined), null);
});
