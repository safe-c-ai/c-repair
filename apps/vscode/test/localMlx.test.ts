import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MLX_MODELS, mlxRecommendation, mlxDefaults, isMlxModel, isManagedMlxReady, prepareMlxEngine } from '../src/bridge/localMlx';
import { LOCAL_PRESET, resolveLocalSettings, validateLocalSettings } from '../src/bridge/localSettings';
import { readSelectedTemplate } from '../src/bridge/ggufTemplate';
import { localSettingsText } from '../src/ui/headerMessage';

test('MLX memory recommendations and defaults leave generation room and disable unsupported tuning',()=>{
  assert.equal(mlxRecommendation(15),undefined);
  for(const [ram,id] of [[16,2],[24,3],[32,4],[48,5],[64,5],[128,5]]){
    assert.equal(mlxRecommendation(ram),`qwen38-mlx-${id}bit`);
    const s={...LOCAL_PRESET,effort: 'xhigh' as const,...mlxDefaults(ram),modelPath:'/models/local',serverPath:'/python'};
    validateLocalSettings(s);
    assert.ok(s.contextTokens>s.maxCompletionTokens);
    assert.equal(s.mtpDraftTokens,0);
    assert.match(localSettingsText(s),/Engine: MLX/);
    assert.doesNotMatch(localSettingsText(s),/GPU layers/);
  }
});
test('MLX catalog pins every file and retains the evaluated 5bit revision',()=>{
  for(const model of Object.values(MLX_MODELS)){
    assert.match(model.revision,/^[a-f0-9]{40}$/);
    assert.equal(model.bytes,model.files.reduce((n,f)=>n+f.bytes,0));
    for(const f of model.files){assert.match(f.sha256,/^[a-f0-9]{64}$/);assert.equal(path.basename(f.filename),f.filename);assert.ok(f.url.includes(model.revision));}
  }
  assert.equal(MLX_MODELS['qwen38-mlx-5bit'].revision,'2568951b893b6427d0a8eb91cc7f4307154c2f05');
});
test('MLX fields persist; existing GGUF remains unchanged and unsupported MTP is rejected',()=>{
  const s={...LOCAL_PRESET,effort: 'xhigh' as const,...mlxDefaults(64),mlxArtifact:'qwen38-mlx-5bit',modelPath:'/models/'+MLX_MODELS['qwen38-mlx-5bit'].filename,serverPath:'/python'};
  const read=resolveLocalSettings(k=>k==='configuration'?s:undefined);
  assert.equal(read.runtime,'mlx');assert.equal(read.mlxArtifact,s.mlxArtifact);validateLocalSettings(read);
  assert.throws(()=>validateLocalSettings({...read,mtpDraftTokens:2}),/MTP/);
  assert.equal(resolveLocalSettings(()=>undefined).runtime,undefined);
});
test('MLX folder validation and template metadata support both template storage layouts',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mlx-model-'));
  try{
    assert.equal(await isMlxModel(dir),false);
    await writeFile(path.join(dir,'config.json'),'{"model_type":"qwen3_5"}');
    await writeFile(path.join(dir,'model.safetensors'),'fixture');
    await writeFile(path.join(dir,'tokenizer_config.json'),'{"chat_template":"inline template"}');
    assert.equal(await isMlxModel(dir),true);
    assert.equal(await readSelectedTemplate(dir),'inline template');
    await writeFile(path.join(dir,'chat_template.jinja'),'separate template');
    assert.equal(await readSelectedTemplate(dir),'separate template');
    assert.equal(await isManagedMlxReady('qwen38-mlx-5bit',dir),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('MLX automatic engine fails explicitly on non-Mac hosts',async()=>{
  if(process.platform!=='darwin')await assert.rejects(prepareMlxEngine('/unused','/unused'),/Apple Silicon/);
});
