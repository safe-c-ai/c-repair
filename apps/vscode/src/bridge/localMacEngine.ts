import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import manifest from '../../resources/local-engine-mac.json';
import { downloadAsset, withAssetLock } from './localAssets';
const exec = promisify(execFile);
export const MAC_ENGINE = manifest;
export function supportedMacOS(version: string): boolean {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version.trim());
  return !!m && (+m[1] > 13 || (+m[1] === 13 && +m[2] >= 3));
}
export function hasMetalDevice(output: string): boolean {
  return /^\s*(?:Metal|MTL)\w*\s*:/m.test(output);
}
interface MacInstallDeps {
  download?: typeof downloadAsset;
  run?: (file: string, args: string[], options: { signal?: AbortSignal; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
}
export async function prepareMacEngine(storageDir: string, extensionDir: string, python: string, progress: (message: string) => void, signal?: AbortSignal, deps: MacInstallDeps = {}): Promise<string> {
  const run = deps.run ?? exec;
  const root = path.join(storageDir, 'local-engines');
  return withAssetLock(root, async () => {
    const dest = path.join(root, manifest.id);
    const executable = path.join(dest, 'engine', 'llama-server');
    try {
      const ready = JSON.parse(await fs.readFile(path.join(dest, 'ready.json'), 'utf8'));
      if (ready.sha256 === manifest.sha256 && Array.isArray(ready.files) && ready.files.includes('llama-server')) {
        await Promise.all(ready.files.map((f: string) => fs.access(path.join(dest, 'engine', f))));
        return executable;
      }
    } catch { /* install missing or incomplete cache */ }
    progress('Downloading the Apple Silicon inference engine (about 11 MB)…');
    const archive = await (deps.download ?? downloadAsset)(manifest, path.join(root, 'downloads'), progress, signal);
    const staging = path.join(root, manifest.id + '.staging');
    await fs.rm(staging, { recursive: true, force: true });
    try {
      await run(python, [path.join(extensionDir, 'resources', 'install-mac-engine.py'), archive, staging, manifest.archiveRoot], { signal, timeout: 60000, maxBuffer: 4096 });
      const binary = path.join(staging, 'engine', 'llama-server');
      progress('Checking the Apple Metal backend…');
      let output: string;
      try {
        const result = await run(binary, ['--list-devices'], { signal, timeout: 30000, maxBuffer: 16384 });
        output = result.stdout + result.stderr;
      } catch (e) {
        signal?.throwIfAborted();
        throw new Error(`The downloaded Mac engine could not start. macOS ${manifest.minimumOS}+ and Apple Silicon are required. ${(e as Error).message}`);
      }
      if (!hasMetalDevice(output)) throw new Error('The Mac engine did not report a Metal GPU. CPU fallback was not selected. Check the Mac configuration or choose another engine in Advanced settings.');
      signal?.throwIfAborted();
      const files = await fs.readdir(path.join(staging, 'engine'));
      await fs.writeFile(path.join(staging, 'ready.json'), JSON.stringify({ sha256: manifest.sha256, files }));
      await fs.rm(dest, { recursive: true, force: true });
      signal?.throwIfAborted();
      await fs.rename(staging, dest);
      return executable;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }, signal);
}
