// Unit tests for the "View Model Providers" URL builder (crepair.openModelProviders).
// Pure Node, no `vscode` module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENROUTER_BASE,
  effectiveModelId,
  modelProvidersUrl,
} from '../src/ui/modelProviders';
import { DEFAULT_OVERRIDES } from '../src/bridge/overrideEnv';

test('effectiveModelId: non-blank configured model is used verbatim (trimmed)', () => {
  assert.equal(effectiveModelId('anthropic/claude-x'), 'anthropic/claude-x');
  assert.equal(effectiveModelId('  anthropic/claude-x  '), 'anthropic/claude-x');
});

test('effectiveModelId: blank / whitespace / undefined falls back to the verified default', () => {
  assert.equal(effectiveModelId(''), DEFAULT_OVERRIDES.model);
  assert.equal(effectiveModelId('   '), DEFAULT_OVERRIDES.model);
  assert.equal(effectiveModelId(undefined), DEFAULT_OVERRIDES.model);
});

test('modelProvidersUrl: normal model maps directly onto the OpenRouter path', () => {
  assert.equal(
    modelProvidersUrl('deepseek/deepseek-v4-flash-0731'),
    `${OPENROUTER_BASE}/deepseek/deepseek-v4-flash-0731`,
  );
});

test('modelProvidersUrl: the :free variant marker is preserved in the path', () => {
  assert.equal(
    modelProvidersUrl('nvidia/nemotron-3-super-120b-a12b:free'),
    `${OPENROUTER_BASE}/nvidia/nemotron-3-super-120b-a12b:free`,
  );
});

test('modelProvidersUrl: empty setting resolves to the verified default model page', () => {
  assert.equal(modelProvidersUrl(''), `${OPENROUTER_BASE}/${DEFAULT_OVERRIDES.model}`);
  assert.equal(modelProvidersUrl(undefined), `${OPENROUTER_BASE}/${DEFAULT_OVERRIDES.model}`);
});

test('modelProvidersUrl: path segments are URL-safe but `/` and `:` are kept literal', () => {
  // A space in an id would break the URL if not encoded; it is percent-encoded while
  // the author/slug separator and the :free marker stay literal.
  assert.equal(
    modelProvidersUrl('some author/weird model:free'),
    `${OPENROUTER_BASE}/some%20author/weird%20model:free`,
  );
});
