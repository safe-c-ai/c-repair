import manifest from '../resources/local-engine.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEngineTarget, detectEngineTarget, LINUX_CUDA_CAPABILITIES } from '../src/bridge/localEngineHost';
import { releaseAssets, prepareReleaseEngine } from '../src/bridge/localReleaseEngine';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

test('engine selection covers RTX generations and explicit CPU placement without silent CUDA failure fallback', () => {
  for (const capability of LINUX_CUDA_CAPABILITIES) assert.equal(selectEngineTarget('linux', 'x64', [capability]), 'linux-cuda');
  for (const capability of ['6.1', '7.5', '8.6', '8.9']) assert.equal(selectEngineTarget('win32', 'x64', [capability]), 'windows-cuda12');
  assert.equal(selectEngineTarget('win32', 'x64', ['12.0']), 'windows-cuda13');
  assert.equal(selectEngineTarget('linux', 'x64', []), 'linux-cpu');
  assert.equal(selectEngineTarget('win32', 'x64', []), 'windows-cpu');
  assert.equal(selectEngineTarget('linux', 'x64', ['12.0'], true), 'linux-cpu');
  assert.equal(selectEngineTarget('darwin', 'arm64', []), 'mac');
  for (const caps of [['N/A'], ['6.1'], ['8.6', 'N/A']]) assert.throws(() => selectEngineTarget('linux', 'x64', caps));
  assert.throws(() => selectEngineTarget('win32', 'x64', ['6.1', '12.0']));
  assert.throws(() => selectEngineTarget('linux', 'arm64', []));
});
test('official downloads pin version, content digest and CUDA runtime dependencies', () => {
  for (const target of ['linux-cpu', 'windows-cpu', 'windows-cuda12', 'windows-cuda13'] as const) {
    const assets = releaseAssets(target);
    assert.equal(assets.length, target.includes('cuda') ? 2 : 1);
    for (const a of assets) {
      assert.match(a.url, /^https:\/\/github.com\/ggml-org\/llama.cpp\/releases\/download\/b10883\//);
      assert.match(a.sha256, /^[a-f0-9]{64}$/);
      assert.ok(a.bytes > 1e6);
    }
  }
});
test('release install checks CUDA, caches success and removes failed staging', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-release-test-'));
  let downloads = 0, runs = 0;
  const run = async (_file: string, args: string[]) => {
    runs++;
    if (args[0] === '--list-devices') return { stdout: 'Available devices:\n  CUDA0: NVIDIA RTX 3080', stderr: '' };
    await fs.mkdir(path.join(args[1], 'engine'), { recursive: true });
    await fs.writeFile(path.join(args[1], 'engine', 'llama-server.exe'), 'fixture');
    return { stdout: '', stderr: '' };
  };
  const deps = { download: async () => { downloads++; return '/archive'; }, run };
  try {
    const file = await prepareReleaseEngine('windows-cuda12', dir, '/extension', '/python', () => {}, undefined, deps);
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture');
    await prepareReleaseEngine('windows-cuda12', dir, '/extension', '/python', () => {}, undefined, deps);
    assert.equal(downloads, 2); assert.equal(runs, 2);
    const failure = path.join(dir, 'failure');
    await assert.rejects(prepareReleaseEngine('windows-cuda12', failure, '/extension', '/python', () => {}, undefined, {
      ...deps, run: async (file, args) => args[0] === '--list-devices' ? { stdout: 'CUDA initialization failed', stderr: '' } : run(file, args),
    }), /could not start with CUDA/);
    assert.deepEqual(await fs.readdir(path.join(failure, 'local-engines')), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('NVIDIA probe distinguishes absent GPU from driver failure and explicit CPU bypass', async () => {
  const deps = { platform: 'linux', arch: 'x64', run: async () => ({ stdout: '8.6\n' }) };
  assert.equal(await detectEngineTarget(undefined, 40, deps), 'linux-cuda');
  for (const code of ['ENOENT', 9]) assert.equal(await detectEngineTarget(undefined, undefined, { ...deps, run: async () => { throw Object.assign(new Error(), { code }); } }), 'linux-cpu');
  for (const code of [1, 'ETIMEDOUT']) await assert.rejects(detectEngineTarget(undefined, undefined, { ...deps, run: async () => { throw Object.assign(new Error(), { code }); } }), /NVIDIA driver/);
  assert.equal(await detectEngineTarget(undefined, 0, { ...deps, run: async () => { throw new Error('Must not probe'); } }), 'linux-cpu');
});

test('runtime GPU selection matches the bundled build manifest', () => {
  assert.deepEqual(manifest.computeCapabilities, LINUX_CUDA_CAPABILITIES);
});
