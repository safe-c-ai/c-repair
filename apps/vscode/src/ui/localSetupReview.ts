import { resolveLocalSettings, type LocalSettings, type LocalPresetId } from '../bridge/localSettings';

export const LOCAL_SETUP_KEYS = ['runtime', 'mlxArtifact', 'managedArtifact', 'preset', 'serverPath', 'modelPath', 'contextTokens', 'maxCompletionTokens', 'structuredTokens', 'effort', 'gpuLayers', 'threads', 'cacheTypeK', 'cacheTypeV', 'batchSize', 'ubatchSize', 'mtpDraftTokens', 'timeoutSeconds', 'cpuExperts', 'modelName', 'generation', 'detectionGeneration', 'structuredGeneration', 'templatePath'] as const;

export function setupDefaults(id: LocalPresetId, current?: LocalSettings): LocalSettings {
  const defaults = resolveLocalSettings(k => k === 'preset' ? id : undefined);
  // Model-specific settings must not leak into a different model's template.
  return current?.modelPath && current.preset === id ? structuredClone(current) : defaults;
}

export function setupChanges(current: LocalSettings | undefined, next: LocalSettings): Array<{ key: string; label: string; before: string; after: string }> {
  if (!current?.modelPath) return [];
  const labels: Record<typeof LOCAL_SETUP_KEYS[number], string> = { runtime: 'Inference engine', mlxArtifact: 'MLX download', managedArtifact: 'Downloaded model', preset: 'Model preset', serverPath: 'Inference engine', modelPath: 'Model file', contextTokens: 'Context length', maxCompletionTokens: 'Generation limit', structuredTokens: 'Declaration completion limit', effort: 'Thinking', gpuLayers: 'GPU layers', threads: 'CPU threads', cacheTypeK: 'K cache format', cacheTypeV: 'V cache format', batchSize: 'Batch size', ubatchSize: 'Physical batch size', mtpDraftTokens: 'MTP draft tokens', timeoutSeconds: 'Inference timeout (seconds)', cpuExperts: 'MoE experts in RAM', modelName: 'Model name', generation: 'Generation options', detectionGeneration: 'Scan generation options', structuredGeneration: 'Declaration completion options', templatePath: 'Chat template file' };
  const display = (key: string, value: unknown) => value === '' ? (key === 'serverPath' ? 'Automatic' : '(empty)') : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '(default)');
  return LOCAL_SETUP_KEYS.filter(k => JSON.stringify(current[k]) !== JSON.stringify(next[k])).map(k => ({ key: k, label: labels[k], before: display(k, current[k]), after: display(k, next[k]) }));
}
