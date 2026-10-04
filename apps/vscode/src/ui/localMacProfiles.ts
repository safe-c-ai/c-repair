import profiles from '../../resources/local-mac-profiles.json';
import type { LocalSettings } from '../bridge/localSettings';
import type { Asset } from '../bridge/localAssets';

export const MAC_PROFILES = profiles;
export function macProfile(band: string) {
  return Object.hasOwn(profiles, band) ? profiles[band as keyof typeof profiles] : undefined;
}
export function macProfileAsset(band: string): Asset | undefined {
  const p = macProfile(band);
  if (!p) return;
  const a = p.artifact;
  return { filename: a.filename, bytes: a.bytes, sha256: a.sha256,
    url: `https://huggingface.co/${a.repository}/resolve/${a.revision}/${a.filename}` };
}
export function macProfileSettings(band: string): Partial<LocalSettings> {
  const p = macProfile(band);
  if (!p) return {};
  const { artifact, quantization, ...settings } = p;
  return settings as Partial<LocalSettings>;
}
export function detectedUnifiedBand(gib: number): string {
  if (!Number.isFinite(gib) || gib <= 0) return 'unknown';
  return gib >= 96 ? '96' : gib >= 64 ? '64plus' : gib >= 48 ? '48' : gib >= 32 ? '32plus' : gib >= 24 ? '24' : gib >= 16 ? '16' : 'under16';
}
