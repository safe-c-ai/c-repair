// Unit tests for the config-change / startup notice classifiers (D-019 / D-031 /
// D-038, sample9 UX defect). Pure Node, no `vscode` module. The load-bearing
// properties:
//   - a custom-only setting (model / providerOrder / allowFallbacks) changed while
//     the mode is NOT custom => `switch-to-custom` (the edit is silently ignored, so
//     offer to flip the mode + restart) rather than a useless plain restart prompt;
//   - the same setting changed while the mode IS custom => plain `restart`;
//   - a `modelMode` / `freeModel` / `reasoningEffort` / `configPath` change => plain
//     `restart` (those settings are always in effect);
//   - at STARTUP, a pre-existing mismatch (explicit model and/or non-default
//     providerOrder under a non-custom mode) is detected so it can be flagged once
//     per session — `custom` mode or default values produce no notice;
//   - the notice wording reads "what is running -> when the value takes effect" and
//     the buttons state outcomes (Use … / Discard … / Not now), with the internal
//     `default` mode rendered by its display label (D-038);
//   - the Discard action clears exactly crepair.model + crepair.providerOrder.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideConfigChangeNotice,
  decideStartupConfigNotice,
  providerOrderIsDefault,
  unusedSettingsParts,
  unusedSettingsMessage,
  hasUnusedParts,
  useCustomActionLabel,
  clearUnusedSettingsUpdates,
  DISCARD_ACTION,
  NOT_NOW_ACTION,
  type ChangedSettings,
} from '../src/session/configChangeNotice';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_MODE_LABEL_LOWER,
  type ModelMode,
} from '../src/bridge/overrideEnv';

const LUNA = 'openai/gpt-5.6-luna';
const FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

/** A ChangedSettings with everything false; override the keys under test. */
function changed(overrides: Partial<ChangedSettings> = {}): ChangedSettings {
  return {
    model: false,
    providerOrder: false,
    allowFallbacks: false,
    providerPolicy: false,
    modelMode: false,
    freeModel: false,
    reasoningEffort: false,
    configPath: false,
    ...overrides,
  };
}

// --- decideConfigChangeNotice: switch-to-custom (the sample9 defect) ---------

test('model changed in default mode => switch-to-custom (ignored edit)', () => {
  const n = decideConfigChangeNotice(changed({ model: true }), 'default');
  assert.deepEqual(n, { kind: 'switch-to-custom', mode: 'default' });
});

test('providerOrder changed in free mode => switch-to-custom', () => {
  const n = decideConfigChangeNotice(changed({ providerOrder: true }), 'free');
  assert.deepEqual(n, { kind: 'switch-to-custom', mode: 'free' });
});

test('allowFallbacks changed in default mode => switch-to-custom', () => {
  const n = decideConfigChangeNotice(changed({ allowFallbacks: true }), 'default');
  assert.deepEqual(n, { kind: 'switch-to-custom', mode: 'default' });
});

test('switch-to-custom wins even when a restart-relevant setting also changed', () => {
  // Editing crepair.model AND crepair.reasoningEffort in one non-custom edit: the
  // ignored model edit is the one worth flagging, so the switch prompt takes priority.
  const n = decideConfigChangeNotice(
    changed({ model: true, reasoningEffort: true }),
    'default',
  );
  assert.deepEqual(n, { kind: 'switch-to-custom', mode: 'default' });
});

test('providerPolicy changed in default mode => switch-to-custom (custom-only setting)', () => {
  const n = decideConfigChangeNotice(changed({ providerPolicy: true }), 'default');
  assert.deepEqual(n, { kind: 'switch-to-custom', mode: 'default' });
});

test('providerPolicy changed in free mode => switch-to-custom', () => {
  const n = decideConfigChangeNotice(changed({ providerPolicy: true }), 'free');
  assert.deepEqual(n, { kind: 'switch-to-custom', mode: 'free' });
});

// --- decideConfigChangeNotice: restart ---------------------------------------

test('model changed in custom mode => plain restart (setting is in effect)', () => {
  const n = decideConfigChangeNotice(changed({ model: true }), 'custom');
  assert.deepEqual(n, { kind: 'restart' });
});

test('providerOrder changed in custom mode => plain restart', () => {
  const n = decideConfigChangeNotice(changed({ providerOrder: true }), 'custom');
  assert.deepEqual(n, { kind: 'restart' });
});

test('providerPolicy changed in custom mode => plain restart (setting is in effect)', () => {
  const n = decideConfigChangeNotice(changed({ providerPolicy: true }), 'custom');
  assert.deepEqual(n, { kind: 'restart' });
});

test('modelMode changed => plain restart in every mode', () => {
  for (const mode of ['default', 'free', 'custom'] as ModelMode[]) {
    assert.deepEqual(
      decideConfigChangeNotice(changed({ modelMode: true }), mode),
      { kind: 'restart' },
      `mode=${mode}`,
    );
  }
});

test('reasoningEffort changed in default mode => plain restart (not a custom-only setting)', () => {
  const n = decideConfigChangeNotice(changed({ reasoningEffort: true }), 'default');
  assert.deepEqual(n, { kind: 'restart' });
});

test('freeModel changed in free mode => plain restart', () => {
  const n = decideConfigChangeNotice(changed({ freeModel: true }), 'free');
  assert.deepEqual(n, { kind: 'restart' });
});

test('bridge.configPath changed => plain restart', () => {
  const n = decideConfigChangeNotice(changed({ configPath: true }), 'custom');
  assert.deepEqual(n, { kind: 'restart' });
});

test('no relevant setting changed => none', () => {
  assert.deepEqual(decideConfigChangeNotice(changed(), 'default'), { kind: 'none' });
});

// --- providerOrderIsDefault ---------------------------------------------------

test('providerOrderIsDefault: the verified default (with normalization) is default', () => {
  assert.equal(providerOrderIsDefault(['DeepInfra']), true);
  assert.equal(providerOrderIsDefault([' DeepInfra ', '']), true);
});

test('providerOrderIsDefault: empty array (automatic routing) and other pins are not', () => {
  assert.equal(providerOrderIsDefault([]), false);
  assert.equal(providerOrderIsDefault(['azure/eu']), false);
  assert.equal(providerOrderIsDefault(['DeepInfra', 'azure/eu']), false);
});

// --- decideStartupConfigNotice (pre-existing mismatch at activation) ---------

test('startup: explicit model under default mode => notice with the model value', () => {
  const n = decideStartupConfigNotice(
    { model: LUNA, providerOrder: DEFAULT_OVERRIDES.providerOrder },
    'default',
  );
  assert.equal(n.kind, 'unused-custom-settings');
  if (n.kind === 'unused-custom-settings') {
    assert.equal(n.mode, 'default');
    assert.equal(n.parts.modelValue, LUNA);
    assert.equal(n.parts.providerOrder, false);
  }
});

test('startup: non-default providerOrder only (free mode) => notice without a model value', () => {
  const n = decideStartupConfigNotice(
    { model: DEFAULT_OVERRIDES.model, providerOrder: ['azure/eu'] },
    'free',
  );
  assert.equal(n.kind, 'unused-custom-settings');
  if (n.kind === 'unused-custom-settings') {
    assert.equal(n.parts.modelValue, undefined);
    assert.equal(n.parts.providerOrder, true);
  }
});

test('startup: both mismatched => both parts flagged', () => {
  const n = decideStartupConfigNotice({ model: LUNA, providerOrder: [] }, 'default');
  assert.equal(n.kind, 'unused-custom-settings');
  if (n.kind === 'unused-custom-settings') {
    assert.equal(n.parts.modelValue, LUNA);
    assert.equal(n.parts.providerOrder, true);
  }
});

test('startup: custom mode => none even with both set (settings are in effect)', () => {
  const n = decideStartupConfigNotice({ model: LUNA, providerOrder: [] }, 'custom');
  assert.deepEqual(n, { kind: 'none' });
});

test('startup: defaults / blank model => none (nothing is ignored)', () => {
  assert.deepEqual(
    decideStartupConfigNotice(
      { model: DEFAULT_OVERRIDES.model, providerOrder: DEFAULT_OVERRIDES.providerOrder },
      'default',
    ),
    { kind: 'none' },
  );
  assert.deepEqual(
    decideStartupConfigNotice({ model: '   ', providerOrder: ['DeepInfra'] }, 'free'),
    { kind: 'none' },
  );
});

// --- unusedSettingsParts / hasUnusedParts ------------------------------------

test('unusedSettingsParts: resolves explicit values against the verified defaults', () => {
  const parts = unusedSettingsParts({
    model: ` ${LUNA} `,
    providerOrder: ['azure/eu'],
    allowFallbacks: true,
  });
  assert.deepEqual(parts, {
    modelValue: LUNA,
    providerOrder: true,
    allowFallbacks: true,
    providerPolicy: false,
  });
  assert.equal(hasUnusedParts(parts), true);
});

test('unusedSettingsParts: all-default values yield no parts', () => {
  const parts = unusedSettingsParts({
    model: DEFAULT_OVERRIDES.model,
    providerOrder: DEFAULT_OVERRIDES.providerOrder,
    allowFallbacks: DEFAULT_OVERRIDES.allowFallbacks,
  });
  assert.deepEqual(parts, {
    modelValue: undefined,
    providerOrder: false,
    allowFallbacks: false,
    providerPolicy: false,
  });
  assert.equal(hasUnusedParts(parts), false);
});

test('unusedSettingsParts: allowFallbacks omitted => never flagged (startup scope)', () => {
  const parts = unusedSettingsParts({ model: LUNA, providerOrder: ['DeepInfra'] });
  assert.equal(parts.allowFallbacks, false);
});

test('unusedSettingsParts: providerPolicy differing from default is flagged', () => {
  const parts = unusedSettingsParts({
    model: DEFAULT_OVERRIDES.model,
    providerOrder: DEFAULT_OVERRIDES.providerOrder,
    providerPolicy: 'balanced',
  });
  assert.equal(parts.providerPolicy, true);
  assert.equal(hasUnusedParts(parts), true);
});

test('unusedSettingsParts: providerPolicy at its default / omitted => never flagged', () => {
  assert.equal(
    unusedSettingsParts({
      model: DEFAULT_OVERRIDES.model,
      providerOrder: DEFAULT_OVERRIDES.providerOrder,
      providerPolicy: DEFAULT_OVERRIDES.providerPolicy,
    }).providerPolicy,
    false,
  );
  // Omitted (startup scope) => never flagged.
  assert.equal(
    unusedSettingsParts({ model: LUNA, providerOrder: ['DeepInfra'] }).providerPolicy,
    false,
  );
});

// --- wording: what is running -> when the value takes effect (D-038) ---------

test('message (default mode): names the preset model, then the ignored Model setting', () => {
  const msg = unusedSettingsMessage('default', DEFAULT_OVERRIDES.model, {
    modelValue: LUNA,
    providerOrder: false,
    allowFallbacks: false,
    providerPolicy: false,
  });
  assert.equal(
    msg,
    `C Repair is running on the ${DEFAULT_MODE_LABEL_LOWER} model ` +
      `(${DEFAULT_OVERRIDES.model}). Your Model setting "${LUNA}" takes effect ` +
      `only when Model Mode is set to "custom".`,
  );
});

test('message (free mode): the lead names the free model instead', () => {
  const msg = unusedSettingsMessage('free', FREE_MODEL, {
    modelValue: LUNA,
    providerOrder: false,
    allowFallbacks: false,
    providerPolicy: false,
  });
  assert.ok(msg.startsWith(`C Repair is running on the free model (${FREE_MODEL}).`), msg);
});

test('message: provider-only mismatch names the Provider Order setting', () => {
  const msg = unusedSettingsMessage('default', DEFAULT_OVERRIDES.model, {
    modelValue: undefined,
    providerOrder: true,
    allowFallbacks: false,
    providerPolicy: false,
  });
  assert.ok(msg.includes('Your Provider Order setting takes effect'), msg);
});

test('message: multiple mismatches list both with plural agreement', () => {
  const msg = unusedSettingsMessage('default', DEFAULT_OVERRIDES.model, {
    modelValue: LUNA,
    providerOrder: true,
    allowFallbacks: false,
    providerPolicy: false,
  });
  assert.ok(
    msg.includes(`Your Model setting "${LUNA}" and Provider Order setting take effect`),
    msg,
  );
});

test('message: providerPolicy-only mismatch names the Provider Policy setting', () => {
  const msg = unusedSettingsMessage('default', DEFAULT_OVERRIDES.model, {
    modelValue: undefined,
    providerOrder: false,
    allowFallbacks: false,
    providerPolicy: true,
  });
  assert.ok(msg.includes('Your Provider Policy setting takes effect'), msg);
});

// --- buttons state outcomes ---------------------------------------------------

test('useCustomActionLabel: names the model value when present', () => {
  assert.equal(useCustomActionLabel(LUNA), `Use "${LUNA}" (switch to custom)`);
  assert.equal(useCustomActionLabel(undefined), 'Use this setting (switch to custom)');
});

test('discard action keeps the preset naming; the three buttons are distinct', () => {
  assert.equal(DISCARD_ACTION, `Discard it (keep ${DEFAULT_MODE_LABEL_LOWER})`);
  const labels = [useCustomActionLabel(LUNA), DISCARD_ACTION, NOT_NOW_ACTION];
  assert.equal(new Set(labels).size, 3);
  for (const l of labels) assert.ok(l.length > 0);
});

// --- clear (Discard) writes ---------------------------------------------------

test('clearUnusedSettingsUpdates resets exactly crepair.model + crepair.providerOrder', () => {
  assert.deepEqual(clearUnusedSettingsUpdates(), [
    { key: 'crepair.model', value: undefined },
    { key: 'crepair.providerOrder', value: undefined },
  ]);
});
