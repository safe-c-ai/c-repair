// Unit tests for the always-on TreeView header model line + header combining.
// Pure Node, no `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HealthCapabilities } from '../src/bridge/health';
import {
  combineHeaderMessage,
  configuredModelForMode,
  isFreeModel,
  modelLineText,
  reasoningText,
  type ModelLineInputs,
} from '../src/ui/headerMessage';
import { DEFAULT_OVERRIDES, DEFAULT_MODE_LABEL_LOWER } from '../src/bridge/overrideEnv';

const FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

function caps(overrides: Partial<HealthCapabilities> = {}): HealthCapabilities {
  return {
    rule_profile: 'cert-c',
    rules_count: 115,
    gates: ['format', 'compile'],
    routes: ['api'],
    model: 'deepseek/deepseek-v4-flash-0731',
    provider_order: ['DeepInfra'],
    reasoning_effort: 'xhigh',
    ...overrides,
  };
}

function inputs(overrides: Partial<ModelLineInputs> = {}): ModelLineInputs {
  return {
    caps: undefined,
    mode: 'custom',
    configuredModel: DEFAULT_OVERRIDES.model,
    freeModel: FREE_MODEL,
    configuredReasoning: DEFAULT_OVERRIDES.reasoningEffort,
    onFreeModel: false,
    ...overrides,
  };
}

// --- isFreeModel ------------------------------------------------------------

test('isFreeModel: a `:free` model id is FREE', () => {
  assert.equal(isFreeModel('nvidia/nemotron-3-super-120b-a12b:free', false), true);
  assert.equal(isFreeModel('X:FREE', false), true); // case-insensitive
});

test('isFreeModel: a plain model id is PAID unless the free construction is active', () => {
  assert.equal(isFreeModel('deepseek/deepseek-v4-flash-0731', false), false);
  assert.equal(isFreeModel('deepseek/deepseek-v4-flash-0731', true), true);
});

// --- reasoningText ----------------------------------------------------------

test('reasoningText: prefers the /health value when present', () => {
  assert.equal(reasoningText(caps({ reasoning_effort: 'high' }), 'low'), 'high');
});

test('reasoningText: `off` -> disabled, `default` -> config default (from health)', () => {
  assert.equal(reasoningText(caps({ reasoning_effort: 'off' }), 'low'), 'disabled');
  assert.equal(reasoningText(caps({ reasoning_effort: 'default' }), 'low'), 'config default');
});

test('reasoningText: falls back to the configured setting when health is absent', () => {
  assert.equal(reasoningText(undefined, 'medium'), 'medium');
  assert.equal(reasoningText(undefined, 'off'), 'disabled');
  assert.equal(reasoningText(undefined, ''), DEFAULT_OVERRIDES.reasoningEffort);
});

// --- modelLineText ----------------------------------------------------------

test('modelLineText: from /health, PAID default model', () => {
  assert.equal(
    modelLineText(inputs({ caps: caps() })),
    'Model: deepseek/deepseek-v4-flash-0731 (PAID) · reasoning: xhigh · mode: custom',
  );
});

test('modelLineText: from /health, FREE model id', () => {
  assert.equal(
    modelLineText(
      inputs({
        caps: caps({ model: 'nvidia/nemotron-3-super-120b-a12b:free', reasoning_effort: 'off' }),
      }),
    ),
    'Model: nvidia/nemotron-3-super-120b-a12b:free (FREE) · reasoning: disabled · mode: custom',
  );
});

test('modelLineText: onFreeModel construction forces FREE even for a plain id', () => {
  assert.equal(
    modelLineText(inputs({ caps: caps(), onFreeModel: true })),
    'Model: deepseek/deepseek-v4-flash-0731 (FREE) · reasoning: xhigh · mode: custom',
  );
});

test('modelLineText: before health, falls back to configured settings', () => {
  assert.equal(
    modelLineText(inputs({ configuredModel: 'anthropic/claude-x', configuredReasoning: 'high' })),
    'Model: anthropic/claude-x (PAID) · reasoning: high · mode: custom',
  );
});

test('modelLineText: before health, a blank configured model resolves to the default', () => {
  assert.equal(
    modelLineText(inputs({ configuredModel: '   ', configuredReasoning: '' })),
    `Model: ${DEFAULT_OVERRIDES.model} (PAID) · reasoning: ${DEFAULT_OVERRIDES.reasoningEffort} · mode: custom`,
  );
});

// --- modelLineText mode awareness (D-031) -----------------------------------

test('modelLineText: mode=default before health shows the bundled preset (ignores configuredModel)', () => {
  // D-038: the internal `default` mode renders as its display label in the header.
  assert.equal(
    modelLineText(inputs({ mode: 'default', configuredModel: 'vendor/ignored' })),
    `Model: ${DEFAULT_OVERRIDES.model} (PAID) · reasoning: ${DEFAULT_OVERRIDES.reasoningEffort} · mode: ${DEFAULT_MODE_LABEL_LOWER}`,
  );
});

test('modelLineText: mode=free before health shows the free model (FREE tag via onFreeModel)', () => {
  assert.equal(
    modelLineText(inputs({ mode: 'free', configuredModel: 'vendor/ignored', onFreeModel: true })),
    `Model: ${FREE_MODEL} (FREE) · reasoning: ${DEFAULT_OVERRIDES.reasoningEffort} · mode: free`,
  );
});

test('modelLineText: mode=custom before health shows the configured model', () => {
  assert.equal(
    modelLineText(inputs({ mode: 'custom', configuredModel: 'anthropic/claude-x' })),
    'Model: anthropic/claude-x (PAID) · reasoning: xhigh · mode: custom',
  );
});

test('modelLineText: /health value supersedes the mode-derived model but the mode tag reflects the setting', () => {
  // Once the bridge reports, the effective /health model wins regardless of mode; the
  // `· mode:` tag still reflects the current crepair.modelMode setting (D-031).
  assert.equal(
    modelLineText(inputs({ mode: 'free', caps: caps() })),
    'Model: deepseek/deepseek-v4-flash-0731 (PAID) · reasoning: xhigh · mode: free',
  );
});

// --- configuredModelForMode -------------------------------------------------

test('configuredModelForMode: free -> freeModel; default -> bundled default; custom -> configured', () => {
  assert.equal(configuredModelForMode('free', 'vendor/ignored', FREE_MODEL), FREE_MODEL);
  assert.equal(configuredModelForMode('default', 'vendor/ignored', FREE_MODEL), DEFAULT_OVERRIDES.model);
  assert.equal(configuredModelForMode('custom', 'anthropic/claude-x', FREE_MODEL), 'anthropic/claude-x');
});

test('configuredModelForMode: blanks resolve to the bundled default', () => {
  assert.equal(configuredModelForMode('custom', '   ', FREE_MODEL), DEFAULT_OVERRIDES.model);
  assert.equal(configuredModelForMode('free', 'vendor/ignored', '   '), DEFAULT_OVERRIDES.model);
});

// --- combineHeaderMessage ---------------------------------------------------

test('combineHeaderMessage: model line, standard line, then session line join on newlines', () => {
  // The standard line (D-039) always sits directly under the model line.
  assert.equal(
    combineHeaderMessage('Model: m (PAID) · reasoning: xhigh', 'Session: 1.0k in / 0 out'),
    'Model: m (PAID) · reasoning: xhigh\nStandard: CERT® C\nSession: 1.0k in / 0 out',
  );
});

test('combineHeaderMessage: model line + standard line when there is no session line', () => {
  assert.equal(
    combineHeaderMessage('Model: m (PAID) · reasoning: xhigh', undefined),
    'Model: m (PAID) · reasoning: xhigh\nStandard: CERT® C',
  );
});
