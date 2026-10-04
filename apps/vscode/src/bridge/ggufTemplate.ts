import * as path from 'node:path';
import { open, readFile, stat } from 'node:fs/promises';

const MAX_METADATA = 128 * 1024 * 1024;
const MAX_TEMPLATE = 2 * 1024 * 1024;
/** Read metadata only, never tensors or executable template code. Bounded reads
 * and buffered seeks keep large tokenizer string arrays inexpensive. */
export async function readGgufTemplate(filename: string): Promise<string> {
  const file = await open(filename, 'r');
  try {
    const size = (await file.stat()).size;
    let pos = 0, base = -1, cache = Buffer.alloc(0), budget = 2_000_000;
    const limit = Math.min(size, MAX_METADATA);
    const check = (n: number) => { if (!Number.isSafeInteger(n) || n < 0 || pos + n > limit) throw new Error('Invalid or excessive GGUF metadata'); };
    async function bytes(n: number): Promise<Buffer> {
      check(n);
      if (pos < base || pos + n > base + cache.length) {
        cache = Buffer.alloc(Math.min(Math.max(65536, n), limit - pos)); base = pos;
        const result = await file.read(cache, 0, cache.length, base);
        cache = cache.subarray(0, result.bytesRead);
      }
      if (pos + n > base + cache.length) throw new Error('Truncated GGUF');
      const result = cache.subarray(pos - base, pos - base + n); pos += n; return result;
    }
    const u32 = async () => (await bytes(4)).readUInt32LE();
    const u64 = async () => { const n = Number((await bytes(8)).readBigUInt64LE()); if (!Number.isSafeInteger(n)) throw new Error('Invalid GGUF length'); return n; };
    const skip = (n: number) => { check(n); pos += n; };
    const text = async (max: number) => { const n = await u64(); if (n > max) throw new Error('GGUF string too large'); return (await bytes(n)).toString('utf8'); };
    const sizes: Record<number, number> = { 0:1, 1:1, 2:2, 3:2, 4:4, 5:4, 6:4, 7:1, 10:8, 11:8, 12:8 };
    async function skipValue(type: number, depth = 0): Promise<void> {
      if (--budget < 0 || depth > 8) throw new Error('Excessive GGUF metadata');
      if (type === 8) skip(await u64());
      else if (type === 9) {
        const sub = await u32(), count = await u64();
        if (sizes[sub]) skip(sizes[sub] * count);
        else { if (count > budget) throw new Error('Excessive GGUF array'); for (let i = 0; i < count; i++) await skipValue(sub, depth + 1); }
      } else if (sizes[type]) skip(sizes[type]);
      else throw new Error('Unknown GGUF metadata type');
    }
    if ((await bytes(4)).toString() !== 'GGUF' || ![2,3].includes(await u32())) throw new Error('Unsupported GGUF');
    await u64(); const count = await u64();
    if (count > 100000) throw new Error('Excessive GGUF metadata');
    for (let i = 0; i < count; i++) {
      const key = await text(4096), type = await u32();
      if (key === 'tokenizer.chat_template' && type === 8) return text(MAX_TEMPLATE);
      await skipValue(type);
    }
    throw new Error('No default chat template in GGUF');
  } finally { await file.close(); }
}

export async function readSelectedTemplate(modelPath: string, templatePath?: string): Promise<string> {
  if (!templatePath && (await stat(modelPath)).isDirectory()) {
    const file = path.join(modelPath,'chat_template.jinja');
    if (await stat(file).then(s=>s.isFile(),()=>false)) return readSelectedTemplate('',file);
    const configPath = path.join(modelPath,'tokenizer_config.json');
    if ((await stat(configPath)).size > MAX_METADATA) throw new Error('Tokenizer config too large');
    const t = JSON.parse(await readFile(configPath,'utf8')).chat_template;
    if (typeof t !== 'string' || t.length > MAX_TEMPLATE) throw new Error('No default MLX template');
    return t;
  }
  if (!templatePath) return readGgufTemplate(modelPath);
  if ((await stat(templatePath)).size > MAX_TEMPLATE) throw new Error('Template too large');
  return readFile(templatePath, 'utf8');
}
