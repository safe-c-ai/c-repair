import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = new URL('../apps/vscode/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('resources/local-engine.json', base), 'utf8'));
const hash = createHash('sha256');
let bytes = 0;
try {
  for await (const chunk of createReadStream(new URL(`engine-dist/${manifest.bundle}`, base))) {
    hash.update(chunk); bytes += chunk.length;
  }
} catch (error) {
  throw new Error('Stage the local engine with tools/build-local-engine.py before packaging.', { cause: error });
}
if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw new Error('Bundled engine does not match resources/local-engine.json. Rebuild the engine archive.');
console.log(`Verified bundled local engine: ${manifest.id}`);
