import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { packageVsix, parseArguments, fingerprint } from '../package-local.mjs';
const require = createRequire(import.meta.url);
const vsce = require('@vscode/vsce');
const yazl = require('yazl');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'crepair-package-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), temporaryRoot = join(base, 'tmp');
  const app = join(root, 'apps/vscode');
  await mkdir(app, { recursive: true }); await mkdir(temporaryRoot);
  const put = async (name, content) => { await mkdir(dirname(join(app, name)), { recursive: true }); await writeFile(join(app, name), content); };
  await put('package.json', JSON.stringify({ name: 'c-repair', publisher: 'safe-c-ai', version: '1.2.3', engines: { vscode: '^1.85.0' }, main: './dist/extension.js', activationEvents: ['onLanguage:c'] }));
  await put('.vscodeignore', '.vscodeignore\n*.vsix\n*.vsix.sha256\n');
  await put('CHANGELOG.md', '# Changelog\n\n## 1.2.3\nFixture release');
  await put('README.md', 'Fixture'); await put('LICENSE', 'Fixture license');
  await put('dist/extension.js', 'unchanged live build');
  await put('docs/local-models.md', 'Guide'); await put('docs/local-models.ja.md', 'ガイド');
  await put('docs/user-guide.md', 'User guide'); await put('docs/user-guide.ja.md', '利用ガイド');
  await put('resources/quick-start.c', 'int read_sample(int index) { const int values[3] = {10, 20, 30}; return values[index]; }\n');
  const wheel = 'bridge-dist/test.whl';
  await put(wheel, 'wheel');
  await put('bridge-dist/MANIFEST.json', JSON.stringify({ files: [{ file: 'test.whl', ...await fingerprint(join(app, wheel)) }] }));
  await put('engine-dist/engine.tar.gz', 'engine');
  const engine = await fingerprint(join(app, 'engine-dist/engine.tar.gz'));
  await put('resources/local-engine.json', JSON.stringify({ bundle: 'engine.tar.gz', sha256: engine.sha256, bytes: engine.size }));
  for (const name of ['mlx-server.py', 'install-mlx-uv.py', 'local-mlx-uv.json', 'mlx-requirements.txt', 'local-mlx-models.json']) await put('resources/' + name, 'mlx');
  const calls = [];
  const build = async ({ outfile }) => { calls.push('build'); await mkdir(dirname(outfile), { recursive: true }); await writeFile(outfile, 'isolated fresh bundle'); };
  const pack = async options => {
    calls.push(options.target);
    const files = await vsce.listFiles({ ...options, packageManager: vsce.PackageManager.None });
    const zip = new yazl.ZipFile();
    // Stored entries let the corruption test change payload bytes without breaking inflate.
    for (const file of files) zip.addBuffer(await readFile(join(options.cwd, file)), 'extension/' + (file === 'CHANGELOG.md' ? 'changelog.md' : file), { compress: false });
    if (options.extraTestPayload) zip.addBuffer(Buffer.from('local-only material'), 'extension/' + options.extraTestPayload);
    zip.addBuffer(Buffer.from(`<Identity TargetPlatform="${options.target}" />`), 'extension.vsixmanifest', { compress: false });
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(options.packagePath));
  };
  return { root, app, temporaryRoot, calls, put, pack, build,
    options: { root, temporaryRoot, target: 'all', buildId: 'test-build', log() {}, warn() {}, hooks: { build, pack } } };
}

async function assertClean(f) {
  assert.deepEqual(await readdir(f.temporaryRoot), []);
  assert.deepEqual((await readdir(join(f.root, 'dist/vsix'))).filter(name => name.startsWith('.incoming-')), []);
  assert.equal(await readFile(join(f.app, 'dist/extension.js'), 'utf8'), 'unchanged live build');
  assert.equal((await readdir(f.app)).some(name => name.startsWith('.local-package-')), false);
}

test('only a supported target or all is accepted; arbitrary filenames are rejected', () => {
  assert.equal(parseArguments(['darwin-arm64']), 'darwin-arm64');
  assert.equal(parseArguments(['all']), 'all');
  for (const args of [[], ['linux'], ['darwin-arm64', 'old.vsix'], ['../wrong']]) assert.throws(() => parseArguments(args), /Usage/);
});

test('all builds once in isolation, packages serially, checks every target and publishes a complete set', async t => {
  const f = await fixture(t);
  const result = await packageVsix(f.options);
  assert.deepEqual(f.calls, ['build', 'darwin-arm64', 'win32-x64', 'linux-x64']);
  assert.deepEqual((await readdir(result.destination)).sort(), ['SHA256SUMS', 'c-repair-1.2.3-darwin-arm64.vsix', 'c-repair-1.2.3-linux-x64.vsix', 'c-repair-1.2.3-win32-x64.vsix', 'manifest.json']);
  const manifest = JSON.parse(await readFile(join(result.destination, 'manifest.json')));
  assert.equal(manifest.buildId, 'test-build');
  assert.equal(manifest.artifacts.length, 3);
  const sums = await readFile(join(result.destination, 'SHA256SUMS'), 'utf8');
  for (const entry of manifest.artifacts) {
    assert.deepEqual(await fingerprint(join(result.destination, entry.file)), { sha256: entry.sha256, size: entry.size });
    assert.ok(sums.includes(`${entry.sha256}  ${entry.file}\n`));
  }
  await assertClean(f);
});

test('an existing output, including an empty directory, is never replaced', async t => {
  const f = await fixture(t);
  const destination = join(f.root, 'dist/vsix/dev/test-build');
  await mkdir(destination, { recursive: true });
  await assert.rejects(packageVsix(f.options), /refusing to overwrite/);
  assert.deepEqual(await readdir(destination), []);
  assert.deepEqual(f.calls, []);
  await assertClean(f);
});

test('Mac packaging does not require the Linux engine archive', async t => {
  const f = await fixture(t);
  await rm(join(f.app, 'engine-dist'), { recursive: true });
  f.options.target = 'darwin-arm64';
  const result = await packageVsix(f.options);
  assert.deepEqual(f.calls, ['build', 'darwin-arm64']);
  assert.deepEqual(result.manifest.artifacts.map(entry => entry.target), ['darwin-arm64']);
  await assertClean(f);
});

test('a local lock rejects a second build; it does not remove the first build lock', async t => {
  const f = await fixture(t);
  let locked;
  f.options.hooks.build = async options => {
    const lock = (await readdir(f.temporaryRoot)).find(name => name.startsWith('crepair-vsix-lock-'));
    await assert.rejects(packageVsix({ ...f.options, buildId: 'second-build' }), /Another package build is active/);
    assert.ok((await readdir(f.temporaryRoot)).includes(lock)); locked = true;
    await f.build(options);
  };
  await packageVsix(f.options);
  assert.equal(locked, true);
  await assertClean(f);
});

test('a failed build cleans temporary work and produces no completed output', async t => {
  const f = await fixture(t);
  f.options.hooks.build = async () => { throw new Error('original build failure'); };
  await assert.rejects(packageVsix(f.options), /original build failure/);
  assert.deepEqual(await readdir(join(f.root, 'dist/vsix')), []);
  await assertClean(f);
});

test('cleanup failure is reported without masking the original error', async t => {
  const f = await fixture(t);
  const warnings = [];
  f.options.warn = warning => warnings.push(warning);
  f.options.hooks.build = async () => { throw new Error('primary failure'); };
  f.options.hooks.cleanup = async path => { if (!path.includes('-lock-')) throw new Error('cleanup blocked'); await rm(path, { recursive: true }); };
  await assert.rejects(packageVsix(f.options), /primary failure/);
  assert.ok(warnings.some(warning => warning.includes('cleanup blocked')));
  assert.equal((await readdir(f.temporaryRoot)).some(name => name.includes('-lock-')), false);
});

test('an incomplete or CRC-corrupted VSIX is rejected before transfer', async t => {
  for (const corruption of ['truncate', 'crc']) {
    const f = await fixture(t);
    f.options.target = 'darwin-arm64';
    f.options.hooks.pack = async options => {
      await f.pack(options);
      const buffer = await readFile(options.packagePath);
      if (corruption === 'truncate') await writeFile(options.packagePath, buffer.subarray(0, buffer.length - 80));
      else {
        const at = buffer.indexOf(Buffer.from('isolated fresh bundle'));
        assert.ok(at >= 0); buffer[at] ^= 1; await writeFile(options.packagePath, buffer);
      }
    };
    await assert.rejects(packageVsix(f.options), corruption === 'crc' ? /CRC\/size mismatch/ : /central directory|zip|signature/i);
    assert.deepEqual(await readdir(join(f.root, 'dist/vsix')), []);
    await assertClean(f);
  }
});

test('a package with another target is rejected even with a valid ZIP', async t => {
  const f = await fixture(t);
  f.options.target = 'darwin-arm64';
  f.options.hooks.pack = options => f.pack({ ...options, target: 'win32-x64' });
  await assert.rejects(packageVsix(f.options), /target mismatch/);
  await assertClean(f);
});

test('invalid bridge wheels or Linux engine archives cannot be packaged', async t => {
  for (const payload of ['bridge-dist/test.whl', 'engine-dist/engine.tar.gz']) {
    const f = await fixture(t);
    await f.put(payload, 'corrupted');
    await assert.rejects(packageVsix(f.options), /wheel mismatch|engine mismatch/);
    assert.deepEqual(f.calls, []);
    await assertClean(f);
  }
});

test('failed destination copy removes only the owned incoming set', async t => {
  const f = await fixture(t);
  f.options.target = 'darwin-arm64';
  f.options.hooks.copySet = async (source, destination) => {
    const name = (await readdir(source)).find(name => name.endsWith('.vsix'));
    await cp(join(source, name), join(destination, name));
    throw new Error('transfer stopped');
  };
  await assert.rejects(packageVsix(f.options), /transfer stopped/);
  assert.deepEqual(await readdir(join(f.root, 'dist/vsix')), []);
  await assertClean(f);
});

test('copied bytes are checked before exposing the completed directory', async t => {
  const f = await fixture(t);
  f.options.target = 'darwin-arm64';
  f.options.hooks.copySet = async (source, destination, options) => {
    await cp(source, destination, options);
    const name = (await readdir(destination)).find(name => name.endsWith('.vsix'));
    await writeFile(join(destination, name), 'incomplete synchronized file');
  };
  await assert.rejects(packageVsix(f.options), /Transfer verification failed/);
  assert.deepEqual(await readdir(join(f.root, 'dist/vsix')), []);
  await assertClean(f);
});

test('an earlier incoming set is warned about and never overwritten or deleted', async t => {
  const f = await fixture(t);
  f.options.target = 'darwin-arm64';
  const incoming = join(f.root, 'dist/vsix/.incoming-test-build');
  await mkdir(incoming, { recursive: true }); await writeFile(join(incoming, 'keep'), 'older transfer');
  const warnings = []; f.options.warn = warning => warnings.push(warning);
  await assert.rejects(packageVsix(f.options), /EEXIST/);
  assert.equal(await readFile(join(incoming, 'keep'), 'utf8'), 'older transfer');
  assert.ok(warnings.some(warning => warning.includes('Incomplete earlier transfer')));
  assert.deepEqual(await readdir(f.temporaryRoot), []);
});

test('unsafe build IDs are rejected before touching outputs', async t => {
  const f = await fixture(t);
  await assert.rejects(packageVsix({ ...f.options, buildId: '../replace' }), /Invalid build ID/);
  assert.deepEqual(await readdir(f.temporaryRoot), []);
});

test('either missing common-guide language prevents exposing a completed package set', async t => {
  for (const guide of ['user-guide.md', 'user-guide.ja.md']) {
    const f = await fixture(t);
    f.options.target = 'darwin-arm64';
    await rm(join(f.app, 'docs', guide));
    await assert.rejects(packageVsix(f.options), /ENOENT/);
    assert.deepEqual(await readdir(join(f.root, 'dist/vsix')), []);
    await assertClean(f);
  }
});

test('local C fixtures, desktop metadata and unselected screenshots cannot become release payloads', async t => {
  for (const name of ['sample_sensor.c', 'quick-start.c', 'resources/other.c', 'resources/nested/quick-start.c', '.DS_Store', 'スクリーンショット-test.png']) {
    const f = await fixture(t);
    f.options.target = 'darwin-arm64';
    f.options.hooks.pack = options => f.pack({ ...options, extraTestPayload: name });
    await assert.rejects(packageVsix(f.options), /Unexpected VSIX member/);
    assert.deepEqual(await readdir(join(f.root, 'dist/vsix')), []);
    await assertClean(f);
  }
});
