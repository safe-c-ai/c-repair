import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export type EngineTarget = 'linux-cuda' | 'linux-cpu' | 'windows-cuda12' | 'windows-cuda13' | 'windows-cpu' | 'mac';
export const LINUX_CUDA_CAPABILITIES = ['7.5', '8.0', '8.6', '8.9', '9.0', '12.0'];
export function selectEngineTarget(platform: string, arch: string, capabilities: string[], cpuOnly = false): EngineTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'mac';
  if (arch !== 'x64' || !['linux', 'win32'].includes(platform)) throw new Error('Automatic engines support Windows / Linux x64 and Apple Silicon. Select another engine in Advanced settings for this host.');
  if (cpuOnly || capabilities.length === 0) return platform === 'linux' ? 'linux-cpu' : 'windows-cpu';
  if (platform === 'linux') {
    if (!capabilities.every(c => LINUX_CUDA_CAPABILITIES.includes(c))) throw new Error('This NVIDIA GPU is outside the bundled CUDA build targets. Select a compatible engine in Advanced settings, or set GPU layers to 0 for CPU execution.');
    return 'linux-cuda';
  }
  if (!capabilities.every(c => /^(5\.[02]|6\.[01]|7\.[05]|8\.[069]|9\.0|12\.[01])$/.test(c))) throw new Error('No automatic CUDA engine is available for this GPU. Select an engine in Advanced settings.');
  const blackwell = capabilities.some(c => c.startsWith('12.'));
  if (blackwell && capabilities.some(c => Number(c) < 7.5)) throw new Error('These GPUs need different CUDA versions. Select an engine in Advanced settings.');
  return blackwell ? 'windows-cuda13' : 'windows-cuda12';
}
interface ProbeDeps {
  platform?: string;
  arch?: string;
  run?: (file: string, args: string[], options: { signal?: AbortSignal; timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }>;
}
export async function detectEngineTarget(signal?: AbortSignal, gpuLayers?: number, deps: ProbeDeps = {}): Promise<EngineTarget> {
  const platform = deps.platform ?? process.platform, arch = deps.arch ?? process.arch;
  if (platform === 'darwin' || gpuLayers === 0) return selectEngineTarget(platform, arch, [], gpuLayers === 0);
  let capabilities: string[];
  try {
    const result = await (deps.run ?? exec)('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader'], { signal, timeout: 5000, windowsHide: true });
    capabilities = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(s => s.trim());
  } catch (e) {
    signal?.throwIfAborted();
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && String(code) !== '9') throw new Error('Could not inspect the NVIDIA driver. Check the driver or select CPU execution (GPU layers = 0) in Advanced settings.');
    capabilities = [];
  }
  return selectEngineTarget(platform, arch, capabilities);
}
