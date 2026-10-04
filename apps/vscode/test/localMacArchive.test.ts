import { prepareMacEngine, MAC_ENGINE } from '../src/bridge/localMacEngine';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('Mac archive aliases are copied safely; escaping and cyclic aliases are rejected', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-mac-archive-'));
  try {
    for (const kind of ['valid', 'escape', 'cycle']) {
      const archive = path.join(dir, kind + '.tar.gz');
      await exec('python3', ['-c', `import tarfile,io,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 for name in ['llama-server','libggml-metal.1.dylib']:
  i=tarfile.TarInfo('release/'+name); i.size=4; t.addfile(i,io.BytesIO(b'data'))
 i=tarfile.TarInfo('release/libggml-metal.0.dylib');i.type=tarfile.SYMTYPE
 i.linkname={'valid':'libggml-metal.1.dylib','escape':'../../outside','cycle':'libggml-metal.0.dylib'}[sys.argv[2]]
 t.addfile(i)`, archive, kind]);
      const dest = path.join(dir, kind);
      const run = exec('python3', [path.resolve('resources/install-mac-engine.py'), archive, dest, 'release']);
      if (kind === 'valid') {
        await run;
        const file = path.join(dest, 'engine', 'libggml-metal.0.dylib');
        assert.equal(await fs.readFile(file, 'utf8'), 'data');
        assert.equal((await fs.lstat(file)).isSymbolicLink(), false);
      } else await assert.rejects(run, /Invalid Mac engine archive link/);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test('Mac preparation checks Metal, caches success, and cleans up a failed install', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-mac-install-'));
  let runs = 0;
  const run = async (_file: string, args: string[]) => {
    runs++;
    if (args[0] === '--list-devices') return { stdout: 'Metal: Apple M4', stderr: '' };
    const engine = path.join(args[2], 'engine');
    await fs.mkdir(engine, { recursive: true });
    await fs.writeFile(path.join(engine, 'llama-server'), 'fixture');
    return { stdout: '', stderr: '' };
  };
  try {
    const deps = { download: async () => '/fixture/archive', run };
    const file = await prepareMacEngine(dir, '/extension', '/python', () => {}, undefined, deps);
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture');
    await prepareMacEngine(dir, '/extension', '/python', () => {}, undefined, deps);
    assert.equal(runs, 2);
    const failure = path.join(dir, 'failure');
    await assert.rejects(prepareMacEngine(failure, '/extension', '/python', () => {}, undefined, {
      ...deps, run: async (file, args) => args[0] === '--list-devices' ? { stdout: 'CPU: Apple M4', stderr: '' } : run(file, args),
    }), /did not report a Metal GPU/);
    await assert.rejects(fs.access(path.join(failure, 'local-engines', MAC_ENGINE.id)));
    await assert.rejects(fs.access(path.join(failure, 'local-engines', MAC_ENGINE.id + '.staging')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
