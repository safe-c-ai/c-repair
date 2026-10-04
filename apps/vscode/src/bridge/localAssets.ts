// Verified, resumable downloads shared by the setup wizard and engine preparation.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
export interface Asset { url: string; sha256: string; bytes: number; filename: string }
export async function sha256(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
export async function withAssetLock<T>(dir: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, '.install.lock');
  let handle;
  while (!handle) {
    signal?.throwIfAborted();
    try { handle = await fs.open(lock, 'wx'); await handle.writeFile(String(process.pid)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const owner = Number(await fs.readFile(lock, 'utf8'));
        if (owner > 0) {
          try { process.kill(owner, 0); }
          catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(lock); continue; } }
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      await new Promise(r => setTimeout(r, 250));
    }
  }
  try { return await fn(); } finally { await handle.close(); await fs.rm(lock, { force: true }); }
}
export async function downloadAsset(asset: Asset, dir: string, progress: (message: string) => void = () => {}, signal?: AbortSignal): Promise<string> {
  if (!/^https:\/\//.test(asset.url) || !/^[a-f0-9]{64}$/.test(asset.sha256) || path.basename(asset.filename) !== asset.filename || ['.', '..'].includes(asset.filename) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw new Error('Invalid download manifest.');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, asset.filename), part = file + '.part';
  try {
    if ((await fs.stat(file)).size === asset.bytes && await sha256(file, signal) === asset.sha256) return file;
    await fs.rm(file, { force: true });
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  let offset = 0;
  try { offset = (await fs.stat(part)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (offset > asset.bytes) { await fs.rm(part); offset = 0; }
  if (offset < asset.bytes) {
    // Reset the timeout on each chunk so large downloads can keep making progress.
    let stalled: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error('Download timed out.'));
    const resetTimeout = () => { clearTimeout(stalled); stalled = setTimeout(() => controller.abort(new Error('Download stalled. Retry setup to resume.')), 60000); };
    signal?.addEventListener('abort', abort, { once: true });
    resetTimeout();
    try {
      signal?.throwIfAborted();
      const response = await fetch(asset.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: controller.signal });
      if (!response.ok || !response.body || (response.url && !response.url.startsWith('https://'))) throw new Error(`Download failed (HTTP ${response.status}). Retry setup to resume.`);
      if (response.status === 206) {
        const range = response.headers.get('content-range');
        if (!range?.startsWith(`bytes ${offset}-`) || !range.endsWith(`/${asset.bytes}`)) throw new Error('Download returned an inconsistent byte range.');
      } else { if (response.status !== 200) throw new Error('Unexpected download response.'); offset = 0; }
      const out = await fs.open(part, offset ? 'a' : 'w');
      const reader = response.body.getReader();
      let total = offset, lastUpdate = 0;
      try {
        while (true) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read(); if (done) break;
          resetTimeout();
          total += value.byteLength;
          if (total > asset.bytes) throw new Error('Download exceeds the verified size.');
          let written = 0;
          while (written < value.byteLength) written += (await out.write(value, written, value.byteLength - written)).bytesWritten;
          if (Date.now() - lastUpdate > 500) { progress(`${asset.filename}: ${(100 * total / asset.bytes).toFixed(0)}%`); lastUpdate = Date.now(); }
        }
      } finally { await reader.cancel().catch(() => {}); await out.close(); }
    } finally { signal?.removeEventListener('abort', abort); clearTimeout(stalled!); }
  }
  progress(`Verifying ${asset.filename}…`);
  if ((await fs.stat(part)).size !== asset.bytes) throw new Error('Download incomplete. Retry setup to resume.');
  if (await sha256(part, signal) !== asset.sha256) { await fs.rm(part, { force: true }); throw new Error('Download checksum mismatch. Retry setup to download a fresh copy.'); }
  signal?.throwIfAborted();
  await fs.rename(part, file);
  return file;
}
