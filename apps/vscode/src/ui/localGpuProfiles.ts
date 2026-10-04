import profiles from '../../resources/local-gpu-profiles.json';
import catalog from '../../resources/local-model-artifacts.json';
import type { LocalSettings } from '../bridge/localSettings';
import type { Asset } from '../bridge/localAssets';

/** Starting allocations, not measured fit guarantees. Never mutate saved tuning. */
export function gpuProfile(band: string, ramGiB?: number) {
  if (!Object.hasOwn(profiles, band)) return;
  const p = profiles[band as keyof typeof profiles];
  if (ramGiB === undefined || ramGiB < p.minimumRamGiB) return;
  const artifactId = p.artifactId as keyof typeof catalog;
  return { ...p, artifactId, artifact: catalog[artifactId] };
}
export function gpuProfileSettings(band: string, ramGiB?: number): Partial<LocalSettings> {
  return (gpuProfile(band, ramGiB)?.settings ?? {}) as Partial<LocalSettings>;
}
export function gpuProfileAsset(band: string, ramGiB?: number): Asset | undefined {
  const a = gpuProfile(band, ramGiB)?.artifact;
  if (a) return { filename: a.filename, bytes: a.bytes, sha256: a.sha256,
    url: `https://huggingface.co/${a.repository}/resolve/${a.revision}/${a.filename}` };
  return undefined;
}
