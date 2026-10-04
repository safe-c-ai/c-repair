import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAC_PROFILES, detectedUnifiedBand, macProfileAsset, macProfileSettings } from '../src/ui/localMacProfiles';
import { resolveLocalSettings, validateLocalSettings, localServerArgs } from '../src/bridge/localSettings';

test('Mac memory boundaries select Qwen3.8 artifacts with independent context and output limits', () => {
  for (const [memory, band] of [[8, 'under16'], [16, '16'], [24, '24'], [32, '32plus'], [36, '32plus'], [48, '48'], [64, '64plus'], [96, '96']] as const) {
    assert.equal(detectedUnifiedBand(memory), band);
  }
  assert.equal(detectedUnifiedBand(NaN), 'unknown');
  assert.equal(macProfileAsset('under16'), undefined);
  for (const band of Object.keys(MAC_PROFILES)) {
    const asset = macProfileAsset(band)!;
    assert.match(asset.url, /\/resolve\/[a-f0-9]{40}\/Qwen3.8-27B-/);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    const settings = { ...resolveLocalSettings(() => undefined), ...macProfileSettings(band), serverPath: '/engine', modelPath: '/model' };
    validateLocalSettings(settings);
    assert.equal(settings.effort, 'medium');
    assert.equal(settings.cpuExperts, false);
    assert.equal(settings.mtpDraftTokens, 0);
    const args = localServerArgs(settings, 9999);
    assert.equal(args.includes('-t'), false);
    assert.equal(args[args.indexOf('-c') + 1], String(settings.contextTokens));
    assert.equal(args[args.indexOf('-ctk') + 1], settings.cacheTypeK);
    assert.equal(args[args.indexOf('-ub') + 1], String(settings.ubatchSize));
  }
  assert.equal(macProfileSettings('32plus').contextTokens, 131072);
  assert.equal(macProfileSettings('32plus').maxCompletionTokens, 65536);
  assert.equal(macProfileAsset('64plus')?.filename, 'Qwen3.8-27B-UD-Q5_K_M.gguf');
});

test('runtime settings reject invalid cache types and physical batches before spawning', () => {
  const s = { ...resolveLocalSettings(() => undefined), serverPath: '/engine', modelPath: '/model' };
  assert.throws(() => validateLocalSettings({ ...s, cacheTypeK: 'invalid' as any }), /KV cache/);
  assert.throws(() => validateLocalSettings({ ...s, batchSize: 128, ubatchSize: 256 }), /Physical batch/);
  assert.throws(() => validateLocalSettings({ ...s, threads: -1 }), /CPU threads/);
  const resolved = resolveLocalSettings(k => ({ cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', threads: 0, batchSize: 512, ubatchSize: 128 } as Record<string, unknown>)[k]);
  assert.equal(resolved.threads, 0);
  assert.equal(resolved.cacheTypeV, 'q8_0');
  assert.equal(resolved.ubatchSize, 128);
});
