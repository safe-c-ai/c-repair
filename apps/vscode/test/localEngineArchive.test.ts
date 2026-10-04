import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('engine extraction rejects traversal and links without writing outside staging', { skip: process.platform !== 'linux' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-engine-archive-'));
  const installer = path.resolve('resources/install-local-engine.py');
  try {
    for (const kind of ['traversal', 'symlink']) {
      const bundle = path.join(dir, `${kind}.tar.gz`);
      await exec('python3', ['-c', `import tarfile,io,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 i=tarfile.TarInfo('../escaped' if sys.argv[2]=='traversal' else 'engine/linked')
 if sys.argv[2]=='symlink': i.type=tarfile.SYMTYPE; i.linkname='../../escaped'
 else: i.size=1
 t.addfile(i,io.BytesIO(b'x'))`, bundle, kind]);
      await assert.rejects(exec('python3', [installer, bundle, path.join(dir, kind)]), /Invalid engine archive entry/);
      await assert.rejects(fs.access(path.join(dir, 'escaped')));
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('bundled library aliases share the extracted regular file', { skip: process.platform !== 'linux' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-engine-alias-'));
  try {
    const bundle = path.join(dir, 'engine.tar.gz');
    await exec('python3', ['-c', `import tarfile,io,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 i=tarfile.TarInfo('engine/libggml.so.0.1');i.size=4;t.addfile(i,io.BytesIO(b'data'))
 i=tarfile.TarInfo('engine/libggml.so.0');i.type=tarfile.SYMTYPE;i.linkname='libggml.so.0.1';t.addfile(i)`, bundle]);
    const dest = path.join(dir, 'installed');
    await exec('python3', [path.resolve('resources/install-local-engine.py'), bundle, dest]);
    const a = await fs.lstat(path.join(dest, 'engine/libggml.so.0'));
    const b = await fs.stat(path.join(dest, 'engine/libggml.so.0.1'));
    assert.equal(a.isSymbolicLink(), false); assert.equal(a.ino, b.ino);
    assert.equal(await fs.readFile(path.join(dest, 'engine/libggml.so.0'), 'utf8'), 'data');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
