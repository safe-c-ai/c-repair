import mlxModels from '../../resources/local-mlx-models.json';
import artifacts from '../../resources/local-model-artifacts.json';
// Pure local configuration. API model/provider/effort overrides never enter here.
import presets from '../../resources/local-presets.json';

export const LOCAL_PRESETS = presets;
export type LocalPresetId = keyof typeof presets;
export const LOCAL_PRESET = { ...presets['qwen38-27b-q4km'], preset: 'qwen38-27b-q4km' as LocalPresetId };
export interface LocalSettings {
  runtime?: 'llama.cpp' | 'mlx';
  mlxArtifact?: string;
  managedArtifact?: string;
  serverPath: string;
  modelPath: string;
  contextTokens: number;
  maxCompletionTokens: number;
  structuredTokens: number;
  effort: 'off' | 'medium' | 'xhigh' | 'model';
  preset?: LocalPresetId;
  modelName?: string;
  cpuExperts?: boolean;
  templatePath?: string;
  generation?: Record<string, unknown>;
  detectionGeneration?: Record<string, unknown>;
  structuredGeneration?: Record<string, unknown>;
  gpuLayers: number;
  threads: number;
  cacheTypeK?: 'f16' | 'q8_0';
  cacheTypeV?: 'f16' | 'q8_0';
  batchSize?: number;
  ubatchSize?: number;
  mtpDraftTokens: number;
  timeoutSeconds: number;
}
export function validateLocalSettings(s: LocalSettings): void {
  if (!s.serverPath.trim() || !s.modelPath.trim()) throw new Error('Run C Repair: Set Up Local Model to prepare the model and inference engine.');
  for (const key of ['contextTokens', 'maxCompletionTokens', 'structuredTokens', 'timeoutSeconds'] as const) {
    if (!Number.isInteger(s[key]) || s[key] < 1 || s[key] > 1048576) throw new Error(`Invalid local ${key}. Use a positive integer up to 1048576.`);
  }
  if (!Number.isInteger(s.threads) || s.threads < 0 || s.threads > 1048576) throw new Error('CPU threads must be 0 (automatic) or a positive integer.');
  for (const key of ['cacheTypeK', 'cacheTypeV'] as const) if (s[key] !== undefined && !['f16', 'q8_0'].includes(s[key]!)) throw new Error('KV cache must be f16 or q8_0.');
  for (const key of ['batchSize', 'ubatchSize'] as const) if (s[key] !== undefined && (!Number.isInteger(s[key]) || s[key]! < 1 || s[key]! > 1048576)) throw new Error('Batch sizes must be positive integers.');
  if ((s.ubatchSize ?? 512) > (s.batchSize ?? 2048)) throw new Error('Physical batch size must not exceed batch size.');
  if (s.runtime !== undefined && !['llama.cpp','mlx'].includes(s.runtime)) throw new Error('Unknown local runtime.');
  if (s.runtime === 'mlx' && (s.mtpDraftTokens !== 0 || s.cpuExperts || s.templatePath && !s.templatePath.trim())) throw new Error('MLX does not support MTP or CPU expert offload in this build.');
  if (s.mlxArtifact) {
    const a = mlxModels[s.mlxArtifact as keyof typeof mlxModels];
    if (s.runtime !== 'mlx' || !a || s.preset !== 'qwen38-27b-q4km' || s.modelPath.replace(/\\/g, '/').split('/').pop() !== a.filename) throw new Error('The MLX model and download identity do not match. Select the model again.');
  }
  if (s.runtime === 'mlx' && s.managedArtifact) throw new Error('GGUF download identity cannot be used with MLX.');
  if (s.managedArtifact) {
    const a = Object.hasOwn(artifacts, s.managedArtifact) ? artifacts[s.managedArtifact as keyof typeof artifacts] : undefined;
    if (!a || a.preset !== s.preset || s.modelPath.replace(/\\/g, '/').split('/').pop() !== a.filename) throw new Error('The selected model and file do not match. Open Local model settings and select the model again.');
  }
  const id = s.preset ?? 'qwen38-27b-q4km';
  if (!Object.hasOwn(LOCAL_PRESETS, id)) throw new Error('Unknown local preset.');
  const efforts = id === 'qwen38-27b-q4km' ? ['off', 'medium', 'xhigh'] : ['off', 'model'];
  if (id !== 'custom' && !efforts.includes(s.effort)) throw new Error('Selected effort is not supported by this local preset.');
  if (s.cpuExperts !== undefined && typeof s.cpuExperts !== 'boolean') throw new Error('CPU experts must be a boolean.');
  if (s.modelName !== undefined && (!s.modelName.trim() || /[\r\n]/.test(s.modelName))) throw new Error('Local model name must be a nonempty single line.');
  validateGeneration(s.generation ?? {}); validateGeneration(s.detectionGeneration ?? {}); validateGeneration(s.structuredGeneration ?? {});
  if (s.maxCompletionTokens >= s.contextTokens || s.structuredTokens >= s.contextTokens) throw new Error('Local context length must exceed both generation limits, leaving room for input.');
  if (!Number.isInteger(s.gpuLayers) || s.gpuLayers < 0 || s.gpuLayers > 999) throw new Error('Invalid local GPU layers.');
  if (!Number.isInteger(s.mtpDraftTokens) || s.mtpDraftTokens < 0 || s.mtpDraftTokens > 16) throw new Error('Invalid local MTP draft width.');
}
export function localServerArgs(s: LocalSettings, port: number): string[] {
  validateLocalSettings(s);
  return ['-m', s.modelPath, '-ngl', String(s.gpuLayers), '-c', String(s.contextTokens),
    ...(s.threads ? ['-t', String(s.threads)] : []),
    '-ctk', s.cacheTypeK ?? 'f16', '-ctv', s.cacheTypeV ?? 'f16',
    '-b', String(s.batchSize ?? 2048), '-ub', String(s.ubatchSize ?? 512), '-fa', 'on', '-np', '1', '--no-context-shift',
    '--reasoning-format', 'deepseek', '--reasoning-preserve', '--host', '127.0.0.1',
    '--port', String(port), '--no-webui',
    ...(s.cpuExperts ? ['--cpu-moe'] : []),
    ...(s.templatePath ? ['--jinja', '--chat-template-file', s.templatePath] : []),
    ...(s.mtpDraftTokens ? ['--spec-type', 'draft-mtp', '--spec-draft-n-max', String(s.mtpDraftTokens)] : [])];
}
export function localBridgeEnv(s: LocalSettings, port: number): Record<string, string> {
  return { CREPAIR_ROUTE: 'local', CREPAIR_LOCAL_URL: `http://127.0.0.1:${port}`,
    CREPAIR_LOCAL_CONTEXT: String(s.contextTokens), CREPAIR_LOCAL_COMPLETION: String(s.maxCompletionTokens),
    CREPAIR_LOCAL_STRUCTURED: String(s.structuredTokens), CREPAIR_LOCAL_EFFORT: s.effort,
    CREPAIR_LOCAL_TIMEOUT: String(s.timeoutSeconds),
    CREPAIR_LOCAL_PRESET: s.preset ?? 'qwen38-27b-q4km',
    CREPAIR_LOCAL_MODEL_NAME: s.modelName ?? LOCAL_PRESETS[s.preset ?? 'qwen38-27b-q4km'].modelName,
    CREPAIR_LOCAL_DETECTION_GENERATION: JSON.stringify(s.detectionGeneration ?? {}),
    CREPAIR_LOCAL_GENERATION: JSON.stringify(s.generation ?? {}),
    CREPAIR_LOCAL_STRUCTURED_GENERATION: JSON.stringify(s.structuredGeneration ?? {}) };
}
export function localErrorSetting(code?: string): string | undefined {
  return ({ local_context: 'contextTokens', local_generation_limit: 'maxCompletionTokens',
    local_structured_limit: 'structuredTokens', local_timeout: 'timeoutSeconds' } as Record<string, string>)[code ?? ''];
}


// Only inference knobs may vary; routing, prompts and token ceilings stay owned by C Repair.
export function validateGeneration(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Custom generation settings must be a JSON object.');
  const ranges: Record<string, [number, number]> = { temperature: [0, 2], top_p: [0, 1], top_k: [0, 100000], min_p: [0, 1], repeat_penalty: [0, 2], presence_penalty: [-2, 2] };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'chat_template_kwargs') {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.values(item).some(v => (typeof v === 'number' && !Number.isFinite(v)) || (v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) throw new Error('Template kwargs must contain scalar values.');
    } else {
      const range = ranges[key];
      if (!Object.hasOwn(ranges, key) || !range || typeof item !== 'number' || !Number.isFinite(item) || item < range[0] || item > range[1] || (key === 'top_k' && !Number.isInteger(item))) throw new Error(`Unsupported custom generation setting: ${key}`);
    }
  }
}

/** Read explicit settings over preset defaults, avoiding VS Code's static defaults. */
export function resolveLocalSettings(read: (key: string) => unknown): LocalSettings {
  const configuration = read('configuration');
  if (configuration && typeof configuration === 'object' && !Array.isArray(configuration)) {
    const values = configuration as Record<string, unknown>;
    return resolveLocalSettings(k => k === 'configuration' ? undefined : values[k]);
  }
  const id = (read('preset') ?? 'qwen38-27b-q4km') as LocalPresetId;
  if (!Object.hasOwn(LOCAL_PRESETS, id)) throw new Error('Unknown local preset.');
  const preset = LOCAL_PRESETS[id];
  const result = { ...preset, serverPath: '', modelPath: '', templatePath: '', generation: {}, structuredGeneration: {} } as unknown as LocalSettings;
  for (const key of ['runtime', 'mlxArtifact', 'managedArtifact', 'serverPath', 'modelPath', 'templatePath', 'contextTokens', 'maxCompletionTokens', 'structuredTokens', 'effort', 'gpuLayers', 'threads', 'cacheTypeK', 'cacheTypeV', 'batchSize', 'ubatchSize', 'mtpDraftTokens', 'timeoutSeconds', 'cpuExperts', 'generation', 'detectionGeneration', 'structuredGeneration'] as const) {
    const v = read(key); if (v !== undefined && v !== null) Object.assign(result, { [key]: v });
  }
  if (id === 'custom') result.modelName = String(read('modelName') ?? preset.modelName);
  return result;
}
