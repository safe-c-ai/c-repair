import { macProfile } from './localMacProfiles';
import { gpuProfile } from './localGpuProfiles';
export type VramBand = '32plus' | '24' | '16' | '12' | '10' | '8' | 'under8' | 'unknown';
export const VRAM_BANDS: Array<{ id: VramBand; label: string }> = [
  { id: '32plus', label: '32 GB or more' }, { id: '24', label: '24 GB' },
  { id: '16', label: '16 GB' }, { id: '12', label: '12 GB' },
  { id: '10', label: '10 GB' }, { id: '8', label: '8 GB' },
  { id: 'under8', label: 'Less than 8 GB / no dedicated GPU' }, { id: 'unknown', label: 'Unknown' },
];
export function ramAdvice(ramGiB?: number): string {
  return ramGiB === undefined ? 'RAM capacity is unknown.' : ramGiB < 32 ? 'Ornith Q4 needs room for 21.7 GB of weights plus cache and working memory; the automatic RAM preset requires 32 GiB RAM.' : 'Leave RAM free for the OS and work buffers.';
}
export function memoryAdvice(band: VramBand, ramGiB?: number): { candidate?: string; message: string } {
  const p = gpuProfile(band, ramGiB);
  if (!p) return { message: `No automatic memory profile is available. Choose an existing model or custom settings. ${ramAdvice(ramGiB)}` };
  return { candidate: p.artifact.preset, message: `${p.artifact.quantization}, 64K context. Starting settings; lower-VRAM allocations have not been hardware-tested. Adjust GPU layers and token limits in Advanced settings. ${ramAdvice(ramGiB)}` };
}
export function detectedVramBand(gib?: number): VramBand {
  if (gib === undefined || !Number.isFinite(gib) || gib < 0) return 'unknown';
  const nominal = Math.round(gib);
  return nominal >= 32 ? '32plus' : nominal >= 24 ? '24' : nominal >= 16 ? '16' : nominal >= 12 ? '12' : nominal >= 10 ? '10' : nominal >= 8 ? '8' : 'under8';
}

export const UNIFIED_BANDS = [
  { id: '96', label: '96 GB or more' }, { id: '64plus', label: '64–95 GB' },
  { id: '48', label: '48–63 GB' }, { id: '32plus', label: '32–47 GB' },
  { id: '24', label: '24–31 GB' }, { id: '16', label: '16–23 GB (experimental)' },
  { id: 'under16', label: 'Less than 16 GB' }, { id: 'unknown', label: 'Not sure' },
] as const;
export type UnifiedBand = typeof UNIFIED_BANDS[number]['id'];
export function unifiedMemoryAdvice(band: UnifiedBand): { candidate?: string; message: string } {
  const shared = 'Apple Silicon shares one memory pool between GPU, CPU and macOS. Moving weights to RAM does not add capacity. These GGUFs and token settings have not been tested on Mac in C Repair.';
  const p = macProfile(band);
  if (p) return { candidate: 'qwen38-27b-q4km', message: `${band === '16' ? 'Experimental: ' : ''}Qwen3.8 ${p.quantization}, ${p.cacheTypeK} KV, ${p.contextTokens / 1024}K context. Starting settings, not a fit guarantee. ${shared}` };
  return { message: `No capacity preset available; choose Custom or confirm your memory capacity. ${shared}` };
}
