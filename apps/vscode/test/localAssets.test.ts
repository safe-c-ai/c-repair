import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadAsset, withAssetLock } from '../src/bridge/localAssets';
const bytes = new TextEncoder().encode('abcdef');
const asset = { url: 'https://example.test/model', filename: 'model.gguf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

test('verified download is cached; damaged cache is replaced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-assets-'));
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(bytes); };
  try {
    const file = await downloadAsset(asset, dir);
    assert.equal(await fs.readFile(file, 'utf8'), 'abcdef');
    await downloadAsset(asset, dir); assert.equal(calls, 1);
    await fs.writeFile(file, 'broken'); await downloadAsset(asset, dir); assert.equal(calls, 2);
  } finally { globalThis.fetch = original; await fs.rm(dir, { recursive: true, force: true }); }
});

test('cancel preserves partial file and range retry verifies the complete model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-resume-'));
  const original = globalThis.fetch; const abort = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 2)); } }));
  try {
    await assert.rejects(downloadAsset(asset, dir, () => abort.abort(), abort.signal), { name: 'AbortError' });
    assert.equal((await fs.stat(path.join(dir, 'model.gguf.part'))).size, 2);
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('range'), 'bytes=2-');
      return new Response(bytes.slice(2), { status: 206, headers: { 'content-range': 'bytes 2-5/6' } });
    };
    assert.equal(await fs.readFile(await downloadAsset(asset, dir), 'utf8'), 'abcdef');
  } finally { globalThis.fetch = original; await fs.rm(dir, { recursive: true, force: true }); }
});

test('checksum failure never promotes the download; retry starts clean', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-hash-'));
  const original = globalThis.fetch; globalThis.fetch = async () => new Response('xxxxxx');
  try {
    await assert.rejects(downloadAsset(asset, dir), /checksum/);
    assert.deepEqual(await fs.readdir(dir), []);
    await assert.rejects(downloadAsset({ ...asset, filename: '../escape' }, dir), /manifest/);
  } finally { globalThis.fetch = original; await fs.rm(dir, { recursive: true, force: true }); }
});

test('installation lock serializes concurrent windows and releases on failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-lock-'));
  const order: string[] = [];
  try {
    const first = withAssetLock(dir, async () => { order.push('first'); await new Promise(r => setTimeout(r, 50)); order.push('end'); });
    await new Promise(r => setTimeout(r, 10));
    const second = withAssetLock(dir, async () => { order.push('second'); });
    await Promise.all([first, second]); assert.deepEqual(order, ['first', 'end', 'second']);
    await assert.rejects(withAssetLock(dir, async () => { throw new Error('failed'); }));
    await withAssetLock(dir, async () => order.push('released'));
    assert.equal(order.at(-1), 'released');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
