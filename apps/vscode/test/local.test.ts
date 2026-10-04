import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_PRESET, resolveLocalSettings, validateLocalSettings, localServerArgs, localBridgeEnv, localErrorSetting, type LocalSettings } from '../src/bridge/localSettings';
import { buildModeOverrideEnv, DEFAULT_OVERRIDES, normalizeModelMode } from '../src/bridge/overrideEnv';
import { BridgeClient, BridgeHttpError } from '../src/bridge/BridgeClient';
import { modelLineText } from '../src/ui/headerMessage';
import { checkHealthCompat, effectiveProviderLabel } from '../src/bridge/health';

const settings: LocalSettings = { ...LOCAL_PRESET, effort: 'xhigh', serverPath: '/local/llama-server', modelPath: '/local/model.gguf' };

test('local mode isolates API model/provider/reasoning overrides', () => {
  assert.equal(normalizeModelMode('local'), 'local');
  assert.deepEqual(buildModeOverrideEnv('local', { ...DEFAULT_OVERRIDES, configPath: '/remote.yaml', reasoningEffort: 'off' }, 'remote/free'), {});
  const env = localBridgeEnv(settings, 9999);
  assert.equal(env.CREPAIR_LOCAL_EFFORT, 'xhigh');
  assert.equal(env.CREPAIR_LOCAL_COMPLETION, '32768');
  assert.equal(env.CREPAIR_ROUTE, 'local');
  assert.ok(!Object.keys(env).some(k => /API_KEY|PROVIDER/.test(k)));
});

test('local model process uses loopback and no context shift with explicit placement', () => {
  const args = localServerArgs(settings, 12345);
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('-np') + 1], '1');
  assert.equal(args[args.indexOf('-c') + 1], '65536');
  assert.ok(args.includes('--no-context-shift'));
  assert.equal(args[args.indexOf('--spec-draft-n-max') + 1], '2');
  assert.ok(!localServerArgs({ ...settings, mtpDraftTokens: 0 }, 12345).includes('--spec-type'));
});

test('generation cap leaves input capacity; malformed settings never reach spawn', () => {
  assert.throws(() => validateLocalSettings({ ...settings, maxCompletionTokens: 65536 }), /Context|context/);
  assert.throws(() => validateLocalSettings({ ...settings, structuredTokens: 65536 }), /Context|context/);
  assert.throws(() => validateLocalSettings({ ...settings, gpuLayers: -1 }));
  assert.throws(() => validateLocalSettings({ ...settings, threads: 1.5 }));
  assert.throws(() => validateLocalSettings({ ...settings, effort: 'max' as 'xhigh' }));
  validateLocalSettings({ ...settings, maxCompletionTokens: 65536, contextTokens: 81920 });
});

test('local model display never claims API routing or paid mode', () => {
  const line = modelLineText({ caps: undefined, mode: 'local', configuredModel: 'remote/model', freeModel: 'remote/free', configuredReasoning: 'xhigh', onFreeModel: false });
  assert.match(line, /Qwen3.8-27B \(LOCAL\)/);
  assert.doesNotMatch(line, /PAID|remote/);
  assert.equal(effectiveProviderLabel({ routes: ['local'], gates: [], rule_profile: 'cert-c', rules_count: 115 }), 'Local inference');
});

test('bridge token-limit response links directly to the correct editable setting', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: { code: 'local_generation_limit', message: 'Increase token limit.' } }), { status: 422 });
  try {
    const client = new BridgeClient('http://127.0.0.1:1234', 'local-test-token');
    await assert.rejects(client.health(), err => {
      assert.ok(err instanceof BridgeHttpError);
      assert.equal(err.message, 'Increase token limit.');
      assert.equal(localErrorSetting(err.code), 'maxCompletionTokens');
      return true;
    });
    assert.equal(localErrorSetting('local_context'), 'contextTokens');
    assert.equal(localErrorSetting('local_structured_limit'), 'structuredTokens');
    assert.equal(localErrorSetting('local_runtime'), undefined);
  } finally { globalThis.fetch = previous; }
});


test('local handshake refuses older or mixed cloud bridges before source is sent', () => {
  const health = { status: 'ok', contract_version: '1', harness: { id: 'certfix', version: '0.4.0' },
    adapter: { id: 'certfix', version: '0.1.0' }, capabilities: { local_protocol_version: 6, rules_count: 115, rule_profile: 'cert-c', gates: [], routes: ['api'] } };
  assert.equal(checkHealthCompat(health).ok, true);
  assert.equal(checkHealthCompat(health, true).ok, false);
  health.capabilities.routes = ['local', 'api'];
  assert.equal(checkHealthCompat(health, true).ok, false);
  health.capabilities.routes = ['local'];
  assert.equal(checkHealthCompat(health, true).ok, true);
  health.capabilities.local_protocol_version = 3;
  assert.equal(checkHealthCompat(health, true).ok, false);
});


test('Qwen3.6 uses its own defaults and CPU expert placement, preserving explicit limits', () => {
  const values: Record<string, unknown> = { preset: 'qwen36-35b-a3b', serverPath: '/server', modelPath: '/model', maxCompletionTokens: 8192, effort: null };
  const s = resolveLocalSettings(k => values[k]);
  assert.equal(s.effort, 'model');
  assert.equal(s.maxCompletionTokens, 8192);
  assert.equal(s.mtpDraftTokens, 0);
  assert.equal(s.cpuExperts, true);
  assert.equal(s.modelName, 'Qwen3.6-35B-A3B');
  assert.ok(localServerArgs(s, 1234).includes('--cpu-moe'));
  assert.throws(() => validateLocalSettings({ ...s, effort: 'xhigh' }), /effort/);
  assert.equal(localBridgeEnv(s, 1234).CREPAIR_LOCAL_PRESET, 'qwen36-35b-a3b');
});

test('custom knobs cannot replace prompts, routing or generation ceilings', () => {
  const s = resolveLocalSettings(k => ({ preset: 'custom', modelName: 'My GGUF', serverPath: '/server', modelPath: '/model', generation: { temperature: 0.6, chat_template_kwargs: { enable_thinking: true } }, structuredGeneration: { chat_template_kwargs: { enable_thinking: false } } })[k]);
  validateLocalSettings(s);
  assert.equal(s.mtpDraftTokens, 0);
  assert.equal(JSON.parse(localBridgeEnv(s, 1234).CREPAIR_LOCAL_GENERATION).temperature, 0.6);
  for (const bad of [{ max_tokens: 8 }, { messages: [] }, { base_url: 'https://example.com' }, { temperature: -1 }, { chat_template_kwargs: [] }]) {
    assert.throws(() => validateLocalSettings({ ...s, generation: bad }));
  }
  assert.match(modelLineText({ caps: undefined, mode: 'local', configuredLocalModel: s.modelName, configuredModel: 'remote', freeModel: '', configuredReasoning: 'custom template', onFreeModel: false }), /My GGUF \(LOCAL\)/);
});

test('atomic local configuration supersedes stale legacy overrides', () => {
  const values = { ...settings, preset: 'qwen38-27b-q4km', effort: 'medium', contextTokens: 131072 };
  const resolved = resolveLocalSettings(key => key === 'configuration' ? values : key === 'effort' ? 'off' : key === 'modelPath' ? '/stale.gguf' : undefined);
  assert.equal(resolved.effort, 'medium');
  assert.equal(resolved.modelPath, values.modelPath);
  assert.equal(resolved.contextTokens, 131072);
});
test('managed model identity rejects a mismatching file or family', () => {
  assert.throws(() => validateLocalSettings({ ...settings, managedArtifact: 'qwen38:UD-Q5_K_M' }), /do not match/);
  assert.throws(() => validateLocalSettings({ ...settings, managedArtifact: 'unknown' }), /do not match/);
});

test('Scan override survives saved configuration and bridge environment; invalid overrides are rejected', () => {
  const detectionGeneration = {chat_template_kwargs:{enable_thinking:true,reasoning_effort:'xhigh'}};
  const saved = {...settings, detectionGeneration};
  const resolved = resolveLocalSettings(k => k === 'configuration' ? saved : undefined);
  assert.deepEqual(resolved.detectionGeneration, detectionGeneration);
  assert.deepEqual(JSON.parse(localBridgeEnv(resolved,9999).CREPAIR_LOCAL_DETECTION_GENERATION),detectionGeneration);
  assert.throws(() => validateLocalSettings({...saved,detectionGeneration:{unsupported:1}}));
});
