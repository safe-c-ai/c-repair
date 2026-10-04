import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryAdvice, ramAdvice } from '../src/ui/localMemoryAdvice';

test('VRAM bands prioritize Qwen down to 10 GB and retain a RAM guard', () => {
  for (const band of ['32plus', '24', '16', '12', '10'] as const) {
    assert.equal(memoryAdvice(band, 32).candidate, 'qwen38-27b-q4km');
    assert.equal(memoryAdvice(band, 8).candidate, undefined);
  }
  for (const band of ['8', 'under8'] as const) {
    assert.equal(memoryAdvice(band, 32).candidate, 'ornith15-35b-a3b');
    assert.equal(memoryAdvice(band, 16).candidate, undefined);
  }
  assert.equal(memoryAdvice('unknown', 192).candidate, undefined);
  assert.match(ramAdvice(16), /21.7 GB/);
  assert.match(ramAdvice(32), /OS and work buffers/);
  assert.match(ramAdvice(), /unknown/);
});

import { detectedVramBand, unifiedMemoryAdvice } from '../src/ui/localMemoryAdvice';
import { parseGpuMemory } from '../src/bridge/localMemory';

test('capacity detection tolerates driver reserve and keeps multiple GPUs separate', () => {
  assert.equal(detectedVramBand(31.8), '32plus');
  assert.equal(detectedVramBand(23.8), '24');
  assert.equal(detectedVramBand(undefined), 'unknown');
  const rows = parseGpuMemory('0, 16384, 1024, 15360\n1, 16384, 2048, 14336');
  assert.equal(rows?.length, 2);
  assert.equal(rows?.[0].totalMiB, 16384);
  for (const bad of ['', 'N/A', '0, 16384, 99999, 0']) assert.equal(parseGpuMemory(bad), undefined);
});

test('Apple Silicon guidance treats memory as one pool, without RAM-offload capacity claims', () => {
  assert.equal(unifiedMemoryAdvice('64plus').candidate, 'qwen38-27b-q4km');
  for (const band of ['under16', 'unknown'] as const) assert.equal(unifiedMemoryAdvice(band).candidate, undefined);
  assert.match(unifiedMemoryAdvice('64plus').message, /does not add capacity/);
  assert.match(unifiedMemoryAdvice('64plus').message, /not been tested on Mac/);
});

import { gpuProfile, gpuProfileSettings, gpuProfileAsset } from '../src/ui/localGpuProfiles';
import { resolveLocalSettings, validateLocalSettings } from '../src/bridge/localSettings';
test('10 GB selects the Q2 artifact with partial offload and retains reasoning capacity', () => {
  for (const vram of [9.8, 10, 11]) assert.equal(detectedVramBand(vram), '10');
  assert.equal(detectedVramBand(8), '8');
  assert.equal(detectedVramBand(11.8), '12');
  const p = gpuProfile('10', 32)!;
  assert.equal(p.artifactId, 'qwen38:UD-Q2_K_XL');
  assert.equal(p.settings.effort, 'medium');
  assert.equal(p.settings.gpuLayers, 40);
  assert.equal(p.settings.contextTokens, 65536);
  assert.equal(p.settings.maxCompletionTokens, 32768);
  assert.equal(p.settings.cacheTypeK, 'q8_0');
  assert.match(gpuProfileAsset('10', 32)!.url, /4ca720.*Q2_K_XL/);
});
test('every hardware profile resolves to a valid matching downloadable configuration', () => {
  for (const band of ['32plus', '24', '16', '12', '10', '8', 'under8']) {
    const p = gpuProfile(band, 32)!;
    const settings = resolveLocalSettings(k => k === 'preset' ? p.artifact.preset : undefined);
    validateLocalSettings({ ...settings, ...gpuProfileSettings(band, 32), managedArtifact: p.artifactId, modelPath: '/models/' + p.artifact.filename, serverPath: '/engine' });
  }
});
