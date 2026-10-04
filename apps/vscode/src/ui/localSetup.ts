import { openLocalSettingsGuide } from './localSettingsGuide';
import { editMlxSettings } from './localMlxSettings';
import { prepareMlxEngine, prepareMlxModel, type MlxArtifact } from '../bridge/localMlx';
import { recommendLocalModel } from './localModelRecommendation';
import { LOCAL_LEADERBOARD_ITEM, openLocalLeaderboard } from './localLeaderboard';
import { artifactForSettings, editLocalModelSettings } from './localModelSettings';
import artifactCatalog from '../../resources/local-model-artifacts.json';
import { detectedUnifiedBand } from './localMacProfiles';
import { localHardwareSnapshot } from '../bridge/localMemory';
import { checkAutomaticEngineHost } from '../bridge/localEngine';
import { memoryAdvice, detectedVramBand, unifiedMemoryAdvice, type UnifiedBand, type VramBand } from './localMemoryAdvice';
import { setupDefaults } from './localSetupReview';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LOCAL_PRESETS, validateLocalSettings, type LocalSettings, type LocalPresetId } from '../bridge/localSettings';
import { downloadAsset, withAssetLock, type Asset } from '../bridge/localAssets';
import { prepareLocalEngine } from '../bridge/localEngine';

export function modelAsset(id: LocalPresetId): Asset | undefined {
  const preset = LOCAL_PRESETS[id];
  if (!('verifiedArtifact' in preset)) return undefined;
  const a = preset.verifiedArtifact;
  return { filename: a.filename, bytes: a.bytes, sha256: a.sha256,
    url: `https://huggingface.co/${a.repository}/resolve/${a.revision}/${a.filename}` };
}

export interface LocalSetupDeps {
  current?: LocalSettings;
  memoryInfo?: () => Promise<{ gpu?: string; vramGiB?: number; unified?: boolean; ramGiB: number }>;
  checkEngine?: typeof checkAutomaticEngineHost;
  pick?: typeof vscode.window.showQuickPick;
  open?: typeof vscode.window.showOpenDialog;
  input?: typeof vscode.window.showInputBox;
  prepareEngine?: typeof prepareLocalEngine;
  download?: typeof downloadAsset;
  diskSpace?: (directory: string) => Promise<number>;
}

/** One setup screen; saved models start without asking the user to reconfirm tuning. */
export async function localSetupWizard(context: vscode.ExtensionContext, preparePython: (progress: vscode.Progress<{message?: string}>, signal: AbortSignal) => Promise<string>, deps: LocalSetupDeps = {}): Promise<LocalSettings | undefined> {
  if (process.platform === 'darwin' && process.arch === 'arm64' && (!deps.current?.modelPath || deps.current.runtime === 'mlx')) {
    const settings = deps.current?.modelPath ? structuredClone(deps.current) : await editMlxSettings(context,undefined,{pick:deps.pick,open:deps.open,input:deps.input,stageOnly:true,startOnApply:true});
    if(!settings)return;
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'C Repair: preparing local model',cancellable:true},async(progress,token)=>{
      const abort=new AbortController(),sub=token.onCancellationRequested(()=>abort.abort());
      try{
        const python=await preparePython(progress,abort.signal);
        if(settings.runtime==='mlx'){
          await prepareMlxEngine(context.globalStorageUri.fsPath,context.extensionUri.fsPath,m=>progress.report({message:m}),abort.signal,python);
          if(settings.mlxArtifact)await prepareMlxModel(settings.mlxArtifact as MlxArtifact,settings.modelPath,m=>progress.report({message:m}),abort.signal);
        } else if(!settings.serverPath) await (deps.prepareEngine??prepareLocalEngine)(context.globalStorageUri.fsPath,context.extensionUri.fsPath,python,m=>progress.report({message:m}),abort.signal,settings.gpuLayers);
        validateLocalSettings({...settings,serverPath:settings.serverPath||'/automatic-engine'});
        return settings;
      }finally{sub.dispose();}
    });
  }
  const pick = deps.pick ?? vscode.window.showQuickPick;
  const open = deps.open ?? vscode.window.showOpenDialog;
  const input = deps.input ?? vscode.window.showInputBox;
  const info = await (deps.memoryInfo ?? localHardwareSnapshot)();
  const unified = info.unified === true;
  const detected = unified ? detectedUnifiedBand(info.ramGiB) : detectedVramBand(info.vramGiB);
  let ramGiB = info.ramGiB;
  let advice = unified ? unifiedMemoryAdvice(detected as UnifiedBand) : memoryAdvice(detected as VramBand, ramGiB);
  const saved = deps.current?.modelPath ? deps.current : undefined;
  let id: LocalPresetId = saved?.preset ?? (advice.candidate as LocalPresetId | undefined) ?? 'qwen38-27b-q4km';
  const hardware = { unified, ramGiB, vramGiB: info.vramGiB };
  let selected = saved ? undefined : recommendLocalModel(id, hardware);
  if (!saved) {
    let selectionError = '';
    while (true) {
      const recommended = advice.candidate;
      const models: LocalPresetId[] = ['qwen38-27b-q4km', 'ornith15-35b-a3b', 'custom'];
      models.sort((a, b) => Number(b === recommended) - Number(a === recommended));
      const capacity = (value: number) => `${Math.round(value)} GB`;
      const detectedMemory = unified ? `${capacity(ramGiB)} unified memory` :
        info.vramGiB === undefined ? `${capacity(ramGiB)} RAM · VRAM unavailable` :
        info.vramGiB === 0 ? `${capacity(ramGiB)} RAM · No NVIDIA GPU detected` :
        `${capacity(info.vramGiB)} VRAM · ${capacity(ramGiB)} RAM`;
      const rows = models.map(model => ({
        label: `${LOCAL_PRESETS[model].modelName}${model === recommended ? ' (Recommended)' : ''}`,
        id: model as string,
        description: model === 'qwen38-27b-q4km' ?
          (unified ? 'Accuracy · 16+ GB unified memory suggested' : 'Accuracy · 10+ GB VRAM suggested') :
          model === 'ornith15-35b-a3b' ? (unified ? 'Speed · 32+ GB unified memory' : 'Speed · Low VRAM or CPU-only · 32+ GB RAM') :
          'Use your own GGUF and inference settings',
        detail: model === 'custom' ? undefined : `Detected: ${detectedMemory}${model === 'qwen38-27b-q4km' ?
          (unified && detected === '16' ? ' · 16 GB profile is experimental' : !unified ? ' · Uses RAM offload when needed' : '') : ''}`,
      }));
      const choice = await pick([...rows, { label: LOCAL_LEADERBOARD_ITEM.label, id: 'leaderboard', description: LOCAL_LEADERBOARD_ITEM.description }], {
        title: 'C Repair · Select a model', placeHolder: selectionError || 'Choose a model. Quantization and memory settings are selected automatically.', ignoreFocusOut: true,
      });
      if (!choice) return;
      if (choice.id === 'leaderboard') { await openLocalLeaderboard(); continue; }
      id = choice.id as LocalPresetId;
      selected = recommendLocalModel(id, hardware);
      if (id !== 'custom' && !selected) {
        selectionError = `No automatic memory settings are available for ${LOCAL_PRESETS[id].modelName} on this computer. Choose another model or Custom for manual configuration.`;
        continue;
      }
      break;
    }
  }
  let settings = setupDefaults(id, saved);
  if (!saved && selected) Object.assign(settings, selected.settings);
  const selectedArtifact = selected ? artifactCatalog[selected.artifactId] : undefined;
  let asset: Asset | undefined = selectedArtifact ? { filename: selectedArtifact.filename, bytes: selectedArtifact.bytes, sha256: selectedArtifact.sha256,
    url: `https://huggingface.co/${selectedArtifact.repository}/resolve/${selectedArtifact.revision}/${selectedArtifact.filename}` } : undefined;
  let directory = saved ? path.dirname(saved.modelPath) : path.join(context.globalStorageUri.fsPath, 'local-models');
  if (asset) settings.modelPath = path.join(directory, asset.filename);
  let manual = Boolean(settings.serverPath);
  let startSaved = Boolean(saved && await isFile(saved.modelPath));
  if (saved && !startSaved) {
    const key = artifactForSettings(saved);
    if (key) { const a = artifactCatalog[key]; asset = { filename: a.filename, bytes: a.bytes, sha256: a.sha256, url: `https://huggingface.co/${a.repository}/resolve/${a.revision}/${a.filename}` }; }
  }
  let problem = saved && !startSaved ? 'The saved model file is missing. Select its new location.' : '';

  async function chooseFile(): Promise<void> {
    const files = await open({ canSelectMany: false, openLabel: 'Use this model', filters: { GGUF: ['gguf'] } });
    if (!files?.[0]) return;
    settings.modelPath = files[0].fsPath;
    directory = path.dirname(settings.modelPath);
    asset = undefined;
    settings.managedArtifact = undefined;
    problem = '';
  }
  async function guide(): Promise<void> {
    await openLocalSettingsGuide(context);
  }
  async function configure(): Promise<boolean> {
    const staged = { ...settings };
    if (asset) staged.managedArtifact = artifactForSettings({ ...settings, managedArtifact: undefined });
    const result = await editLocalModelSettings(context, staged, {
      pick, open, input, stageOnly: true,
      hardware: async () => ({ unified, ramGiB, vramGiB: info.vramGiB }),
    });
    if (!result) return false;
    settings = result;
    id = settings.preset ?? 'custom';
    manual = Boolean(settings.serverPath);
    directory = path.dirname(settings.modelPath);
    const key = settings.managedArtifact as keyof typeof artifactCatalog | undefined;
    if (key) { const a = artifactCatalog[key]; asset = { filename: a.filename, bytes: a.bytes, sha256: a.sha256, url: `https://huggingface.co/${a.repository}/resolve/${a.revision}/${a.filename}` }; }
    else asset = undefined;
    return true;
  }
  if (!saved && id === 'custom' && !settings.modelPath) {
    await chooseFile();
    if (!settings.modelPath) return;
  }
  while (true) {
    if (settings.runtime === 'mlx') return localSetupWizard(context,preparePython,{...deps,current:settings});
    if (!startSaved) {
      const cached = asset && await isFile(settings.modelPath);
      const row = await pick([
        { label: asset && !cached ? 'Download and start' : 'Start local model', action: 'start',
          description: settings.modelName ?? LOCAL_PRESETS[id].modelName,
          detail: asset ? `${cached ? 'Use downloaded model' : `Download: ${(asset.bytes / 1e9).toFixed(1)} GB`} · Save to: ${directory}` : `Model: ${settings.modelPath || 'Select an existing model'}` },
        ...(asset ? [{ label: 'Save location · Change', action: 'folder', detail: directory }] : []),
        { label: 'Change settings', action: 'settings', detail: 'Optional: model, reasoning, context and advanced settings.' },
        { label: 'Use an existing model', action: 'file', detail: 'Use the selected file in place; no copy.' },
        { label: 'Settings guide', action: 'guide', description: 'Included settings guide' },
        LOCAL_LEADERBOARD_ITEM,
      ], { title: 'C Repair · Set up local model', placeHolder: problem || (saved ? 'Your saved settings are retained.' : `Settings selected for this computer.${unified && detected === '16' ? ' 16 GB profile is experimental.' : ''}`), ignoreFocusOut: true });
      if (!row) return;
      if (row.action === 'folder') {
        const folders = await open({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true, defaultUri: vscode.Uri.file(directory), openLabel: 'Save models here' });
        if (folders?.[0] && asset) { directory = folders[0].fsPath; settings.modelPath = path.join(directory, asset.filename); problem = ''; }
        continue;
      }
      if (row.action === 'file') { await chooseFile(); continue; }
      if (row.action === 'leaderboard') { await openLocalLeaderboard(); continue; }
      if (row.action === 'guide') { await guide(); continue; }
      if (row.action === 'settings') {
        const before = structuredClone(settings);
        const previous = { id, asset, directory };
        if (!await configure()) { settings = before; id = previous.id; asset = previous.asset; directory = previous.directory; }
        manual = Boolean(settings.serverPath);
        continue;
      }
    }
    try {
      validateLocalSettings({ ...settings, serverPath: settings.serverPath || '/automatic-engine' });
      if (asset) {
        await fs.mkdir(directory, { recursive: true });
        await fs.access(directory, fs.constants.W_OK);
        const available = deps.diskSpace ? await deps.diskSpace(directory) : await fs.statfs(directory).then(d => d.bavail * d.bsize);
        let present = 0;
        for (const suffix of ['', '.part']) { try { present = Math.max(present, (await fs.stat(settings.modelPath + suffix)).size); } catch {} }
        if (available < Math.max(0, asset.bytes - present) + 512 * 1024 * 1024) throw new Error('Not enough free space. Change the save location or free disk space.');
      } else if (!await isFile(settings.modelPath)) throw new Error('Model file not found. Use an existing model to select its location.');
      if (!manual) await (deps.checkEngine ?? checkAutomaticEngineHost)(undefined, settings.gpuLayers);
      break;
    } catch (e) { problem = (e as Error).message; startSaved = false; }
  }
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'C Repair: preparing local model', cancellable: true }, async (progress, token) => {
    const abort = new AbortController(); const subscription = token.onCancellationRequested(() => abort.abort());
    try {
      const python = await preparePython(progress, abort.signal);
      abort.signal.throwIfAborted();
      if (!manual) settings.serverPath = await (deps.prepareEngine ?? prepareLocalEngine)(context.globalStorageUri.fsPath, context.extensionUri.fsPath, python, message => progress.report({ message }), abort.signal, settings.gpuLayers);
      if (asset) settings.modelPath = await withAssetLock(directory, () => (deps.download ?? downloadAsset)(asset!, directory, message => progress.report({ message }), abort.signal), abort.signal);
      if (asset) settings.managedArtifact = artifactForSettings({ ...settings, managedArtifact: undefined });
      validateLocalSettings(settings);
      if (!manual) settings.serverPath = '';
      return settings;
    } finally { subscription.dispose(); }
  });
}
async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}
