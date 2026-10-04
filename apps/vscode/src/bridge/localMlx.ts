import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import uvAsset from '../../resources/local-mlx-uv.json';
import catalog from '../../resources/local-mlx-models.json';
import { downloadAsset, withAssetLock } from './localAssets';
import type { LocalSettings } from './localSettings';
const exec = promisify(execFile);
export const MLX_MODELS = catalog;
export type MlxArtifact = keyof typeof catalog;
export function mlxRecommendation(ramGiB: number): MlxArtifact | undefined {
  if (!Number.isFinite(ramGiB) || ramGiB < 16) return;
  return ramGiB >= 48 ? 'qwen38-mlx-5bit' : ramGiB >= 32 ? 'qwen38-mlx-4bit' : ramGiB >= 24 ? 'qwen38-mlx-3bit' : 'qwen38-mlx-2bit';
}
export function mlxDefaults(ramGiB: number): Partial<LocalSettings> {
  return { runtime: 'mlx', preset: 'qwen38-27b-q4km', modelName: 'Qwen3.8-27B',
    contextTokens: ramGiB < 24 ? 32768 : 65536, maxCompletionTokens: ramGiB < 24 ? 16384 : 32768,
    structuredTokens: 4096, effort: 'xhigh', generation: {chat_template_kwargs: {enable_thinking:true, reasoning_effort:'xhigh'}},
    detectionGeneration: {}, structuredGeneration: {}, mtpDraftTokens:0, cpuExperts:false,
    timeoutSeconds:14400, gpuLayers:99, threads:0, batchSize:512, ubatchSize:512,
    cacheTypeK:'f16', cacheTypeV:'f16', serverPath:'', templatePath:'', managedArtifact:undefined };
}
export async function isMlxModel(directory: string): Promise<boolean> {
  try {
    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    const files = await fs.readdir(directory);
    return !!config.model_type && files.some(f => f.endsWith('.safetensors')) && files.includes('tokenizer_config.json');
  } catch { return false; }
}
export async function isManagedMlxReady(id: string, directory:string):Promise<boolean> {
  const model=catalog[id as MlxArtifact];
  if(!model)return false;
  try {
    const marker=JSON.parse(await fs.readFile(path.join(directory,'crepair-model.json'),'utf8'));
    if(marker.id!==id || marker.revision!==model.revision)return false;
    for(const f of model.files)if((await fs.stat(path.join(directory,f.filename))).size!==f.bytes)return false;
    return true;
  }catch{return false;}
}
export async function prepareMlxModel(id: MlxArtifact, directory: string, report: (s:string)=>void, signal?:AbortSignal): Promise<string> {
  const model = catalog[id];
  if (!model) throw new Error('Unknown MLX model. Select the model again.');
  return withAssetLock(directory, async () => {
    await fs.mkdir(directory, {recursive:true});
    const stat = await fs.statfs(directory);
    let needed = 0;
    for (const file of model.files) {
      let present = 0;
      for (const suffix of ['', '.part']) present = Math.max(present, await fs.stat(path.join(directory,file.filename+suffix)).then(s=>s.size,()=>0));
      needed += Math.max(0,file.bytes-present);
    }
    if (stat.bavail * stat.bsize < needed + 512*1024*1024) throw new Error('Not enough disk space for the MLX model. Change the model location.');
    for (const file of model.files) await downloadAsset(file,directory,report,signal);
    await fs.writeFile(path.join(directory,'crepair-model.json'),JSON.stringify({id,revision:model.revision}));
    return directory;
  },signal);
}
export async function prepareMlxEngine(storageDir:string, extensionDir:string, report:(s:string)=>void=()=>{}, signal?:AbortSignal, bootstrapPython?:string):Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MLX requires native Apple Silicon macOS. Use a GGUF model on this host.');
  const root=path.join(storageDir,'local-engines','mlx-0.32.2-lm-0.31.3-v1');
  return withAssetLock(root,async()=>{
    const python=path.join(root,'venv','bin','python');
    const probe="import mlx.core as mx, importlib.metadata as m; assert mx.metal.is_available(); assert m.version('mlx')=='0.32.2'; assert m.version('mlx-lm')=='0.31.3'";
    try { await fs.access(path.join(root,'ready')); await exec(python,['-c',probe],{signal,timeout:30000,maxBuffer:4096}); return python; } catch {signal?.throwIfAborted();}
    report('Preparing the Apple Silicon MLX environment…');
    let uv='';
    for (const candidate of ['uv',path.join(os.homedir(),'.local','bin','uv'),'/opt/homebrew/bin/uv']) {
      try {await exec(candidate,['--version'],{signal,timeout:5000});uv=candidate;break;} catch {signal?.throwIfAborted();}
    }
    if (!uv) {
      if(!bootstrapPython)throw new Error('MLX setup needs the C Repair bridge Python. Run local model setup first.');
      const archive=await downloadAsset(uvAsset,path.join(root,'downloads'),report,signal);
      uv=path.join(root,'uv');
      await exec(bootstrapPython,[path.join(extensionDir,'resources','install-mlx-uv.py'),archive,uv],{signal,timeout:60000,maxBuffer:4096});
      await exec(uv,['--version'],{signal,timeout:5000});
    }
    await fs.mkdir(root,{recursive:true});
    try {
      await exec(uv,['venv','--clear','--python','3.12',path.join(root,'venv')],{signal,timeout:600000,maxBuffer:65536});
      await exec(uv,['pip','install','--python',python,'-r',path.join(extensionDir,'resources','mlx-requirements.txt')],{signal,timeout:1200000,maxBuffer:65536});
      await exec(python,['-c',probe],{signal,timeout:30000,maxBuffer:4096});
      await fs.writeFile(path.join(root,'ready'),'1');
      return python;
    } catch { signal?.throwIfAborted(); throw new Error('Could not prepare MLX. Check network access and supported Apple Silicon macOS, then retry setup.'); }
  },signal);
}
