// Unit tests for the external-route consent wording (D-016). Pure Node, no
// `vscode` module. Load-bearing properties (sample15):
//   - the wording follows modelMode / providerPolicy / providerOrder;
//   - the Zero-Data-Retention line appears ONLY when WE enforce ZDR (custom +
//     private-cheap + empty order), never as an unsubstantiated claim;
//   - the tone is an informational confirmation, never a warning.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  externalRouteText,
  resolveProviderDisplay,
  EXTERNAL_ROUTE_TITLE,
  type ExternalRouteInputs,
} from '../src/ui/externalRouteNotice';
import { DEFAULT_OVERRIDES } from '../src/bridge/overrideEnv';

const FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

function inputs(overrides: Partial<ExternalRouteInputs> = {}): ExternalRouteInputs {
  return {
    mode: 'custom',
    model: DEFAULT_OVERRIDES.model,
    freeModel: FREE_MODEL,
    providerOrder: [],
    providerPolicy: 'private-cheap',
    ...overrides,
  };
}

const ZDR_LINE =
  'Routing is restricted to endpoints marked Zero Data Retention on OpenRouter.';
const GENERIC_DATA_LINE =
  'Data handling depends on the provider — see its data policy on OpenRouter.';

// --- provider display (mode-aware effective routing) ------------------------

test('custom + private-cheap + empty order -> ZDR provider phrasing, ZDR enforced', () => {
  const r = resolveProviderDisplay(inputs({ mode: 'custom', providerOrder: [], providerPolicy: 'private-cheap' }));
  assert.equal(r.providerText, 'a Zero-Data-Retention provider (auto-selected)');
  assert.equal(r.isZdrEnforced, true);
});

test('custom + balanced + empty order -> automatic provider, NOT ZDR', () => {
  const r = resolveProviderDisplay(inputs({ mode: 'custom', providerOrder: [], providerPolicy: 'balanced' }));
  assert.equal(r.providerText, 'an automatically selected provider');
  assert.equal(r.isZdrEnforced, false);
});

test('custom + a provider pin -> the pin name(s), NOT ZDR (pin overrides policy)', () => {
  const one = resolveProviderDisplay(
    inputs({ mode: 'custom', providerOrder: ['DeepInfra'], providerPolicy: 'private-cheap' }),
  );
  assert.equal(one.providerText, 'DeepInfra');
  assert.equal(one.isZdrEnforced, false);

  const many = resolveProviderDisplay(
    inputs({ mode: 'custom', providerOrder: ['Together', 'DeepInfra'], providerPolicy: 'private-cheap' }),
  );
  assert.equal(many.providerText, 'Together → DeepInfra');
  assert.equal(many.isZdrEnforced, false);
});

test('provider pin is trimmed / blank-filtered before display', () => {
  const r = resolveProviderDisplay(
    inputs({ mode: 'custom', providerOrder: [' DeepInfra ', '', '  '], providerPolicy: 'private-cheap' }),
  );
  assert.equal(r.providerText, 'DeepInfra');
  assert.equal(r.isZdrEnforced, false);
});

test('free mode -> automatic routing, never ZDR (free path forces auto routing)', () => {
  // Even with a private-cheap policy and a pin in settings, free mode ignores them.
  const r = resolveProviderDisplay(
    inputs({ mode: 'free', providerOrder: ['DeepInfra'], providerPolicy: 'private-cheap' }),
  );
  assert.equal(r.providerText, 'an automatically selected provider');
  assert.equal(r.isZdrEnforced, false);
});

test('default mode -> the bundled provider pin, never ZDR', () => {
  const r = resolveProviderDisplay(
    inputs({ mode: 'default', providerOrder: [], providerPolicy: 'private-cheap' }),
  );
  assert.equal(r.providerText, DEFAULT_OVERRIDES.providerOrder.join(' → '));
  assert.equal(r.isZdrEnforced, false);
});

// --- full notice text --------------------------------------------------------

test('title is the question-form confirmation constant', () => {
  assert.equal(externalRouteText(inputs()).title, EXTERNAL_ROUTE_TITLE);
  assert.equal(EXTERNAL_ROUTE_TITLE, 'C Repair: send code to provider?');
});

test('route line names OpenRouter, the provider, and the effective model', () => {
  const t = externalRouteText(inputs({ mode: 'custom', model: DEFAULT_OVERRIDES.model, providerOrder: ['DeepInfra'] }));
  assert.equal(
    t.routeLine,
    `This scan sends the file to OpenRouter → DeepInfra (model ${DEFAULT_OVERRIDES.model}).`,
  );
});

test('route line uses the free model id in free mode', () => {
  const t = externalRouteText(inputs({ mode: 'free' }));
  assert.ok(t.routeLine.includes(FREE_MODEL), 'shows the free model id');
  assert.ok(
    t.routeLine.includes('an automatically selected provider'),
    'shows auto routing for free',
  );
});

test('route line uses the bundled default model id in default mode (ignores crepair.model)', () => {
  const t = externalRouteText(inputs({ mode: 'default', model: 'anthropic/claude-3.5-sonnet' }));
  assert.ok(t.routeLine.includes(DEFAULT_OVERRIDES.model), 'shows the bundled default model');
  assert.ok(!t.routeLine.includes('claude-3.5-sonnet'), 'custom model is ignored in default mode');
});

test('data line: ZDR statement ONLY when we enforce ZDR (custom + private-cheap + empty order)', () => {
  const enforced = externalRouteText(
    inputs({ mode: 'custom', providerOrder: [], providerPolicy: 'private-cheap' }),
  );
  assert.equal(enforced.dataLine, ZDR_LINE);
});

test('data line: generic policy line whenever ZDR is NOT enforced', () => {
  // balanced policy
  assert.equal(
    externalRouteText(inputs({ mode: 'custom', providerOrder: [], providerPolicy: 'balanced' })).dataLine,
    GENERIC_DATA_LINE,
  );
  // custom with an explicit pin (pin wins over policy)
  assert.equal(
    externalRouteText(inputs({ mode: 'custom', providerOrder: ['DeepInfra'], providerPolicy: 'private-cheap' })).dataLine,
    GENERIC_DATA_LINE,
  );
  // free mode
  assert.equal(externalRouteText(inputs({ mode: 'free' })).dataLine, GENERIC_DATA_LINE);
  // default mode
  assert.equal(externalRouteText(inputs({ mode: 'default' })).dataLine, GENERIC_DATA_LINE);
});

test('the ZDR line never appears when we do not enforce ZDR (no unsubstantiated claim)', () => {
  const notEnforced: ExternalRouteInputs[] = [
    inputs({ mode: 'custom', providerOrder: [], providerPolicy: 'balanced' }),
    inputs({ mode: 'custom', providerOrder: ['DeepInfra'], providerPolicy: 'private-cheap' }),
    inputs({ mode: 'free', providerPolicy: 'private-cheap' }),
    inputs({ mode: 'default', providerPolicy: 'private-cheap' }),
  ];
  for (const inp of notEnforced) {
    const t = externalRouteText(inp);
    assert.ok(
      !/zero.?data.?retention/i.test(t.dataLine),
      `ZDR must not appear for ${JSON.stringify(inp)}`,
    );
  }
});

// --- tone guard: informational, not a warning --------------------------------

test('wording carries no warning-tone vocabulary (sample15: it is a consent confirmation)', () => {
  // Cover every branch so the guard sees all produced strings.
  const cases: ExternalRouteInputs[] = [
    inputs({ mode: 'custom', providerOrder: [], providerPolicy: 'private-cheap' }),
    inputs({ mode: 'custom', providerOrder: [], providerPolicy: 'balanced' }),
    inputs({ mode: 'custom', providerOrder: ['DeepInfra'] }),
    inputs({ mode: 'free' }),
    inputs({ mode: 'default' }),
  ];
  const banned = /\b(warning|warn|danger|caution|alert|beware|risk|unsafe)\b/i;
  for (const inp of cases) {
    const t = externalRouteText(inp);
    for (const line of [t.title, t.routeLine, t.dataLine]) {
      assert.ok(!banned.test(line), `warning-tone word in: "${line}"`);
    }
  }
});
