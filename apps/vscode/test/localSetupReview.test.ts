import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDefaults, setupChanges } from '../src/ui/localSetupReview';

test('same preset retains tuning and custom options without mutating current settings', () => {
  const current = setupDefaults('custom');
  Object.assign(current, { modelPath: '/model.gguf', contextTokens: 131072, maxCompletionTokens: 65536, serverPath: '/engine', generation: { temperature: 0.8 } });
  const next = setupDefaults('custom', current);
  assert.equal(next.contextTokens, 131072);
  assert.equal(next.serverPath, '/engine');
  assert.deepEqual(setupChanges(current, next), []);
  next.generation!.temperature = 0.2;
  assert.equal(current.generation!.temperature, 0.8);
  assert.deepEqual(setupChanges(current, next).map(c => c.key), ['generation']);
});

test('switching models resets incompatible options and exposes the overwritten values', () => {
  const current = setupDefaults('qwen38-27b-q4km');
  Object.assign(current, { modelPath: '/old.gguf', contextTokens: 131072, serverPath: '/manual-engine' });
  const next = setupDefaults('qwen36-35b-a3b', current);
  next.modelPath = '/new.gguf';
  assert.equal(next.effort, 'model');
  const changes = setupChanges(current, next);
  for (const key of ['preset', 'serverPath', 'modelPath', 'contextTokens', 'effort', 'cpuExperts']) assert.ok(changes.some(c => c.key === key));
  assert.equal(changes.find(c => c.key === 'serverPath')!.after, 'Automatic');
  assert.equal(current.effort, 'medium');
});
