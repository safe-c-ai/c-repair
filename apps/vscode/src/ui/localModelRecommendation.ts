import catalog from '../../resources/local-model-artifacts.json';
import { gpuProfileSettings, gpuProfile } from './localGpuProfiles';
import { macProfile, macProfileSettings, detectedUnifiedBand } from './localMacProfiles';
import { detectedVramBand } from './localMemoryAdvice';
import { setupDefaults } from './localSetupReview';
import type { LocalPresetId, LocalSettings } from '../bridge/localSettings';

export interface LocalHardware { unified: boolean; ramGiB: number; vramGiB?: number }
/** Choose allocation for the selected model; never substitute another model. */
export function recommendLocalModel(id: LocalPresetId, hardware: LocalHardware): { artifactId: keyof typeof catalog; settings: Partial<LocalSettings> } | undefined {
  if (id === 'qwen38-27b-q4km') {
    if (hardware.unified) {
      const band = detectedUnifiedBand(hardware.ramGiB), p = macProfile(band);
      if (!p) return;
      return { artifactId: `qwen38:${p.quantization}` as keyof typeof catalog, settings: macProfileSettings(band) };
    }
    if (hardware.ramGiB < 16) return;
    const band = detectedVramBand(hardware.vramGiB), p = gpuProfile(band, hardware.ramGiB);
    if (p?.artifact.preset === id) return { artifactId: p.artifactId, settings: gpuProfileSettings(band, hardware.ramGiB) };
    // Below 10 GB, retain the selected Qwen with RAM placement instead of switching models.
    return { artifactId: 'qwen38:UD-Q2_K_XL', settings: { ...gpuProfileSettings('10', hardware.ramGiB), gpuLayers: (hardware.vramGiB ?? 0) >= 7.5 ? 24 : 0 } };
  }
  if (id === 'ornith15-35b-a3b') {
    if (hardware.ramGiB < 32) return;
    return { artifactId: 'ornith15:Q4_K_M', settings: { ...setupDefaults(id),
      gpuLayers: hardware.unified || (hardware.vramGiB ?? 0) >= 31.5 ? 99 : (hardware.vramGiB ?? 0) >= 7.5 ? 24 : 0,
      cpuExperts: !hardware.unified && (hardware.vramGiB ?? 0) < 31.5,
    } };
  }
  if (id === 'qwen36-35b-a3b' && hardware.ramGiB >= 32) {
    return { artifactId: 'qwen36:UD-Q4_K_M', settings: { ...setupDefaults(id), gpuLayers: hardware.unified ? 99 : (hardware.vramGiB ?? 0) >= 7.5 ? 24 : 0, cpuExperts: !hardware.unified } };
  }
  return undefined;
}
