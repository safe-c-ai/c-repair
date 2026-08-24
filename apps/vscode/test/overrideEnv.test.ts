// Unit tests for the pure settings -> CREPAIR_* env mapping (D-019). Pure Node,
// no `vscode` module. The load-bearing property: a DEFAULT configuration emits
// NO override env, so the bridge uses its bundled config verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOverrideEnv,
  buildFreeModelEnv,
  buildModeOverrideEnv,
  hasExplicitModel,
  decideFreeSwitch,
  normalizeModelMode,
  normalizeProviderPolicy,
  DEFAULT_OVERRIDES,
  DEFAULT_MODEL_MODE,
  DEFAULT_PROVIDER_POLICY,
  ENV_ALLOW_FALLBACKS,
  ENV_CONFIG_PATH,
  ENV_MODEL_ID,
  ENV_PROVIDER_ORDER,
  ENV_PROVIDER_POLICY,
  ENV_REASONING_EFFORT,
  type OverrideSettings,
  type FreeSwitchInputs,
} from '../src/bridge/overrideEnv';

const FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

function settings(overrides: Partial<OverrideSettings> = {}): OverrideSettings {
  return { ...DEFAULT_OVERRIDES, providerOrder: [...DEFAULT_OVERRIDES.providerOrder], ...overrides };
}

test('default settings emit NO override env (bit-identical to bundled config)', () => {
  assert.deepEqual(buildOverrideEnv(settings()), {});
});

test('model override emits CREPAIR_MODEL_ID only', () => {
  const env = buildOverrideEnv(settings({ model: 'anthropic/claude-3.5-sonnet' }));
  assert.deepEqual(env, { [ENV_MODEL_ID]: 'anthropic/claude-3.5-sonnet' });
});

test('model equal to default (after trim) emits nothing', () => {
  assert.deepEqual(buildOverrideEnv(settings({ model: '  deepseek/deepseek-v4-flash-0731  ' })), {});
});

test('non-default provider order emits a comma-joined list', () => {
  const env = buildOverrideEnv(settings({ providerOrder: ['Fireworks', 'Together'] }));
  assert.deepEqual(env, { [ENV_PROVIDER_ORDER]: 'Fireworks,Together' });
});

test('empty provider order emits CREPAIR_PROVIDER_ORDER="" + the provider policy (default: private-cheap)', () => {
  const env = buildOverrideEnv(settings({ providerOrder: [] }));
  assert.deepEqual(env, {
    [ENV_PROVIDER_ORDER]: '',
    [ENV_PROVIDER_POLICY]: 'private-cheap',
  });
});

test('all-blank provider order normalizes to empty => "" + the provider policy', () => {
  const env = buildOverrideEnv(settings({ providerOrder: ['  ', ''] }));
  assert.deepEqual(env, {
    [ENV_PROVIDER_ORDER]: '',
    [ENV_PROVIDER_POLICY]: 'private-cheap',
  });
});

test('provider order equal to default (after trim) emits nothing', () => {
  assert.deepEqual(buildOverrideEnv(settings({ providerOrder: [' DeepInfra '] })), {});
});

test('allowFallbacks true emits CREPAIR_ALLOW_FALLBACKS=true', () => {
  assert.deepEqual(buildOverrideEnv(settings({ allowFallbacks: true })), {
    [ENV_ALLOW_FALLBACKS]: 'true',
  });
});

test('allowFallbacks false (the default) emits nothing', () => {
  assert.deepEqual(buildOverrideEnv(settings({ allowFallbacks: false })), {});
});

test('configPath emits CREPAIR_CONFIG_PATH; empty emits nothing', () => {
  assert.deepEqual(buildOverrideEnv(settings({ configPath: '/etc/certfix.yaml' })), {
    [ENV_CONFIG_PATH]: '/etc/certfix.yaml',
  });
  assert.deepEqual(buildOverrideEnv(settings({ configPath: '   ' })), {});
});

test('reasoningEffort equal to default (xhigh) emits nothing', () => {
  assert.deepEqual(buildOverrideEnv(settings({ reasoningEffort: 'xhigh' })), {});
  // Trimmed to the default still emits nothing.
  assert.deepEqual(buildOverrideEnv(settings({ reasoningEffort: '  xhigh ' })), {});
});

test('non-default reasoningEffort emits CREPAIR_REASONING_EFFORT', () => {
  assert.deepEqual(buildOverrideEnv(settings({ reasoningEffort: 'low' })), {
    [ENV_REASONING_EFFORT]: 'low',
  });
  assert.deepEqual(buildOverrideEnv(settings({ reasoningEffort: 'off' })), {
    [ENV_REASONING_EFFORT]: 'off',
  });
});

test('blank reasoningEffort emits nothing (falls back to bundled default)', () => {
  assert.deepEqual(buildOverrideEnv(settings({ reasoningEffort: '   ' })), {});
});

// --- providerPolicy (D-019 follow-up): emitted only when the order is empty -----
// The 4 branches asked for: custom+empty+private-cheap / custom+empty+balanced /
// custom+order-set (policy suppressed) / non-custom (policy never emitted).

test('custom + empty order + private-cheap => emits the policy alongside the empty pin', () => {
  const env = buildOverrideEnv(settings({ providerOrder: [], providerPolicy: 'private-cheap' }));
  assert.deepEqual(env, {
    [ENV_PROVIDER_ORDER]: '',
    [ENV_PROVIDER_POLICY]: 'private-cheap',
  });
});

test('custom + empty order + balanced => emits CREPAIR_PROVIDER_POLICY=balanced', () => {
  const env = buildOverrideEnv(settings({ providerOrder: [], providerPolicy: 'balanced' }));
  assert.deepEqual(env, {
    [ENV_PROVIDER_ORDER]: '',
    [ENV_PROVIDER_POLICY]: 'balanced',
  });
});

test('custom + explicit provider order => policy is NOT emitted (the pin wins)', () => {
  const env = buildOverrideEnv(
    settings({ providerOrder: ['Fireworks', 'Together'], providerPolicy: 'private-cheap' }),
  );
  // The exact-match deepEqual asserts CREPAIR_PROVIDER_POLICY is absent.
  assert.deepEqual(env, { [ENV_PROVIDER_ORDER]: 'Fireworks,Together' });
});

test('custom + default (DeepInfra) order => policy is NOT emitted (pin is present)', () => {
  // The verified default pin is a non-empty order, so no policy is forwarded and,
  // being the default, the order itself is not emitted either => a clean {}.
  assert.deepEqual(buildOverrideEnv(settings({ providerPolicy: 'balanced' })), {});
});

test('non-custom mode never emits the provider policy (mode owns the construction)', () => {
  // default mode: the model/provider settings (incl. providerPolicy) are ignored.
  assert.deepEqual(
    buildModeOverrideEnv('default', settings({ providerOrder: [], providerPolicy: 'balanced' }), FREE_MODEL),
    {},
  );
  // free mode: the free env pins the model + empty order, but NOT the policy.
  assert.deepEqual(
    buildModeOverrideEnv('free', settings({ providerOrder: [], providerPolicy: 'balanced' }), FREE_MODEL),
    { [ENV_MODEL_ID]: FREE_MODEL, [ENV_PROVIDER_ORDER]: '' },
  );
});

test('custom mode forwards the provider policy (empty order) exactly like buildOverrideEnv', () => {
  const s = settings({ providerOrder: [], providerPolicy: 'balanced' });
  assert.deepEqual(buildModeOverrideEnv('custom', s, FREE_MODEL), buildOverrideEnv(s));
  assert.deepEqual(buildModeOverrideEnv('custom', s, FREE_MODEL), {
    [ENV_PROVIDER_ORDER]: '',
    [ENV_PROVIDER_POLICY]: 'balanced',
  });
});

// --- normalizeProviderPolicy ------------------------------------------------

test('normalizeProviderPolicy passes valid values through', () => {
  assert.equal(normalizeProviderPolicy('private-cheap'), 'private-cheap');
  assert.equal(normalizeProviderPolicy('balanced'), 'balanced');
});

test('normalizeProviderPolicy defaults unknown / undefined to private-cheap', () => {
  assert.equal(normalizeProviderPolicy(undefined), DEFAULT_PROVIDER_POLICY);
  assert.equal(normalizeProviderPolicy(''), DEFAULT_PROVIDER_POLICY);
  assert.equal(normalizeProviderPolicy('bogus'), DEFAULT_PROVIDER_POLICY);
  assert.equal(DEFAULT_PROVIDER_POLICY, 'private-cheap');
});

test('a full custom combination emits every relevant var', () => {
  const env = buildOverrideEnv(
    settings({
      model: 'vendor/m',
      providerOrder: ['P1', 'P2'],
      allowFallbacks: true,
      configPath: '/tmp/c.yaml',
      reasoningEffort: 'medium',
    }),
  );
  assert.deepEqual(env, {
    [ENV_MODEL_ID]: 'vendor/m',
    [ENV_PROVIDER_ORDER]: 'P1,P2',
    [ENV_ALLOW_FALLBACKS]: 'true',
    [ENV_CONFIG_PATH]: '/tmp/c.yaml',
    [ENV_REASONING_EFFORT]: 'medium',
  });
});

// --- buildFreeModelEnv (B): free model pin + automatic routing --------------

test('buildFreeModelEnv pins the model and removes the provider pin (auto routing)', () => {
  assert.deepEqual(buildFreeModelEnv('nvidia/nemotron-3-super-120b-a12b:free'), {
    [ENV_MODEL_ID]: 'nvidia/nemotron-3-super-120b-a12b:free',
    [ENV_PROVIDER_ORDER]: '', // DeepInfra pin cannot serve :free — must auto-route
  });
});

test('buildFreeModelEnv trims the model id', () => {
  assert.deepEqual(buildFreeModelEnv('  vendor/free:free  '), {
    [ENV_MODEL_ID]: 'vendor/free:free',
    [ENV_PROVIDER_ORDER]: '',
  });
});

test('the free env, applied over a config override, wins on model + provider', () => {
  // Simulate the BridgeManager layering: config override first, free env on top.
  const base = buildOverrideEnv(settings({ model: 'vendor/m', providerOrder: ['DeepInfra'] }));
  const merged = { ...base, ...buildFreeModelEnv('x/y:free') };
  assert.equal(merged[ENV_MODEL_ID], 'x/y:free');
  assert.equal(merged[ENV_PROVIDER_ORDER], '');
});

// --- buildModeOverrideEnv (D-031): the 3-mode env matrix --------------------

test('mode=default emits NO model/provider env (bit-identical to bundled config)', () => {
  assert.deepEqual(buildModeOverrideEnv('default', settings(), FREE_MODEL), {});
});

test('mode=default IGNORES a custom crepair.model / providerOrder / allowFallbacks', () => {
  // Even a fully-custom OverrideSettings emits nothing in default mode — those
  // settings apply only in custom mode.
  const env = buildModeOverrideEnv(
    'default',
    settings({ model: 'vendor/m', providerOrder: ['P1'], allowFallbacks: true }),
    FREE_MODEL,
  );
  assert.deepEqual(env, {});
});

test('mode=default still forwards the common reasoningEffort / configPath overrides (no model/provider)', () => {
  // The exact-match deepEqual asserts model/provider are absent — only the common
  // reasoning/configPath overrides survive in default mode.
  assert.deepEqual(
    buildModeOverrideEnv(
      'default',
      settings({ reasoningEffort: 'low', configPath: '/etc/c.yaml' }),
      FREE_MODEL,
    ),
    {
      [ENV_REASONING_EFFORT]: 'low',
      [ENV_CONFIG_PATH]: '/etc/c.yaml',
    },
  );
});

test('mode=free pins the free model + automatic routing (empty provider)', () => {
  assert.deepEqual(buildModeOverrideEnv('free', settings(), FREE_MODEL), {
    [ENV_MODEL_ID]: FREE_MODEL,
    [ENV_PROVIDER_ORDER]: '',
  });
});

test('mode=free ignores crepair.model but keeps the common reasoningEffort override', () => {
  const env = buildModeOverrideEnv(
    'free',
    settings({ model: 'vendor/should-be-ignored', reasoningEffort: 'medium' }),
    FREE_MODEL,
  );
  assert.deepEqual(env, {
    [ENV_MODEL_ID]: FREE_MODEL, // the free model, NOT vendor/should-be-ignored
    [ENV_PROVIDER_ORDER]: '',
    [ENV_REASONING_EFFORT]: 'medium',
  });
});

test('mode=custom is exactly the legacy buildOverrideEnv mapping', () => {
  const s = settings({
    model: 'vendor/m',
    providerOrder: ['P1', 'P2'],
    allowFallbacks: true,
    configPath: '/tmp/c.yaml',
    reasoningEffort: 'medium',
  });
  assert.deepEqual(buildModeOverrideEnv('custom', s, FREE_MODEL), buildOverrideEnv(s));
});

test('mode=custom with default settings emits nothing (bit-identical to default mode)', () => {
  assert.deepEqual(buildModeOverrideEnv('custom', settings(), FREE_MODEL), {});
});

// --- normalizeModelMode -----------------------------------------------------

test('normalizeModelMode passes valid modes through', () => {
  assert.equal(normalizeModelMode('default'), 'default');
  assert.equal(normalizeModelMode('free'), 'free');
  assert.equal(normalizeModelMode('custom'), 'custom');
});

test('normalizeModelMode defaults unknown / undefined to the default mode', () => {
  assert.equal(normalizeModelMode(undefined), DEFAULT_MODEL_MODE);
  assert.equal(normalizeModelMode(''), DEFAULT_MODEL_MODE);
  assert.equal(normalizeModelMode('bogus'), DEFAULT_MODEL_MODE);
  assert.equal(DEFAULT_MODEL_MODE, 'default');
});

// --- hasExplicitModel (B): user's explicit non-default model ----------------

test('hasExplicitModel is false for the default / blank model', () => {
  assert.equal(hasExplicitModel(DEFAULT_OVERRIDES.model), false);
  assert.equal(hasExplicitModel(`  ${DEFAULT_OVERRIDES.model}  `), false);
  assert.equal(hasExplicitModel(''), false);
  assert.equal(hasExplicitModel('   '), false);
});

test('hasExplicitModel is true for a non-default model', () => {
  assert.equal(hasExplicitModel('anthropic/claude-3.5-sonnet'), true);
  assert.equal(hasExplicitModel('  vendor/m  '), true);
});

// --- decideFreeSwitch (B): the free-switch decision branches ----------------

function inputs(overrides: Partial<FreeSwitchInputs> = {}): FreeSwitchInputs {
  return {
    mode: 'default',
    hasApiKey: true,
    isFreeTier: null,
    explicitModel: false,
    bridgeOnFree: false,
    ...overrides,
  };
}

test('decideFreeSwitch: no key => none (scan flow handles the missing key)', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ hasApiKey: false, isFreeTier: true })),
    { kind: 'none' },
  );
});

test('decideFreeSwitch: free tier + not on free => switch-to-free', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: true, bridgeOnFree: false })),
    { kind: 'switch-to-free' },
  );
});

test('decideFreeSwitch: free tier + already on free => none', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: true, bridgeOnFree: true })),
    { kind: 'none' },
  );
});

test('decideFreeSwitch: credits (false) + on free => revert-to-normal', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: false, bridgeOnFree: true })),
    { kind: 'revert-to-normal' },
  );
});

test('decideFreeSwitch: credits (false) + already normal => none', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: false, bridgeOnFree: false })),
    { kind: 'none' },
  );
});

test('decideFreeSwitch: unknown flag (null) + on free => revert-to-normal (defensive)', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: null, bridgeOnFree: true })),
    { kind: 'revert-to-normal' },
  );
});

test('decideFreeSwitch: unknown flag (null) + normal => none', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: null, bridgeOnFree: false })),
    { kind: 'none' },
  );
});

test('decideFreeSwitch: explicit model + free tier => never switch to free (user wins)', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: true, explicitModel: true, bridgeOnFree: false })),
    { kind: 'none' },
  );
});

test('decideFreeSwitch: explicit model + stuck on free => revert-to-normal', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ isFreeTier: true, explicitModel: true, bridgeOnFree: true })),
    { kind: 'revert-to-normal' },
  );
});

// --- decideFreeSwitch mode scoping (D-031) ----------------------------------
// The creditless auto-fallback is a `default`-mode convenience only. free/custom
// own their construction via modelMode, so the switch never fires there — but a
// bridge stuck on free from a prior default session is still reverted.

test('decideFreeSwitch: free mode + free tier => never auto-switch (mode owns the env)', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ mode: 'free', isFreeTier: true, bridgeOnFree: false })),
    { kind: 'none' },
  );
});

test('decideFreeSwitch: custom mode + free tier => never auto-switch (mode owns the env)', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ mode: 'custom', isFreeTier: true, bridgeOnFree: false })),
    { kind: 'none' },
  );
});

test('decideFreeSwitch: free/custom mode + stuck on free bridge => revert-to-normal', () => {
  // A prior default-mode session may have armed the free construction; switching to
  // free/custom mode must not inherit that stale bridge (the mode env applies on respawn).
  assert.deepEqual(
    decideFreeSwitch(inputs({ mode: 'free', isFreeTier: true, bridgeOnFree: true })),
    { kind: 'revert-to-normal' },
  );
  assert.deepEqual(
    decideFreeSwitch(inputs({ mode: 'custom', isFreeTier: false, bridgeOnFree: true })),
    { kind: 'revert-to-normal' },
  );
});

test('decideFreeSwitch: no key wins over mode (none even in default mode)', () => {
  assert.deepEqual(
    decideFreeSwitch(inputs({ mode: 'default', hasApiKey: false, isFreeTier: true })),
    { kind: 'none' },
  );
});
