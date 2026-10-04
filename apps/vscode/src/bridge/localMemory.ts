import { detectEngineTarget } from './localEngineHost';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

export interface GpuMemory { index: number; totalMiB: number; usedMiB: number; freeMiB: number }
export function parseGpuMemory(stdout: string): GpuMemory[] | undefined {
  const rows = stdout.trim().split('\n').map(line => line.split(',').map(Number));
  if (!rows.length || rows.some(r => r.length !== 4 || r.some(n => !Number.isFinite(n) || n < 0) || r[1] <= 0 || r[2] > r[1] || r[3] > r[1])) return;
  return rows.map(([index, totalMiB, usedMiB, freeMiB]) => ({ index, totalMiB, usedMiB, freeMiB }));
}
/** GPU-wide measurements, including other applications; never a per-model estimate. */
export async function gpuMemorySnapshot(): Promise<GpuMemory[] | undefined> {
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=index,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 2000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : parseGpuMemory(stdout)));
  });
}
export function formatGpuMemory(rows: GpuMemory[]): string {
  return rows.map(r => `GPU ${r.index}: ${(r.usedMiB / 1024).toFixed(1)} / ${(r.totalMiB / 1024).toFixed(1)} GiB used, ${(r.freeMiB / 1024).toFixed(1)} GiB free (all applications)`).join('; ');
}
export async function gpuMemorySummary(): Promise<string | undefined> {
  if (process.platform === 'darwin' && process.arch === 'arm64') return `Unified memory: ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB total, shared by GPU, CPU and macOS (per-model usage unavailable).`;
  const rows = await gpuMemorySnapshot();
  return rows ? formatGpuMemory(rows) : undefined;
}

/** Unknown/multiple GPU capacity stays unknown; a detected CPU route uses RAM profiles. */
export async function localHardwareSnapshot() {
  const unified = process.platform === 'darwin' && process.arch === 'arm64';
  const gpus = unified ? undefined : await gpuMemorySnapshot();
  let vramGiB = gpus?.length === 1 ? gpus[0].totalMiB / 1024 : undefined;
  if (!unified && !gpus) {
    const target = await detectEngineTarget().catch(() => undefined);
    if (target === 'linux-cpu' || target === 'windows-cpu') vramGiB = 0;
  }
  return { unified, ramGiB: os.totalmem() / 2 ** 30, vramGiB, gpu: gpus ? formatGpuMemory(gpus) : undefined };
}
