import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('release installer rejects traversal, duplicate DLLs and cyclic TAR links', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-release-archive-'));
  try {
    for (const kind of ['valid', 'traversal', 'backslash', 'duplicate', 'cycle']) {
      const archive = path.join(dir, kind + (kind === 'cycle' ? '.tar.gz' : '.zip'));
      await exec('python3', ['-c', `import sys,zipfile,tarfile,io
p,kind=sys.argv[1:]
if kind=='cycle':
 with tarfile.open(p,'w:gz') as t:
  i=tarfile.TarInfo('release/llama-server');i.size=4;t.addfile(i,io.BytesIO(b'data'))
  i=tarfile.TarInfo('release/libggml.so');i.type=tarfile.SYMTYPE;i.linkname='libggml.so';t.addfile(i)
else:
 with zipfile.ZipFile(p,'w') as z:
  z.writestr('llama-server.exe','server')
  z.writestr({'valid':'ggml.dll','traversal':'../bad.dll','backslash':r'..\\bad.dll','duplicate':'a/llama-server.exe'}[kind],'data')`, archive, kind]);
      const dest = path.join(dir, kind);
      const result = exec('python3', [path.resolve('resources/install-release-engine.py'), dest, archive]);
      if (kind === 'valid') { await result; assert.equal(await fs.readFile(path.join(dest, 'engine', 'ggml.dll'), 'utf8'), 'data'); }
      else await assert.rejects(result, /Invalid|Duplicate|Cyclic/);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
