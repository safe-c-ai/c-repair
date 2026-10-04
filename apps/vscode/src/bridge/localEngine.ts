import { detectEngineTarget } from './localEngineHost';
import { prepareReleaseEngine } from './localReleaseEngine';
import { prepareMacEngine, supportedMacOS } from './localMacEngine';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import manifest from '../../resources/local-engine.json';
import { downloadAsset, sha256, withAssetLock } from './localAssets';
const exec = promisify(execFile);
export const LOCAL_ENGINE = manifest;
export function engineEnv(executable: string): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return { ...process.env };
  return { ...process.env, LD_LIBRARY_PATH: [path.dirname(executable), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
}
export async function checkAutomaticEngineHost(signal?: AbortSignal, gpuLayers?: number): Promise<void> {
  const target = await detectEngineTarget(signal, gpuLayers);
  if (target === 'mac') {
    const version = (await exec('/usr/bin/sw_vers', ['-productVersion'], { signal, timeout: 5000 })).stdout;
    if (!supportedMacOS(version)) throw new Error('Automatic Apple Silicon setup requires macOS 13.3 or later. Select a compatible engine in Advanced settings for older macOS.');
  } else if (target === 'linux-cuda') {
    const cpu = await fs.readFile('/proc/cpuinfo', 'utf8');
    if (!/\bavx2\b/.test(cpu)) throw new Error('The bundled CUDA engine requires an AVX2 CPU. Select a compatible engine in Advanced settings.');
  }
}
export async function prepareLocalEngine(storageDir: string, extensionDir: string, python: string, progress: (message: string) => void = () => {}, signal?: AbortSignal, gpuLayers?: number): Promise<string> {
  await checkAutomaticEngineHost(signal, gpuLayers);
  const target = await detectEngineTarget(signal, gpuLayers);
  if (target === 'mac') return prepareMacEngine(storageDir, extensionDir, python, progress, signal);
  if (target !== 'linux-cuda') return prepareReleaseEngine(target, storageDir, extensionDir, python, progress, signal);
  const root = path.join(storageDir, 'local-engines');
  return withAssetLock(root, async () => {
    const dest = path.join(root, manifest.id);
    const executable = path.join(dest, 'engine', 'llama-server');
    try {
      const ready = JSON.parse(await fs.readFile(path.join(dest, 'ready.json'), 'utf8'));
      if (ready.sha256 === manifest.sha256 && Array.isArray(ready.files) && ready.files.includes('llama-server') && ready.files.every((f: unknown) => typeof f === 'string' && path.basename(f) === f) && await Promise.all(ready.files.map((f: string) => fs.access(path.join(dest, 'engine', f)))).then(() => true, () => false)) return executable;
    } catch { /* first setup or incomplete cache */ }
    const bundle = path.join(extensionDir, 'engine-dist', manifest.bundle);
    progress('Checking the bundled local engine…');
    if (await sha256(bundle, signal).catch(e => { if (e.code === 'ENOENT') return ''; throw e; }) !== manifest.sha256) throw new Error('The bundled local engine is missing or damaged. Reinstall this development extension or select an engine in Advanced settings.');
    const archives: string[] = [];
    for (const asset of manifest.libraries) archives.push(await downloadAsset(asset, path.join(root, 'downloads'), progress, signal));
    const staging = path.join(root, manifest.id + '.staging');
    await fs.rm(staging, { force: true, recursive: true });
    try {
      progress('Preparing the local engine…');
      await exec(python, [path.join(extensionDir, 'resources', 'install-local-engine.py'), bundle, staging, ...archives], { signal, timeout: 180000, maxBuffer: 4096 });
      const binary = path.join(staging, 'engine', 'llama-server');
      const result = await exec(binary, ['--list-devices'], { env: engineEnv(binary), signal, timeout: 30000, maxBuffer: 16384 });
      if (!/^\s*CUDA\d+\s*:/m.test(result.stdout + result.stderr)) throw new Error('The local engine could not initialize the NVIDIA GPU. Check the driver; CPU fallback was not selected.');
      const files = await fs.readdir(path.join(staging, 'engine'));
      await fs.writeFile(path.join(staging, 'ready.json'), JSON.stringify({ sha256: manifest.sha256, files }));
      await fs.rm(dest, { force: true, recursive: true });
      await fs.rename(staging, dest);
      return executable;
    } finally { await fs.rm(staging, { force: true, recursive: true }); }
  }, signal);
}
