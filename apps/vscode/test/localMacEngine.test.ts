import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportedMacOS, hasMetalDevice, MAC_ENGINE } from '../src/bridge/localMacEngine';

test('automatic Mac engine checks OS floor and an actual Metal device line', () => {
  for (const version of ['13.3', '14.7.1', '26.0\n']) assert.equal(supportedMacOS(version), true);
  for (const version of ['12.7', '13.2.1', '', 'unknown']) assert.equal(supportedMacOS(version), false);
  assert.equal(hasMetalDevice('Available devices:\n  Metal: Apple M4 Max (49152 MiB)'), true);
  assert.equal(hasMetalDevice('  MTL0: Apple M1'), true);
  assert.equal(hasMetalDevice('Metal initialization failed\nCPU: Apple M1'), false);
  assert.equal(MAC_ENGINE.arch, 'arm64');
  assert.match(MAC_ENGINE.sha256, /^[a-f0-9]{64}$/);
});
