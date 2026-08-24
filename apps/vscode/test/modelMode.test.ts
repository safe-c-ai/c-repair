// Unit tests for the pure model-mode decision helpers (D-031, trial-free
// guarantee). Pure Node, no `vscode` module. The load-bearing properties:
//   - the picker shows only when NOT already chosen AND the mode is still `default`
//     with no explicit legacy `crepair.model`;
//   - a non-default mode (free / custom) OR an explicit model records the flag
//     WITHOUT prompting (respect the choice);
//   - the picker writes ONLY `crepair.modelMode` (the source of truth), never
//     `crepair.model` / `crepair.providerOrder`;
//   - the legacy free-model migration fires only for a default-mode user whose
//     `crepair.model` equals `crepair.freeModel`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_MODE_GATE_ACTION,
  MODEL_MODE_GATE_MESSAGE,
  shouldPromptModelMode,
  shouldRecordWithoutPrompt,
  shouldMigrateLegacyFreeModel,
  modelModeConfigUpdates,
  switchToCustomConfigUpdates,
} from '../src/session/modelMode';
import {
  DEFAULT_MODE_LABEL,
  DEFAULT_OVERRIDES,
  type ModelMode,
} from '../src/bridge/overrideEnv';

const DEFAULT_MODEL = DEFAULT_OVERRIDES.model;
const FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

// --- shouldPromptModelMode --------------------------------------------------

test('prompt: not chosen + default mode + default model => show the picker', () => {
  assert.equal(shouldPromptModelMode(false, 'default', DEFAULT_MODEL), true);
});

test('prompt: not chosen + default mode + blank model => show the picker (blank = default)', () => {
  assert.equal(shouldPromptModelMode(false, 'default', ''), true);
  assert.equal(shouldPromptModelMode(false, 'default', '   '), true);
});

test('prompt: already chosen => never show, regardless of mode / model', () => {
  assert.equal(shouldPromptModelMode(true, 'default', DEFAULT_MODEL), false);
  assert.equal(shouldPromptModelMode(true, 'free', DEFAULT_MODEL), false);
  assert.equal(shouldPromptModelMode(true, 'custom', 'vendor/custom'), false);
});

test('prompt: a non-default mode (free / custom) => do NOT show (already a choice)', () => {
  assert.equal(shouldPromptModelMode(false, 'free', DEFAULT_MODEL), false);
  assert.equal(shouldPromptModelMode(false, 'custom', DEFAULT_MODEL), false);
});

test('prompt: default mode but explicit non-default model => do NOT show (respect the legacy choice)', () => {
  assert.equal(shouldPromptModelMode(false, 'default', 'anthropic/claude-3.5-sonnet'), false);
  // The free model set explicitly also counts as explicit (differs from default).
  assert.equal(shouldPromptModelMode(false, 'default', FREE_MODEL), false);
});

test('prompt: default model with surrounding whitespace is still the default (show)', () => {
  assert.equal(shouldPromptModelMode(false, 'default', `  ${DEFAULT_MODEL}  `), true);
});

// --- shouldRecordWithoutPrompt ----------------------------------------------

test('recordWithoutPrompt: non-default mode + not chosen => record silently', () => {
  assert.equal(shouldRecordWithoutPrompt(false, 'free', DEFAULT_MODEL), true);
  assert.equal(shouldRecordWithoutPrompt(false, 'custom', DEFAULT_MODEL), true);
});

test('recordWithoutPrompt: explicit legacy model + default mode + not chosen => record silently', () => {
  assert.equal(shouldRecordWithoutPrompt(false, 'default', 'vendor/custom'), true);
});

test('recordWithoutPrompt: default mode + default/blank model + not chosen => do NOT record (prompt instead)', () => {
  assert.equal(shouldRecordWithoutPrompt(false, 'default', DEFAULT_MODEL), false);
  assert.equal(shouldRecordWithoutPrompt(false, 'default', ''), false);
});

test('recordWithoutPrompt: already chosen => nothing to record', () => {
  assert.equal(shouldRecordWithoutPrompt(true, 'custom', 'vendor/custom'), false);
  assert.equal(shouldRecordWithoutPrompt(true, 'default', DEFAULT_MODEL), false);
});

// prompt vs record are mutually exclusive: at most one action per state.
test('prompt and record are never both true for the same state', () => {
  const modes: ModelMode[] = ['default', 'free', 'custom'];
  for (const chosen of [true, false]) {
    for (const mode of modes) {
      for (const model of [DEFAULT_MODEL, '', 'vendor/custom', FREE_MODEL]) {
        const prompt = shouldPromptModelMode(chosen, mode, model);
        const record = shouldRecordWithoutPrompt(chosen, mode, model);
        assert.ok(
          !(prompt && record),
          `both true for chosen=${chosen}, mode=${mode}, model=${model}`,
        );
      }
    }
  }
});

// --- shouldMigrateLegacyFreeModel -------------------------------------------

test('migrate: default mode + model == freeModel => migrate', () => {
  assert.equal(shouldMigrateLegacyFreeModel('default', FREE_MODEL, FREE_MODEL), true);
  // Whitespace does not defeat the equality check.
  assert.equal(shouldMigrateLegacyFreeModel('default', `  ${FREE_MODEL} `, FREE_MODEL), true);
});

test('migrate: default mode + model != freeModel => no migration', () => {
  assert.equal(shouldMigrateLegacyFreeModel('default', DEFAULT_MODEL, FREE_MODEL), false);
  assert.equal(shouldMigrateLegacyFreeModel('default', '', FREE_MODEL), false);
  assert.equal(shouldMigrateLegacyFreeModel('default', 'vendor/other', FREE_MODEL), false);
});

test('migrate: a non-default mode is never migrated (user already chose)', () => {
  assert.equal(shouldMigrateLegacyFreeModel('free', FREE_MODEL, FREE_MODEL), false);
  assert.equal(shouldMigrateLegacyFreeModel('custom', FREE_MODEL, FREE_MODEL), false);
});

// --- modelModeConfigUpdates -------------------------------------------------

test('free choice writes only crepair.modelMode = free', () => {
  assert.deepEqual(modelModeConfigUpdates('free'), [
    { key: 'crepair.modelMode', value: 'free' },
  ]);
});

test('custom choice writes only crepair.modelMode = custom', () => {
  assert.deepEqual(modelModeConfigUpdates('custom'), [
    { key: 'crepair.modelMode', value: 'custom' },
  ]);
});

test('default choice resets crepair.modelMode to its default (undefined), touching nothing else', () => {
  assert.deepEqual(modelModeConfigUpdates('default'), [
    { key: 'crepair.modelMode', value: undefined },
  ]);
});

test('the picker never writes crepair.model / crepair.providerOrder', () => {
  for (const mode of ['default', 'free', 'custom'] as ModelMode[]) {
    const keys = modelModeConfigUpdates(mode).map((u) => u.key);
    assert.deepEqual(keys, ['crepair.modelMode'], `mode=${mode} wrote unexpected keys`);
  }
});

// --- switchToCustomConfigUpdates (D-019 config-change "Switch to custom") ----

test('switchToCustomConfigUpdates writes only crepair.modelMode = custom', () => {
  assert.deepEqual(switchToCustomConfigUpdates(), [
    { key: 'crepair.modelMode', value: 'custom' },
  ]);
});

test('switchToCustomConfigUpdates matches modelModeConfigUpdates(custom)', () => {
  assert.deepEqual(switchToCustomConfigUpdates(), modelModeConfigUpdates('custom'));
});

// --- fail-closed scan-gate notice (D-031 billing safety) ---------------------

test('scan-gate notice: exact wording — Free ($0) vs the preset model, usage-based', () => {
  // Pinned verbatim: the scan was ABORTED for billing safety, so the message must
  // state both options and their cost character before the user retries.
  assert.equal(
    MODEL_MODE_GATE_MESSAGE,
    `Choose a model mode to start scanning — Free ($0) or the ${DEFAULT_MODE_LABEL} ` +
      `model (usage-based).`,
  );
  // The preset name derives from the D-038 display label (never the stored value
  // "default"), so a future label rename stays a one-constant swap.
  assert.ok(MODEL_MODE_GATE_MESSAGE.includes(DEFAULT_MODE_LABEL));
  assert.ok(!/default model/i.test(MODEL_MODE_GATE_MESSAGE));
});

test('scan-gate notice: the action button names the Choose Model Mode command', () => {
  // The button label must match the command title so the notice launches exactly
  // what it names (crepair.chooseModelMode).
  assert.equal(MODEL_MODE_GATE_ACTION, 'Choose Model Mode');
});
