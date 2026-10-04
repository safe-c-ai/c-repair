import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import releases from '../../resources/local-engine-releases.json';
import { downloadAsset, withAssetLock } from './localAssets';
import type { EngineTarget } from './localEngineHost';
const exec = promisify(execFile);
export function releaseAssets(target: EngineTarget) {
  const names = target === 'linux-cpu' ? ['llama-b10883-bin-ubuntu-x64.tar.gz'] : target === 'windows-cpu' ? ['llama-b10883-bin-win-cpu-x64.zip'] : target === 'windows-cuda12' ? ['llama-b10883-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'] : target === 'windows-cuda13' ? ['llama-b10883-bin-win-cuda-13.3-x64.zip', 'cudart-llama-bin-win-cuda-13.3-x64.zip'] : [];
  if (!names.length) throw new Error('No official release selected for this target.');
  return names.map(n => releases[n as keyof typeof releases]);
}
interface InstallDeps {
  download?: typeof downloadAsset;
  run?: (file: string, args: string[], options: { signal?: AbortSignal; timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<{ stdout: string; stderr: string }>;
}
export async function prepareReleaseEngine(target: EngineTarget, storageDir: string, extensionDir: string, python: string, progress: (s: string) => void, signal?: AbortSignal, deps: InstallDeps = {}): Promise<string> {
  const assets = releaseAssets(target);
  const signature = assets.map(a => a.sha256).join(':');
  const name = target.startsWith('windows') ? 'llama-server.exe' : 'llama-server';
  const root = path.join(storageDir, 'local-engines');
  return withAssetLock(root, async () => {
    const dest = path.join(root, `b10883-${target}`);
    const executable = path.join(dest, 'engine', name);
    try {
      const ready = JSON.parse(await fs.readFile(path.join(dest, 'ready.json'), 'utf8'));
      if (ready.signature === signature && Array.isArray(ready.files) && ready.files.includes(name) && ready.files.every((f: unknown) => typeof f === 'string' && path.basename(f) === f)) {
        await Promise.all(ready.files.map((f: string) => fs.access(path.join(dest, 'engine', f))));
        return executable;
      }
    } catch { /* missing or incomplete cache */ }
    progress(`Preparing ${target.includes('cuda') ? 'NVIDIA CUDA' : 'CPU'} inference engine…`);
    const archives = [];
    for (const a of assets) archives.push(await (deps.download ?? downloadAsset)(a, path.join(root, 'downloads'), progress, signal));
    const staging = dest + '.staging';
    await fs.rm(staging, { recursive: true, force: true });
    const run = deps.run ?? exec;
    try {
      await run(python, [path.join(extensionDir, 'resources', 'install-release-engine.py'), staging, ...archives], { signal, timeout: 180000, maxBuffer: 4096, windowsHide: true });
      const binary = path.join(staging, 'engine', name);
      try {
        const result = await run(binary, [target.includes('cuda') ? '--list-devices' : '--version'], { signal, timeout: 30000, maxBuffer: 16384, windowsHide: true });
        if (target.includes('cuda') && !/^\s*CUDA\d+\s*:/m.test(result.stdout + result.stderr)) throw new Error('No CUDA device was reported.');
      } catch {
        signal?.throwIfAborted();
        throw new Error(`The ${target} engine could not start${target.includes('cuda') ? ' with CUDA. Check the NVIDIA driver' : '. Check OS compatibility and CPU instructions'}. ${target.startsWith('windows') ? ' Windows also requires the Microsoft Visual C++ x64 runtime (see Settings guide).' : ''} Select a compatible engine in Advanced settings if needed.`);
      }
      signal?.throwIfAborted();
      await fs.writeFile(path.join(staging, 'ready.json'), JSON.stringify({ signature, files: await fs.readdir(path.join(staging, 'engine')) }));
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(staging, dest);
      return executable;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }, signal);
}
