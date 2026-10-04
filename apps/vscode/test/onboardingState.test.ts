import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onboardingState } from '../src/ui/onboardingState';
import { guideFilename } from '../src/ui/guideFilename';

test('cancelled or failed local setup is incomplete even with a saved API key or selected mode', () => {
  assert.deepEqual(onboardingState('local', true, true, false), {
    connectionConfigured: false, apiModelSelected: false, bridgePrepared: false,
  });
  assert.equal(onboardingState('local', false, true, true).connectionConfigured, true);
});

test('API credentials, model choice and bridge readiness complete independently', () => {
  assert.deepEqual(onboardingState('default', true, false, false), {
    connectionConfigured: true, apiModelSelected: false, bridgePrepared: false,
  });
  assert.deepEqual(onboardingState('custom', false, true, true), {
    connectionConfigured: false, apiModelSelected: true, bridgePrepared: true,
  });
});

test('both bundled guides follow the display language with an English fallback', () => {
  for (const [language, suffix] of [['ja', '.ja'], ['ja-JP', '.ja'], ['JA', '.ja'], ['en', ''], ['de', '']]) {
    assert.equal(guideFilename('user', language), `user-guide${suffix}.md`);
    assert.equal(guideFilename('local', language), `local-models${suffix}.md`);
  }
});
