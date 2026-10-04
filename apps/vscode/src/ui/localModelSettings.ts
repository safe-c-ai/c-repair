import { openLocalSettingsGuide } from './localSettingsGuide';
import { editMlxSettings } from './localMlxSettings';
import { recommendLocalModel } from './localModelRecommendation';
import { LOCAL_LEADERBOARD_ITEM, openLocalLeaderboard } from './localLeaderboard';
import { gpuProfile } from './localGpuProfiles';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import catalog from '../../resources/local-model-artifacts.json';
import { downloadAsset, withAssetLock, type Asset } from '../bridge/localAssets';
import { localHardwareSnapshot } from '../bridge/localMemory';
import { LOCAL_PRESETS, validateLocalSettings, type LocalSettings, type LocalPresetId } from '../bridge/localSettings';
import { setupDefaults } from './localSetupReview';
import { detectedUnifiedBand, macProfile } from './localMacProfiles';
import { detectedVramBand } from './localMemoryAdvice';
import type { LocalReasoningInfo } from '../bridge/localReasoning';
import { inspectTemplateReasoning, selectReasoning, templateReasoningLabel } from '../bridge/templateReasoning';

type ArtifactId = keyof typeof catalog;
export interface LocalModelSettingsDeps {
  localReasoning?: LocalReasoningInfo;
  stageOnly?: boolean;
  startOnApply?: boolean;
  applyBlocked?: () => string | undefined;
  pick?: typeof vscode.window.showQuickPick;
  input?: typeof vscode.window.showInputBox;
  open?: typeof vscode.window.showOpenDialog;
  hardware?: () => Promise<{ unified: boolean; ramGiB: number; vramGiB?: number }>;
  download?: typeof downloadAsset;
  diskSpace?: (directory: string) => Promise<number>;
}
export function artifactForSettings(settings: LocalSettings): ArtifactId | undefined {
  if (settings.managedArtifact && Object.hasOwn(catalog, settings.managedArtifact)) {
    const id = settings.managedArtifact as ArtifactId;
    if (catalog[id].preset === settings.preset && catalog[id].filename === path.basename(settings.modelPath)) return id;
  }
  // Legacy settings did not save an artifact ID. Match only to offer explicit recovery;
  // this does not establish that a user-selected file has been hash-verified.
  return (Object.keys(catalog) as ArtifactId[]).find(k => catalog[k].preset === settings.preset && catalog[k].filename === path.basename(settings.modelPath));
}
function assetFor(id: ArtifactId): Asset {
  const a = catalog[id];
  return { filename: a.filename, bytes: a.bytes, sha256: a.sha256, url: `https://huggingface.co/${a.repository}/resolve/${a.revision}/${a.filename}` };
}

/** Returns one complete configuration on Apply; nothing is persisted while editing. */
export async function editLocalModelSettings(context: vscode.ExtensionContext, current: LocalSettings, deps: LocalModelSettingsDeps = {}, focus?: string): Promise<LocalSettings | undefined> {
  if (current.runtime === 'mlx') return editMlxSettings(context,current,deps);
  const pick = deps.pick ?? vscode.window.showQuickPick;
  const input = deps.input ?? vscode.window.showInputBox;
  const open = deps.open ?? vscode.window.showOpenDialog;
  const hardware = await (deps.hardware ?? localHardwareSnapshot)();
  const band = detectedUnifiedBand(hardware.ramGiB);
  const gpuBand = detectedVramBand(hardware.vramGiB);
  const gpu = gpuProfile(gpuBand, hardware.ramGiB);
  let draft = structuredClone(current);
  let pending: ArtifactId | undefined;
  let error = '';
  const modelDirectory = () => draft.modelPath && draft.managedArtifact ? path.dirname(draft.modelPath) : path.join(context.globalStorageUri.fsPath, 'local-models');
  const defaults = (id: LocalPresetId): LocalSettings => {
    const settings = setupDefaults(id);
    Object.assign(settings, recommendLocalModel(id, hardware)?.settings ?? {});
    return settings;
  };
  async function existing(id: LocalPresetId): Promise<void> {
    const files = await open({ canSelectMany: false, filters: { GGUF: ['gguf'] }, openLabel: 'Use this model' });
    if (!files?.[0]) return;
    const same = id === draft.preset;
    draft = { ...(same ? draft : defaults(id)), serverPath: draft.serverPath, modelPath: files[0].fsPath, managedArtifact: undefined };
    pending = undefined;
  }
  function selectArtifact(id: ArtifactId, reset = false): void {
    const a = catalog[id];
    const directory = modelDirectory();
    if (!a) throw new Error('No downloadable artifact is available for this model.');
    const sameFamily = draft.preset === a.preset;
    draft = { ...(reset || !sameFamily ? defaults(a.preset as LocalPresetId) : draft), ...(!reset ? { serverPath: draft.serverPath } : {}), preset: a.preset as LocalPresetId, modelPath: path.join(directory, a.filename), managedArtifact: id };
    pending = id;
  }
  async function model(): Promise<void> {
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      const result = await editMlxSettings(context,draft,{...deps,stageOnly:true},true);
      if(result){draft=result;pending=undefined;}
      return;
    }
    const choices = [
      ...(Object.keys(catalog) as ArtifactId[]).filter(k => !hardware.unified || catalog[k].preset !== 'qwen36-35b-a3b').map(k => ({ label: `${LOCAL_PRESETS[catalog[k].preset as LocalPresetId].modelName} · ${catalog[k].quantization}`, description: `${(catalog[k].bytes / 1e9).toFixed(1)} GB${k === artifactForSettings(draft) ? ' · current' : ''}${(hardware.unified ? catalog[k].quantization === macProfile(band)?.quantization : k === gpu?.artifactId) ? ' · recommended' : ''}`, id: k as string })),
      { label: `Use an existing ${LOCAL_PRESETS['qwen38-27b-q4km'].modelName} model`, description: 'Choose a GGUF file; no copy', id: 'existing38' },
      ...(!hardware.unified ? [{ label: `Use an existing ${LOCAL_PRESETS['qwen36-35b-a3b'].modelName} model`, description: 'Choose a GGUF file; no copy', id: 'existing36' }, { label: `Use an existing ${LOCAL_PRESETS['ornith15-35b-a3b'].modelName} model`, description: 'Choose a GGUF file; no copy', id: 'existingOrnith' }] : []),
      { label: 'Custom model', description: 'Choose a model and configure its inference options', id: 'custom' },
    ];
    const choice = await pick(choices, { title: 'C Repair · Model and quantization', placeHolder: 'Changing quantization selects the matching model file. Existing tuning is retained within the same model family.', ignoreFocusOut: true });
    if (!choice) return;
    if (choice.id === 'custom') await existing('custom');
    else if (choice.id === 'existing38') await existing('qwen38-27b-q4km');
    else if (choice.id === 'existing36') await existing('qwen36-35b-a3b');
    else if (choice.id === 'existingOrnith') await existing('ornith15-35b-a3b');
    else selectArtifact(choice.id as ArtifactId);
  }
  async function reasoning(detection = false): Promise<void> {
    const cap = await inspectTemplateReasoning(draft);
    const currentValue = templateReasoningLabel(draft, cap, detection);
    const choices = cap.values.map(value => ({ value, label: value === 'model' ? 'Model default' : value,
      description: value === 'model' && cap.defaultValue ? cap.defaultValue : !cap.known ? 'Compatibility unverified' : value === 'xhigh' ? 'Prioritize repair quality' : value === 'off' ? 'Disable reasoning' : value === 'on' ? 'Enable reasoning; use the default effort' : '',
    }));
    if (detection) choices.unshift({ label: 'Same as repair', value: 'inherit', description: templateReasoningLabel(draft, cap) });
    choices.push({ label: 'Custom…', value: 'custom', description: 'Edit reasoning template options (JSON)' });
    const choice = await pick(choices, { title: detection ? 'C Repair · Scan reasoning' : 'C Repair · Reasoning', placeHolder: `Current: ${currentValue} · ${cap.known ? 'Options read from the selected template' : 'Template not recognized; compatibility unverified'}`, ignoreFocusOut: true });
    if (!choice) return;
    if (choice.value === 'inherit') { delete draft.detectionGeneration; return; }
    if (choice.value === 'custom') {
      const key = detection ? 'detectionGeneration' : 'generation';
      const value = await input({ title: 'Reasoning template options (JSON)', value: JSON.stringify(draft[key]?.chat_template_kwargs ?? {}), ignoreFocusOut: true,
        validateInput: text => { try { const kwargs = JSON.parse(text); validateLocalSettings({ ...draft, serverPath: '/engine', modelPath: '/model', managedArtifact: undefined, [key]: { ...draft[key], chat_template_kwargs: kwargs } }); return undefined; } catch (e) { return (e as Error).message; } },
      });
      if (value !== undefined) draft[key] = { ...draft[key], chat_template_kwargs: JSON.parse(value) };
    } else selectReasoning(draft, choice.value, detection ? 'detection' : false);
  }
  async function custom(): Promise<void> {
    const value = await input({ title: 'Custom model settings (JSON)', ignoreFocusOut: true,
      value: JSON.stringify({ modelName: draft.modelName, generation: draft.generation ?? {}, detectionGeneration: draft.detectionGeneration ?? {}, structuredGeneration: draft.structuredGeneration ?? {}, templatePath: draft.templatePath ?? '' }),
      validateInput: text => { try { const d = JSON.parse(text); if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Enter a JSON object.'); validateLocalSettings({ ...draft, ...d, serverPath: '/engine', modelPath: '/model', managedArtifact: undefined, preset: 'custom' }); return undefined; } catch (e) { return (e as Error).message; } },
    });
    if (value) { const d = JSON.parse(value); for (const k of ['modelName', 'generation', 'detectionGeneration', 'structuredGeneration', 'templatePath'] as const) if (d[k] !== undefined) Object.assign(draft, { [k]: d[k] }); }
  }
  const numeric = {
    contextTokens: 'Context length (input + reasoning + answer)', maxCompletionTokens: 'Repair and detection limit (reasoning + answer)', structuredTokens: 'Declaration completion limit',
    timeoutSeconds: 'Timeout (seconds)', batchSize: 'Input batch size', ubatchSize: 'Physical batch size', threads: 'CPU threads (0 = automatic)', mtpDraftTokens: 'MTP draft tokens (0 = disabled)', gpuLayers: 'GPU layers (0 = CPU)',
  } as const;
  async function editNumber(key: keyof typeof numeric): Promise<void> {
    const minimum = ['threads', 'mtpDraftTokens', 'gpuLayers'].includes(key) ? 0 : 1;
    const value = await input({ title: numeric[key], value: String(draft[key] ?? (key === 'batchSize' ? 2048 : 512)), ignoreFocusOut: true,
      validateInput: v => Number.isInteger(Number(v)) && Number(v) >= minimum && Number(v) <= (key === 'mtpDraftTokens' ? 16 : key === 'gpuLayers' ? 999 : 1048576) ? undefined : 'Enter a valid whole number.',
    });
    if (value !== undefined) draft[key] = Number(value);
  }
  async function advanced(): Promise<void> {
    while (true) {
      const choice = await pick([
        { label: 'Back', key: 'back' },
        ...Object.entries(numeric).map(([key, label]) => ({ label, key, description: String(draft[key as keyof typeof numeric] ?? (key === 'batchSize' ? 2048 : 512)) })),
        { label: 'KV cache', key: 'kv', description: `${draft.cacheTypeK ?? 'f16'} / ${draft.cacheTypeV ?? 'f16'}` },
        ...(!hardware.unified && ['qwen36-35b-a3b', 'ornith15-35b-a3b'].includes(draft.preset ?? '') ? [{ label: 'MoE experts in RAM', key: 'experts', description: draft.cpuExperts ? 'On' : 'Off' }] : []),
        { label: 'Inference engine', key: 'engine', description: draft.serverPath || 'Automatic' },
        ...(draft.preset === 'custom' ? [{ label: 'Custom model options', key: 'custom' }] : []),
      ], { title: 'C Repair · Advanced local settings', placeHolder: deps.stageOnly ? 'Effective values. Done returns to setup; Start applies changes.' : 'Effective values. Changes are saved together when you Apply.', ignoreFocusOut: true });
      if (!choice || choice.key === 'back') return;
      if (Object.hasOwn(numeric, choice.key)) await editNumber(choice.key as keyof typeof numeric);
      else if (choice.key === 'kv') { const v = await pick(['f16', 'q8_0'], { title: 'KV cache (K and V)' }); if (v) draft.cacheTypeK = draft.cacheTypeV = v as 'f16' | 'q8_0'; }
      else if (choice.key === 'experts') draft.cpuExperts = !draft.cpuExperts;
      else if (choice.key === 'custom') await custom();
      else if (choice.key === 'engine') {
        const v = await pick(['Automatic', 'Select executable'], { title: 'Inference engine' });
        if (v === 'Automatic') draft.serverPath = '';
        else if (v) { const files = await open({ canSelectMany: false, openLabel: 'Use this engine' }); if (files?.[0]) draft.serverPath = files[0].fsPath; }
      }
    }
  }
  if (focus && Object.hasOwn(numeric, focus)) await editNumber(focus as keyof typeof numeric);
  while (true) {
    if (draft.runtime === 'mlx') return editMlxSettings(context,draft,deps);
    const known = artifactForSettings(draft);
    const label = draft.preset === 'custom' ? draft.modelName ?? 'Custom model' : LOCAL_PRESETS[draft.preset ?? 'qwen38-27b-q4km'].modelName;
    const cached = pending && await fs.stat(draft.modelPath).then(s => s.isFile()).catch(() => false);
    const quant = known ? catalog[known].quantization : 'Existing GGUF';
    const reasoningCap = await inspectTemplateReasoning(draft);
    const choice = await pick([
      ...(error ? [{ label: `Error: ${error}`, action: 'error' }] : []),
      { label: `$(check) ${deps.startOnApply ? 'Start local model' : deps.stageOnly ? 'Done' : pending ? (cached ? 'Verify model and apply' : 'Download and apply') : 'Apply changes'}`, action: 'apply', description: deps.startOnApply ? 'Prepare and start this model' : deps.stageOnly ? 'Return to setup; prepare the model when you Start' : pending ? `${cached ? 'Verify cached file' : `${(catalog[pending].bytes / 1e9).toFixed(1)} GB`} · ${modelDirectory()}` : 'Save all changes together; use them on the next local scan' },
      { label: 'Scan reasoning', action: 'detectionReasoning', description: templateReasoningLabel(draft, reasoningCap, true), detail: 'Violation detection and verification after repair' },
      { label: 'Repair reasoning', action: 'reasoning', description: templateReasoningLabel(draft, reasoningCap), detail: 'Generate code fixes' },
      { label: 'Model and quantization', action: 'model', description: `${label} · ${quant}`, detail: path.basename(draft.modelPath) },
      { label: 'Model location', action: 'location', detail: draft.modelPath, description: 'Open folder or change download location' },
      { label: 'Advanced settings', action: 'advanced', description: `${draft.contextTokens / 1024}K context · ${draft.maxCompletionTokens / 1024}K generation · ${draft.cacheTypeK ?? 'f16'}/${draft.cacheTypeV ?? 'f16'} KV` },
      { label: 'Restore recommended settings', action: 'reset', description: 'Keep this model; reset quantization and inference defaults for this computer' },
      ...(known ? [{ label: 'Download this model again', action: 'recover', description: 'Restore a missing file or verify the cached download' }] : []),
      { label: 'Settings guide', action: 'guide', description: 'Included settings guide' },
      LOCAL_LEADERBOARD_ITEM,
    ], { title: 'C Repair · Local model settings', placeHolder: `${label} · ${quant} · ${hardware.ramGiB.toFixed(0)} GiB ${hardware.unified ? 'unified memory' : 'RAM'} · Esc cancels unsaved changes`, ignoreFocusOut: true });
    if (!choice) return;
    error = '';
    try {
      if (choice.action === 'reasoning') await reasoning();
      else if (choice.action === 'detectionReasoning') await reasoning(true);
      else if (choice.action === 'model') await model();
      else if (choice.action === 'advanced') await advanced();
      else if (choice.action === 'reset') {
        const recommendation = recommendLocalModel(draft.preset ?? 'custom', hardware);
        if (!recommendation) throw new Error('No automatic memory settings are available for the selected model. Edit Advanced settings.');
        selectArtifact(recommendation.artifactId, true);
      } else if (choice.action === 'recover' && known) selectArtifact(known);
      else if (choice.action === 'location') {
        const action = await pick(['Open model folder', 'Change download location', 'Use an existing file'], { title: 'Model location' });
        if (action === 'Open model folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(draft.modelPath));
        else if (action === 'Use an existing file') await existing(draft.preset ?? 'custom');
        else if (action) {
          if (!known) throw new Error('This is an existing custom file. Move it yourself, then choose Use an existing file.');
          const dirs = await open({ canSelectMany: false, canSelectFolders: true, canSelectFiles: false, openLabel: 'Download models here', defaultUri: vscode.Uri.file(modelDirectory()) });
          if (dirs?.[0]) { selectArtifact(known); draft.modelPath = path.join(dirs[0].fsPath, catalog[known].filename); }
        }
      } else if (choice.action === 'leaderboard') {
        await openLocalLeaderboard();
      } else if (choice.action === 'guide') {
        await openLocalSettingsGuide(context);
      } else if (choice.action === 'apply') {
        const blocked = deps.applyBlocked?.();
        if (blocked) throw new Error(blocked);
        validateLocalSettings({ ...draft, serverPath: draft.serverPath || '/automatic-engine' });
        if (deps.stageOnly) return draft;
        if (pending) {
          const directory = modelDirectory();
          await fs.mkdir(directory, { recursive: true });
          const free = deps.diskSpace ? await deps.diskSpace(directory) : await fs.statfs(directory).then(d => d.bavail * d.bsize);
          let present = 0; for (const suffix of ['', '.part']) { try { present = Math.max(present, (await fs.stat(draft.modelPath + suffix)).size); } catch {} }
          if (free < Math.max(0, catalog[pending].bytes - present) + 512 * 1024 * 1024) throw new Error('Not enough disk space. Change the download location.');
          const selected = pending;
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'C Repair: preparing selected model', cancellable: true }, async (progress, token) => {
            const abort = new AbortController(); const subscription = token.onCancellationRequested(() => abort.abort());
            try { draft.modelPath = await withAssetLock(directory, () => (deps.download ?? downloadAsset)(assetFor(selected), directory, message => progress.report({ message }), abort.signal), abort.signal); }
            finally { subscription.dispose(); }
          });
        } else if (!await fs.stat(draft.modelPath).then(s => s.isFile()).catch(() => false)) throw new Error(known ? 'Model file is missing. Download this model again or select an existing file.' : 'Model file is missing. Use Model location to select an existing file.');
        const blockedAfterDownload = deps.applyBlocked?.();
        if (blockedAfterDownload) throw new Error(blockedAfterDownload);
        return draft;
      }
    } catch (e) { error = e instanceof Error && e.name === 'AbortError' ? 'Download cancelled. Your saved settings are unchanged.' : (e as Error).message; }
  }
}
