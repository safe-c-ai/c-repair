// Build and verify a complete development VSIX set outside the source tree.
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdtemp, mkdir, cp, rm, rename, lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildExtension } from '../apps/vscode/esbuild.mjs';

const require = createRequire(import.meta.url);
const vsce = require('@vscode/vsce');
const yauzl = require('yauzl');
const repository = fileURLToPath(new URL('../', import.meta.url));
export const targets = ['darwin-arm64', 'win32-x64', 'linux-x64'];
const mlxFiles = ['mlx-server.py', 'install-mlx-uv.py', 'local-mlx-uv.json', 'mlx-requirements.txt', 'local-mlx-models.json'];
const remove = path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function parseArguments(args) {
  if (args.length !== 1 || ![...targets, 'all'].includes(args[0])) {
    throw new Error('Usage: npm run package:vsix -- <darwin-arm64|win32-x64|linux-x64|all>');
  }
  return args[0];
}

export function targetIgnore(base, selected) {
  return base + '\ndist/**\n' + (selected.includes('linux-x64') ? '' : 'engine-dist/**\n')
    + (selected.includes('darwin-arm64') ? '' : mlxFiles.map(file => `resources/${file}\n`).join(''));
}

export async function fingerprint(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function verifyInput(stage, selected) {
  const manifest = JSON.parse(await readFile(join(stage, 'bridge-dist/MANIFEST.json'), 'utf8'));
  for (const entry of manifest.files) {
    if (entry.file !== entry.file.split(/[\\/]/).pop()) throw new Error('Invalid bridge wheel filename');
    const actual = await fingerprint(join(stage, 'bridge-dist', entry.file));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error(`Bridge wheel mismatch: ${entry.file}`);
  }
  if (selected.includes('linux-x64')) {
    const engine = JSON.parse(await readFile(join(stage, 'resources/local-engine.json'), 'utf8'));
    if (engine.bundle !== engine.bundle.split(/[\\/]/).pop()) throw new Error('Invalid engine bundle filename');
    const actual = await fingerprint(join(stage, 'engine-dist', engine.bundle));
    if (actual.size !== engine.bytes || actual.sha256 !== engine.sha256) throw new Error('Bundled Linux engine mismatch. Run tools/build-local-engine.py.');
  }
}

// Stream every ZIP member: reject truncation, wrong CRC, duplicate entries and target leaks.
export async function verifyVsix(file, stage, target, manifest) {
  const expected = new Map();
  const bridge = JSON.parse(await readFile(join(stage, 'bridge-dist/MANIFEST.json'), 'utf8'));
  for (const entry of bridge.files) expected.set(`extension/bridge-dist/${entry.file}`, entry);
  const sourceFiles = ['dist/extension.js', 'bridge-dist/MANIFEST.json', 'resources/quick-start.c', 'docs/local-models.md', 'docs/local-models.ja.md', 'docs/user-guide.md', 'docs/user-guide.ja.md'];
  if (target === 'darwin-arm64') sourceFiles.push(...mlxFiles.map(name => `resources/${name}`));
  if (target === 'linux-x64') {
    const engine = JSON.parse(await readFile(join(stage, 'resources/local-engine.json'), 'utf8'));
    expected.set(`extension/engine-dist/${engine.bundle}`, { sha256: engine.sha256, size: engine.bytes });
  }
  for (const name of sourceFiles) expected.set(`extension/${name}`, await fingerprint(join(stage, name)));
  // vsce normalizes this filename; its links are absolute, so the body is unchanged.
  expected.set('extension/changelog.md', await fingerprint(join(stage, 'CHANGELOG.md')));
  await new Promise((resolveZip, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) { reject(error); return; }
      const names = new Set();
      let packageJson, xml;
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('entry', async entry => {
        try {
          const name = entry.fileName;
          if (names.has(name)) throw new Error(`Duplicate VSIX entry: ${name}`);
          names.add(name);
          if ((name.startsWith('extension/engine-dist/') && target !== 'linux-x64')
            || (mlxFiles.some(file => name === `extension/resources/${file}`) && target !== 'darwin-arm64')
            || /(?:^|\/)\.(?:local|mac)-package-/.test(name) || name.endsWith('.vsix') || name.endsWith('.vsix.sha256')
            || (name.endsWith('.c') && name !== 'extension/resources/quick-start.c') || name.endsWith('.DS_Store')
            || /(?:^|\/)スクリーンショット[^/]*\.png$/.test(name)) {
            throw new Error(`Unexpected VSIX member for ${target}: ${name}`);
          }
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (err, value) => err ? rej(err) : res(value)));
          const hash = createHash('sha256');
          let crc = -1, size = 0;
          const chunks = [];
          const capture = ['extension/package.json', 'extension.vsixmanifest'].includes(name);
          for await (const chunk of stream) {
            hash.update(chunk); size += chunk.length;
            for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
            if (capture) {
              if (size > 1024 * 1024) throw new Error(`Oversized VSIX metadata: ${name}`);
              chunks.push(chunk);
            }
          }
          if (((crc ^ -1) >>> 0) !== entry.crc32 || size !== entry.uncompressedSize) throw new Error(`VSIX CRC/size mismatch: ${name}`);
          const digest = hash.digest('hex');
          if (expected.has(name)) {
            const wanted = expected.get(name);
            if (wanted.sha256 !== digest || wanted.size !== size) throw new Error(`VSIX payload mismatch: ${name}`);
          }
          if (capture && name === 'extension/package.json') packageJson = JSON.parse(Buffer.concat(chunks).toString());
          if (capture && name === 'extension.vsixmanifest') xml = Buffer.concat(chunks).toString();
          zip.readEntry();
        } catch (error) { fail(error); }
      });
      zip.on('end', () => {
        try {
          for (const name of expected.keys()) if (!names.has(name)) throw new Error(`Missing VSIX member: ${name}`);
          if (packageJson?.name !== manifest.name || packageJson?.version !== manifest.version || packageJson?.publisher !== manifest.publisher) throw new Error('VSIX identity/version mismatch');
          if (!xml?.includes(`TargetPlatform="${target}"`)) throw new Error(`VSIX target mismatch: ${target}`);
          resolveZip();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
  });
}

function sourceInfo(root) {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    return { commit, dirty: status.length !== 0 };
  } catch { return { commit: null, dirty: null }; }
}

export async function packageVsix({ target, root = repository, outputRoot = join(root, 'dist/vsix'),
  temporaryRoot = tmpdir(), buildId = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(4).toString('hex'),
  hooks = {}, log = console.log, warn = console.warn } = {}) {
  parseArguments([target]);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(buildId)) throw new Error('Invalid build ID');
  const selected = target === 'all' ? targets : [target];
  const app = join(root, 'apps/vscode');
  const destination = join(outputRoot, 'dev', buildId);
  const lock = join(temporaryRoot, 'crepair-vsix-lock-' + createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 16));
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another package build is active. Lock: ${lock}. Remove it only after confirming that build has stopped.`);
    throw error;
  }
  let work, incoming;
  const cleanup = hooks.cleanup ?? remove;
  const safeCleanup = async path => {
    if (path) try { await cleanup(path); } catch (error) { warn(`Cleanup failed; remove after the build: ${path} (${error.message})`); }
  };
  try {
    if (await exists(destination)) throw new Error(`Output already exists; refusing to overwrite: ${destination}`);
    await mkdir(outputRoot, { recursive: true });
    for (const entry of await readdir(outputRoot)) if (entry.startsWith('.incoming-')) warn(`Incomplete earlier transfer: ${join(outputRoot, entry)}. Inspect before removing it.`);
    work = await mkdtemp(join(temporaryRoot, 'crepair-vsix-'));
    const stage = join(work, 'extension');
    const completed = join(work, 'completed');
    await mkdir(stage); await mkdir(completed);
    const original = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    if (!/^[\w-]+$/.test(original.name) || !/^\d+\.\d+\.\d+$/.test(original.version)) throw new Error('Expected an extension name and numeric package.json version');
    const ignoreBase = await readFile(join(app, '.vscodeignore'), 'utf8');
    const ignoreSnapshot = join(work, 'snapshot-ignore');
    await writeFile(ignoreSnapshot, targetIgnore(ignoreBase, selected));
    const listFiles = hooks.listFiles ?? vsce.listFiles;
    const files = await listFiles({ cwd: app, packageManager: vsce.PackageManager.None, ignoreFile: ignoreSnapshot });
    for (const name of files.sort()) {
      if (isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error(`Invalid package input: ${name}`);
      if (name.replaceAll('\\', '/').startsWith('dist/')) continue;
      const dest = join(stage, name);
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(app, name), dest, { errorOnExist: true, force: false });
    }
    const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
    if (manifest.version !== original.version) throw new Error('package.json changed while staging; retry after source synchronization');
    await verifyInput(stage, selected);
    await (hooks.build ?? buildExtension)({ outfile: join(stage, 'dist/extension.js'), sourcemap: false });
    const inputHash = createHash('sha256');
    const stagedFiles = [...files.filter(name => !name.replaceAll('\\', '/').startsWith('dist/')), 'dist/extension.js'].sort();
    for (const name of stagedFiles) {
      const digest = await fingerprint(join(stage, name));
      inputHash.update(`${name.replaceAll('\\', '/')}\0${digest.sha256}\0${digest.size}\n`);
    }
    const artifacts = [];
    for (const platform of selected) {
      const ignore = join(work, `${platform}-ignore`);
      // Include the freshly isolated bundle, then apply only platform exclusions.
      await writeFile(ignore, targetIgnore(ignoreBase, [platform]).replace('\ndist/**\n', '\n'));
      const filename = `${manifest.name}-${manifest.version}-${platform}.vsix`;
      const file = join(completed, filename);
      await (hooks.pack ?? vsce.createVSIX)({ cwd: stage, target: platform, packagePath: file,
        dependencies: false, ignoreFile: ignore,
        baseContentUrl: 'https://github.com/safe-c-ai/c-repair/blob/main/apps/vscode',
        baseImagesUrl: 'https://raw.githubusercontent.com/safe-c-ai/c-repair/main/apps/vscode' });
      await verifyVsix(file, stage, platform, manifest);
      artifacts.push({ file: filename, target: platform, ...await fingerprint(file) });
    }
    const record = { format: 1, buildId, version: manifest.version, builtAt: new Date().toISOString(),
      source: { ...sourceInfo(root), packagedInputSha256: inputHash.digest('hex'),
        note: 'Identifies staged package inputs, not a reproducible source snapshot.' },
      tools: { node: process.version, vsce: require('@vscode/vsce/package.json').version, esbuild: require('esbuild/package.json').version }, artifacts };
    await writeFile(join(completed, 'manifest.json'), JSON.stringify(record, null, 2) + '\n');
    await writeFile(join(completed, 'SHA256SUMS'), artifacts.map(entry => `${entry.sha256}  ${entry.file}\n`).join(''));
    // Copy onto the destination filesystem first: OS tmp and Dropbox may be different mounts.
    const candidate = join(outputRoot, `.incoming-${buildId}`);
    await mkdir(candidate); // Exclusive; never take ownership of an earlier incoming set.
    incoming = candidate;
    await (hooks.copySet ?? cp)(completed, incoming, { recursive: true, errorOnExist: true, force: false });
    for (const entry of artifacts) {
      const actual = await fingerprint(join(incoming, entry.file));
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error(`Transfer verification failed: ${entry.file}`);
    }
    for (const name of ['manifest.json', 'SHA256SUMS']) {
      if (!((await readFile(join(completed, name))).equals(await readFile(join(incoming, name))))) throw new Error(`Transfer verification failed: ${name}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    if (await exists(destination)) throw new Error(`Output already exists; refusing to overwrite: ${destination}`);
    await rename(incoming, destination);
    incoming = undefined;
    log(`Ready: ${destination}`);
    for (const entry of artifacts) log(`  ${entry.file}`);
    return { destination, manifest: record };
  } finally {
    await safeCleanup(incoming);
    await safeCleanup(work);
    await safeCleanup(lock);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await packageVsix({ target: parseArguments(process.argv.slice(2)) }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
