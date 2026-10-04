import { openLocalSettingsGuide } from './localSettingsGuide';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MLX_MODELS, mlxRecommendation, mlxDefaults, isMlxModel, isManagedMlxReady, prepareMlxModel, type MlxArtifact } from '../bridge/localMlx';
import { localHardwareSnapshot } from '../bridge/localMemory';
import { validateLocalSettings, validateGeneration, type LocalSettings } from '../bridge/localSettings';
import { inspectTemplateReasoning, selectReasoning, templateReasoningLabel } from '../bridge/templateReasoning';
import { setupDefaults } from './localSetupReview';
import { editLocalModelSettings, type LocalModelSettingsDeps } from './localModelSettings';
import { LOCAL_LEADERBOARD_ITEM, openLocalLeaderboard } from './localLeaderboard';

/** Mac downloads use MLX. Existing GGUFs are an explicit Custom choice. */
export async function editMlxSettings(context:vscode.ExtensionContext, current:LocalSettings|undefined,
  deps:LocalModelSettingsDeps={}, chooseModel=false):Promise<LocalSettings|undefined> {
  const pick=deps.pick??vscode.window.showQuickPick, open=deps.open??vscode.window.showOpenDialog, input=deps.input??vscode.window.showInputBox;
  const hardware=await (deps.hardware??localHardwareSnapshot)();
  const recommended=mlxRecommendation(hardware.ramGiB);
  let draft=current?structuredClone(current):{...setupDefaults('qwen38-27b-q4km'),...mlxDefaults(hardware.ramGiB)};
  let error='', pending=false;
  const directory=()=>draft.mlxArtifact?path.dirname(draft.modelPath):path.join(context.globalStorageUri.fsPath,'local-models');
  async function model(initial=false):Promise<boolean> {
    const choice=await pick([
      ...Object.entries(MLX_MODELS).filter(([id])=>!initial || id===recommended).map(([id,m])=>({label:initial?'Qwen3.8-27B (Recommended)':`Qwen3.8-27B · MLX ${m.quantization}${id===recommended?' (Recommended)':''}`,id,description:`${(m.bytes/1e9).toFixed(1)} GB download`,detail:id==='qwen38-mlx-2bit'?'16 GB profile is experimental; long reasoning needs additional memory.':undefined})),
      {label:'Custom model',id:'custom',description:'Choose an MLX folder or a GGUF file; use it in place'},
      {...LOCAL_LEADERBOARD_ITEM,id:'leaderboard'},
    ],{title:'C Repair · Select a local model',placeHolder:`Detected: ${Math.round(hardware.ramGiB)} GB unified memory · Downloads use MLX`,ignoreFocusOut:true});
    if (!choice) return false;
    if(choice.id==='leaderboard'){await openLocalLeaderboard();return model(initial);}
    if(choice.id==='custom') {
      const files=await open({canSelectMany:false,canSelectFiles:true,canSelectFolders:true,openLabel:'Use MLX folder or GGUF'});
      if(!files?.[0])return false;
      const file=files[0].fsPath;
      const folder=await fs.stat(file).then(s=>s.isDirectory());
      if(folder && !await isMlxModel(file))throw new Error('Select an MLX model folder containing config.json, tokenizer_config.json and safetensors weights.');
      if(!folder && !file.toLowerCase().endsWith('.gguf'))throw new Error('Select a GGUF file or an MLX model folder.');
      draft={...setupDefaults('custom'),runtime:folder?'mlx':'llama.cpp',modelPath:file,mtpDraftTokens:0,
        modelName:path.basename(file),serverPath:'',timeoutSeconds:14400,threads:0};
      pending=false;
    } else {
      const id=choice.id as MlxArtifact, m=MLX_MODELS[id], dest=directory();
      const retain=draft.runtime==='mlx' && draft.preset==='qwen38-27b-q4km';
      draft={...(retain?draft:{...setupDefaults('qwen38-27b-q4km'),...mlxDefaults(hardware.ramGiB)}),
        mlxArtifact:id,modelPath:path.join(dest,m.filename),managedArtifact:undefined,runtime:'mlx',serverPath:''};
      pending=true;
    }
    return true;
  }
  async function reasoning(scan:boolean):Promise<void> {
    const cap=await inspectTemplateReasoning(draft);
    const rows=cap.values.map(value=>({label:value==='model'?'Model default':value,value}));
    if(scan)rows.unshift({label:'Same as repair',value:'inherit'});
    rows.push({label:'Custom…',value:'custom'});
    const c=await pick(rows,{title:scan?'C Repair · Scan reasoning':'C Repair · Repair reasoning',placeHolder:`Current: ${templateReasoningLabel(draft,cap,scan)}`,ignoreFocusOut:true});
    if(!c)return;
    if(c.value==='inherit'){delete draft.detectionGeneration;return;}
    if(c.value==='custom') {
      const key=scan?'detectionGeneration':'generation';
      const value=await input({title:'Reasoning template options (JSON)',value:JSON.stringify(draft[key]?.chat_template_kwargs??{}),ignoreFocusOut:true,
        validateInput:text=>{try{validateGeneration({chat_template_kwargs:JSON.parse(text)});return undefined;}catch(e){return (e as Error).message;}}});
      if(value!==undefined)draft[key]={...draft[key],chat_template_kwargs:JSON.parse(value)};
    } else selectReasoning(draft,c.value,scan?'detection':false);
  }
  async function advanced():Promise<void> {
    const numbers={contextTokens:'Context length (input + reasoning + answer)',maxCompletionTokens:'Generation limit (reasoning + answer)',structuredTokens:'Declaration completion limit',timeoutSeconds:'Timeout (seconds)'} as const;
    while(true){
      const c=await pick([{label:'Back',id:'back'},...Object.entries(numbers).map(([id,label])=>({label,id,description:String(draft[id as keyof typeof numbers])})),
        {label:'Sampling and template options',id:'sampling',description:'JSON · repair, Scan overrides and declarations'},
        {label:'Chat template file',id:'template',description:draft.templatePath||'Model default'},
      ],{title:'C Repair · Advanced MLX settings',placeHolder:'Metal · model dtype KV · parallel 1 · MTP unavailable',ignoreFocusOut:true});
      if(!c||c.id==='back')return;
      if(c.id==='template'){
        const v=await input({title:'Chat template file (empty = model default)',value:draft.templatePath??'',ignoreFocusOut:true});if(v!==undefined)draft.templatePath=v;
      }else if(c.id==='sampling'){
        const value=await input({title:'MLX generation options (JSON)',value:JSON.stringify({generation:draft.generation??{},detectionGeneration:draft.detectionGeneration??{},structuredGeneration:draft.structuredGeneration??{}}),ignoreFocusOut:true,
          validateInput:text=>{try{const d=JSON.parse(text);if(!d||typeof d!=='object'||Array.isArray(d))throw new Error('Enter an object.');for(const k of Object.keys(d)){if(!['generation','detectionGeneration','structuredGeneration'].includes(k))throw new Error('Unknown option.');validateGeneration(d[k]);}return undefined;}catch(e){return (e as Error).message;}}});
        if(value!==undefined)Object.assign(draft,JSON.parse(value));
      }else{
        const key=c.id as keyof typeof numbers;
        const v=await input({title:numbers[key],value:String(draft[key]),ignoreFocusOut:true,validateInput:t=>Number.isInteger(Number(t))&&Number(t)>0&&Number(t)<=1048576?undefined:'Enter a positive whole number up to 1048576.'});
        if(v!==undefined)draft[key]=Number(v);
      }
    }
  }
  if(!current?.modelPath||chooseModel){
    try{if(!await model(!current?.modelPath))return;}catch(e){await vscode.window.showErrorMessage((e as Error).message);return;}
  }
  while(true){
    if(draft.runtime!=='mlx')return editLocalModelSettings(context,draft,{...deps,stageOnly:deps.stageOnly});
    const cap=await inspectTemplateReasoning(draft);
    const artifact=draft.mlxArtifact?MLX_MODELS[draft.mlxArtifact as MlxArtifact]:undefined;
    const missing=!(draft.mlxArtifact ? await isManagedMlxReady(draft.mlxArtifact,draft.modelPath) : await isMlxModel(draft.modelPath));
    const c=await pick([
      {label:`$(check) ${deps.startOnApply?(pending||missing&&artifact?'Download and start':'Start local model'):deps.stageOnly?'Done':pending||missing&&artifact?'Download and apply':'Apply changes'}`,id:'apply',description:deps.startOnApply?'Prepare the MLX environment and start this model':deps.stageOnly?'Return to setup': 'Save all changes; use them on the next Scan'},
      {label:'Scan reasoning',id:'scan',description:templateReasoningLabel(draft,cap,true)},
      {label:'Repair reasoning',id:'repair',description:templateReasoningLabel(draft,cap)},
      {label:'Model and quantization',id:'model',description:artifact?`Qwen3.8-27B · MLX ${artifact.quantization}`:draft.modelName,detail:draft.modelPath},
      {label:'Model location',id:'location',description:artifact?'Change download folder':'Use an existing MLX folder or GGUF',detail:draft.modelPath},
      {label:'Advanced settings',id:'advanced',description:`${draft.contextTokens/1024}K context · ${draft.maxCompletionTokens/1024}K generation · MLX / Metal`},
      ...(artifact?[{label:'Download this model again',id:'recover',description:'Verify files and resume incomplete downloads'}, {label:'Restore recommended settings',id:'reset',description:'Reset inference settings for this Mac'}]:[]),
      {label:'Settings guide',id:'guide',description:'Included settings guide'}, {...LOCAL_LEADERBOARD_ITEM,id:'leaderboard'},
    ],{title:'C Repair · Local model settings',placeHolder:error||'MLX · Esc cancels unsaved changes',ignoreFocusOut:true});
    if(!c)return;
    error='';
    try{
      if(c.id==='scan'||c.id==='repair')await reasoning(c.id==='scan');
      else if(c.id==='model')await model();
      else if(c.id==='advanced')await advanced();
      else if(c.id==='guide')await openLocalSettingsGuide(context);
      else if(c.id==='leaderboard')await openLocalLeaderboard();
      else if(c.id==='reset')Object.assign(draft,mlxDefaults(hardware.ramGiB));
      else if(c.id==='recover')pending=true;
      else if(c.id==='location'){
        if(!artifact){await model();continue;}
        const folders=await open({canSelectMany:false,canSelectFiles:false,canSelectFolders:true,openLabel:'Download models here'});
        if(folders?.[0]){draft.modelPath=path.join(folders[0].fsPath,artifact.filename);pending=true;}
      }else if(c.id==='apply'){
        const blocked=deps.applyBlocked?.();if(blocked)throw new Error(blocked);
        validateLocalSettings({...draft,serverPath:draft.serverPath||'/automatic-engine'});
        if(deps.stageOnly)return draft;
        if(artifact&&(pending||missing))await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'C Repair: downloading MLX model',cancellable:true},async(progress,token)=>{
          const abort=new AbortController(),sub=token.onCancellationRequested(()=>abort.abort());
          try{await prepareMlxModel(draft.mlxArtifact as MlxArtifact,draft.modelPath,m=>progress.report({message:m}),abort.signal);}finally{sub.dispose();}
        });
        if(!await isMlxModel(draft.modelPath))throw new Error('MLX model folder is missing or incomplete. Select the model again.');
        const blockedAfter=deps.applyBlocked?.();if(blockedAfter)throw new Error(blockedAfter);
        return draft;
      }
    }catch(e){error=e instanceof Error&&e.name==='AbortError'?'Download cancelled; saved settings are unchanged.':(e as Error).message;}
  }
}
