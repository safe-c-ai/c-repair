import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_PRESET, type LocalSettings } from '../src/bridge/localSettings';
import { localSettingsText, localThinkingText, modelLineText } from '../src/ui/headerMessage';

const settings: LocalSettings = {
  ...LOCAL_PRESET, effort: 'xhigh', preset: 'qwen38-27b-q4km',
  modelPath: '/models/Qwen3.8-27B-UD-Q2_K_XL.gguf', serverPath: '/engine',
  contextTokens: 65536, maxCompletionTokens: 32768, structuredTokens: 4096,
  gpuLayers: 48, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0',
};

test('local header shows file and saved runtime settings instead of generic health labels', () => {
  const text = modelLineText({ caps: undefined, mode: 'local', localSettings: settings,
    configuredLocalModel: 'Custom local model', configuredReasoning: 'custom template',
    configuredModel: '', freeModel: '', onFreeModel: false });
  assert.match(text, /Qwen3.8-27B-UD-Q2_K_XL.gguf/);
  assert.match(text, /Reasoning: scan xhigh \/ repair xhigh/);
  assert.match(text, /context 65,536 · repair\/detection 32,768 · declarations 4,096/);
  assert.match(text, /GPU layers: 48 · KV cache: q8_0\/q8_0/);
  assert.doesNotMatch(text, /recommended|custom template|Custom local model/);
});

test('custom thinking is derived separately from actual request overrides, not effort', () => {
  const custom: LocalSettings = { ...settings, preset: 'custom', effort: 'off', generation: {}, structuredGeneration: {} };
  assert.equal(localThinkingText(custom), 'model default (unverified)');
  assert.equal(localThinkingText(custom, true), localThinkingText(custom));
  custom.generation = { chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'xhigh' } };
  custom.structuredGeneration = { chat_template_kwargs: { enable_thinking: false } };
  assert.equal(localThinkingText(custom), 'on (xhigh)');
  assert.equal(localThinkingText(custom, true), localThinkingText(custom));
});

test('custom Windows GGUF filename and CPU placement remain visible', () => {
  const text = localSettingsText({ ...settings, preset: 'custom', modelName: 'Custom local model',
    modelPath: 'C:\\models\\chosen.gguf', gpuLayers: 0 });
  assert.match(text, /^Local model: chosen.gguf \| Preset: Custom/);
  assert.match(text, /GPU layers: 0 \(CPU\)/);
});

test('header distinguishes Scan xhigh from repair medium', () => {
 const s: LocalSettings = {...settings, preset:'custom',
 generation:{chat_template_kwargs:{enable_thinking:true,reasoning_effort:'medium'}},
 detectionGeneration:{chat_template_kwargs:{enable_thinking:true,reasoning_effort:'xhigh'}}};
 assert.match(localSettingsText(s), /Reasoning: scan on \(xhigh\) \/ repair on \(medium\)/);
});
