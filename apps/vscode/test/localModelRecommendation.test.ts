import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendLocalModel } from '../src/ui/localModelRecommendation';
import catalog from '../resources/local-model-artifacts.json';
import { setupDefaults } from '../src/ui/localSetupReview';
import { validateLocalSettings } from '../src/bridge/localSettings';

test('memory allocation always retains the selected model across CPU, GPU and Mac', () => {
  for (const unified of [true, false]) for (const ramGiB of [16, 24, 32, 64]) for (const vramGiB of [0, 8, 10, 16, 24, 32, undefined]) {
    for (const id of ['qwen38-27b-q4km', 'ornith15-35b-a3b'] as const) {
      const result = recommendLocalModel(id, { unified, ramGiB, vramGiB });
      if (!result) { assert.equal(id, 'ornith15-35b-a3b'); assert.ok(ramGiB < 32); continue; }
      assert.equal(catalog[result.artifactId].preset, id);
      validateLocalSettings({ ...setupDefaults(id), ...result.settings, modelPath: '/model/' + catalog[result.artifactId].filename, serverPath: '/engine', managedArtifact: result.artifactId });
    }
  }
});
test('explicit Qwen selection below the automatic model threshold retains Qwen with RAM placement', () => {
  const cpu = recommendLocalModel('qwen38-27b-q4km', { unified: false, ramGiB: 32, vramGiB: 0 })!;
  assert.equal(cpu.artifactId, 'qwen38:UD-Q2_K_XL');
  assert.equal(cpu.settings.gpuLayers, 0);
  assert.equal(cpu.settings.effort, 'medium');
  const lowGpu = recommendLocalModel('qwen38-27b-q4km', { unified: false, ramGiB: 32, vramGiB: 8 })!;
  assert.equal(lowGpu.settings.gpuLayers, 24);
  assert.equal(recommendLocalModel('custom', { unified: false, ramGiB: 64 }), undefined);
});
