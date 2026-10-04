import { editMlxSettings } from '../../../src/ui/localMlxSettings';
import { editLocalModelSettings, type LocalModelSettingsDeps } from '../../../src/ui/localModelSettings';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import { setupDefaults } from '../../../src/ui/localSetupReview';
import { localSetupWizard as runLocalSetupWizard, type LocalSetupDeps } from '../../../src/ui/localSetup';

// Existing tuning/start tests accept the first recommended model; separate tests
// below exercise choosing a different model and cancelling the model screen.
async function localSetupWizard(context: vscode.ExtensionContext, prepare: Parameters<typeof runLocalSetupWizard>[1], deps: LocalSetupDeps) {
  return runLocalSetupWizard(context, prepare, { ...deps, pick: (async (rows: any, opts: any) => {
    if (opts.title === 'C Repair · Select a model') return rows[0];
    return deps.pick?.(rows, opts);
  }) as LocalSetupDeps['pick'] });
}

export function localSetup(root: Mocha.Suite): void {
  const suite = Mocha.Suite.create(root, 'Local setup wizard');
  suite.addTest(new Mocha.Test('Mac default download chooses MLX quantization automatically without changing current settings', async () => fixture(async (_dir,context) => {
    const result=await editMlxSettings(context,undefined,{stageOnly:true,startOnApply:true,hardware:async()=>({unified:true,ramGiB:64}),
      pick:(async(rows:any,opts:any)=>{
        if(opts.title==='C Repair · Select a local model'){
          assert.equal(rows.filter((r:any)=>r.id.startsWith('qwen38')).length,1);
          return rows.find((r:any)=>r.id==='qwen38-mlx-5bit');
        }
        assert.match(rows.find((r:any)=>r.id==='apply').label,/Download and start/);
        assert.ok(rows.some((r:any)=>r.id==='scan'));assert.ok(rows.some((r:any)=>r.id==='repair'));
        return rows.find((r:any)=>r.id==='apply');
      }) as LocalModelSettingsDeps['pick']});
    assert.equal(result?.runtime,'mlx');assert.equal(result?.mlxArtifact,'qwen38-mlx-5bit');
    assert.equal(result?.effort,'xhigh');assert.equal(result?.mtpDraftTokens,0);
  })));
  for(const folder of [true,false])suite.addTest(new Mocha.Test(`Mac Custom selects existing ${folder?'MLX folder':'GGUF'} without converting or copying`,async()=>fixture(async(dir,context)=>{
    const file=folder?path.join(dir,'mlx'):path.join(dir,'existing.gguf');
    if(folder){await fs.mkdir(file);await fs.writeFile(path.join(file,'config.json'),'{"model_type":"qwen3_5"}');await fs.writeFile(path.join(file,'tokenizer_config.json'),'{}');await fs.writeFile(path.join(file,'model.safetensors'),'fixture');}
    else await fs.writeFile(file,'fixture');
    const result=await editMlxSettings(context,undefined,{stageOnly:true,hardware:async()=>({unified:true,ramGiB:32}),
      open:async()=>[vscode.Uri.file(file)],
      pick:(async(rows:any,opts:any)=>opts.title==='C Repair · Select a local model'?rows.find((r:any)=>r.id==='custom'):rows.find((r:any)=>r.id==='apply'||r.action==='apply')) as LocalModelSettingsDeps['pick']});
    assert.equal(result?.modelPath,file);assert.equal(result?.runtime,folder?'mlx':'llama.cpp');assert.equal(result?.preset,'custom');assert.equal(result?.mlxArtifact,undefined);
  })));
  suite.addTest(new Mocha.Test('MLX settings cancellation discards reasoning changes',async()=>fixture(async(dir,context)=>{
    const current={...setupDefaults('custom'),runtime:'mlx' as const,modelPath:dir,mtpDraftTokens:0};
    const before=structuredClone(current);let screen=0;
    const result=await editMlxSettings(context,current,{stageOnly:true,hardware:async()=>({unified:true,ramGiB:64}),
      pick:(async(rows:any,opts:any)=>{
        if(opts.title==='C Repair · Scan reasoning')return rows.find((r:any)=>r.value==='xhigh');
        return ++screen===1?rows.find((r:any)=>r.id==='scan'):undefined;
      }) as LocalModelSettingsDeps['pick']});
    assert.equal(result,undefined);assert.deepEqual(current,before);
  })));
  suite.addTest(new Mocha.Test('local configuration can be saved through the real settings API', async () => {
    const cfg = vscode.workspace.getConfiguration('crepair');
    const previous = cfg.inspect('local.configuration')?.globalValue;
    const value = { preset: 'qwen38-27b', contextTokens: 65536 };
    try {
      await cfg.update('local.configuration', value, vscode.ConfigurationTarget.Global);
      assert.deepEqual(vscode.workspace.getConfiguration('crepair').inspect('local.configuration')?.globalValue, value);
    } finally {
      await cfg.update('local.configuration', previous, vscode.ConfigurationTarget.Global);
    }
  }));
  async function fixture(run: (dir: string, context: vscode.ExtensionContext, deps: LocalSetupDeps) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crepair-setup-'));
    const context = { globalStorageUri: vscode.Uri.file(dir), extensionUri: vscode.Uri.file(dir) } as vscode.ExtensionContext;
    try {
      await run(dir, context, {
        memoryInfo: async () => ({ unified: true, ramGiB: 32 }), checkEngine: async () => {}, prepareEngine: async () => '/engine',
        diskSpace: async () => 1e12,
        download: async (asset, directory) => { const file = path.join(directory, asset.filename); await fs.writeFile(file, 'test GGUF'); return file; },
      });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  suite.addTest(new Mocha.Test('user chooses Ornith on Mac; allocation is automatic and restore keeps Ornith', async () => fixture(async (_dir, context, deps) => {
    const screens: string[] = [];
    const result = await runLocalSetupWizard(context, async () => '/python', { ...deps,
      pick: (async (rows: any, opts: any) => {
        screens.push(opts.title);
        return opts.title === 'C Repair · Select a model' ? rows.find((r: any) => r.id === 'ornith15-35b-a3b') : rows.find((r: any) => r.action === 'start');
      }) as LocalSetupDeps['pick'],
    });
    assert.deepEqual(screens, ['C Repair · Select a model', 'C Repair · Set up local model']);
    assert.equal(result?.preset, 'ornith15-35b-a3b');
    assert.equal(result?.managedArtifact, 'ornith15:Q4_K_M');
    assert.equal(result?.gpuLayers, 99);
    assert.equal(result?.cpuExperts, false);
    let edited = false;
    const restored = await editLocalModelSettings(context, { ...result!, contextTokens: 8192, maxCompletionTokens: 4096 }, {
      stageOnly: true, hardware: async () => ({ unified: true, ramGiB: 32 }),
      pick: (async (rows: any) => { const action = edited ? 'apply' : 'reset'; edited = true; assert.ok(!rows.some((r: any) => r.action === 'error')); return rows.find((r: any) => r.action === action); }) as LocalModelSettingsDeps['pick'],
    });
    assert.equal(restored?.preset, 'ornith15-35b-a3b');
    assert.equal(restored?.contextTokens, 65536);
  })));
  suite.addTest(new Mocha.Test('cancelling model selection performs no preparation', async () => fixture(async (_dir, context, deps) => {
    const result = await runLocalSetupWizard(context, async () => { throw new Error('Must not prepare'); }, { ...deps,
      pick: (async (_rows: any, opts: any) => { assert.equal(opts.title, 'C Repair · Select a model'); return undefined; }) as LocalSetupDeps['pick'],
    });
    assert.equal(result, undefined);
    assert.deepEqual(await fs.readdir(_dir), []);
  })));
  suite.addTest(new Mocha.Test('Mac setup has one start action and automatically selects capacity settings', async () => fixture(async (_dir, context, deps) => {
    let screens = 0;
    const result = await localSetupWizard(context, async () => '/python', { ...deps,
      pick: (async (rows: any, opts: any) => {
        screens++; assert.equal(opts.title, 'C Repair · Set up local model');
        assert.equal(rows[0].label, 'Download and start');
        assert.match(rows[0].detail, /16.5 GB/);
        assert.ok(!rows.some((r: any) => r.key === 'contextTokens'));
        return rows[0];
      }) as LocalSetupDeps['pick'],
    });
    assert.equal(screens, 1);
    assert.equal(result?.contextTokens, 131072);
    assert.equal(result?.maxCompletionTokens, 65536);
    assert.equal(result?.cacheTypeK, 'q8_0');
    assert.equal(result?.effort, 'medium');
  })));
  suite.addTest(new Mocha.Test('10 GB setup downloads Q2 with partial RAM placement in one screen', async () => fixture(async (_dir, context, deps) => {
    let screens = 0;
    const result = await localSetupWizard(context, async () => '/python', { ...deps,
      memoryInfo: async () => ({ unified: false, ramGiB: 32, vramGiB: 10 }),
      pick: (async (rows: any, opts: any) => { screens++; assert.equal(opts.title, 'C Repair · Set up local model'); assert.match(rows[0].detail, /9.8 GB/); return rows[0]; }) as LocalSetupDeps['pick'],
    });
    assert.equal(screens, 1);
    assert.equal(result?.managedArtifact, 'qwen38:UD-Q2_K_XL');
    assert.equal(result?.gpuLayers, 40);
    assert.equal(result?.contextTokens, 65536);
    assert.equal(result?.effort, 'medium');
  })));
  for (const vram of [8, 0]) suite.addTest(new Mocha.Test(`${vram} GB setup selects Ornith while retaining existing Qwen settings`, async () => fixture(async (dir, context, deps) => {
    const hardware = { ...deps, memoryInfo: async () => ({ unified: false, ramGiB: 32, vramGiB: vram }) };
    const result = await localSetupWizard(context, async () => '/python', { ...hardware,
      pick: (async (rows: any) => rows[0]) as LocalSetupDeps['pick'],
    });
    assert.equal(result?.preset, 'ornith15-35b-a3b');
    assert.equal(result?.managedArtifact, 'ornith15:Q4_K_M');
    assert.equal(result?.gpuLayers, vram === 0 ? 0 : 24);
    const saved = { ...setupDefaults('qwen36-35b-a3b'), modelPath: path.join(dir, 'old.gguf'), gpuLayers: 9 };
    await fs.writeFile(saved.modelPath, 'model');
    const retained = await localSetupWizard(context, async () => '/python', { ...hardware, current: saved,
      pick: (async () => { throw new Error('No confirmation for saved settings'); }) as LocalSetupDeps['pick'],
    });
    assert.equal(retained?.preset, 'qwen36-35b-a3b');
    assert.equal(retained?.gpuLayers, 9);
  })));
  suite.addTest(new Mocha.Test('cancel before start prepares nothing', async () => fixture(async (_dir, context, deps) => {
    const result = await localSetupWizard(context, async () => { throw new Error('Must not prepare'); }, { ...deps, pick: (async () => undefined) as LocalSetupDeps['pick'] });
    assert.equal(result, undefined);
    assert.deepEqual(await fs.readdir(_dir), []);
  })));
  suite.addTest(new Mocha.Test('save location changes the actual download destination without copying elsewhere', async () => fixture(async (_dir, context, deps) => {
    const external = path.join(_dir, 'External SSD'); await fs.mkdir(external);
    let screens = 0;
    const result = await localSetupWizard(context, async () => '/python', { ...deps,
      pick: (async (rows: any) => ++screens === 1 ? rows.find((r: any) => r.action === 'folder') : rows[0]) as LocalSetupDeps['pick'],
      open: async opts => { assert.equal(opts?.canSelectFolders, true); return [vscode.Uri.file(external)]; },
    });
    assert.equal(path.dirname(result!.modelPath), external);
    assert.deepEqual(await fs.readdir(_dir), ['External SSD']);
  })));
  suite.addTest(new Mocha.Test('existing GGUF is used in place and not downloaded', async () => fixture(async (_dir, context, deps) => {
    const file = path.join(_dir, 'existing.gguf'); await fs.writeFile(file, 'existing');
    let screens = 0;
    const result = await localSetupWizard(context, async () => '/python', { ...deps,
      pick: (async (rows: any) => ++screens === 1 ? rows.find((r: any) => r.action === 'file') : rows[0]) as LocalSetupDeps['pick'],
      open: async () => [vscode.Uri.file(file)], download: async () => { throw new Error('No download'); },
    });
    assert.equal(result?.modelPath, file);
    assert.equal(await fs.readFile(file, 'utf8'), 'existing');
  })));
  suite.addTest(new Mocha.Test('saved model starts without a confirmation even after memory capacity changes', async () => fixture(async (_dir, context, deps) => {
    const file = path.join(_dir, 'saved.gguf'); await fs.writeFile(file, 'saved');
    const current = { ...setupDefaults('qwen38-27b-q4km'), modelPath: file, contextTokens: 98304, threads: 7 };
    const result = await localSetupWizard(context, async () => '/python', { ...deps, current,
      memoryInfo: async () => ({ unified: true, ramGiB: 96 }),
      pick: (async () => { throw new Error('No confirmation'); }) as LocalSetupDeps['pick'],
    });
    assert.deepEqual(result, current);
  })));
  suite.addTest(new Mocha.Test('disk shortage returns to save location before preparing Python or engine', async () => fixture(async (_dir, context, deps) => {
    let screens = 0;
    const result = await localSetupWizard(context, async () => { throw new Error('No preparation'); }, { ...deps,
      diskSpace: async () => 0,
      pick: (async (rows: any, opts: any) => {
        if (++screens === 1) return rows[0];
        assert.match(opts.placeHolder, /Not enough free space/);
        assert.ok(rows.some((r: any) => r.action === 'folder'));
        return undefined;
      }) as LocalSetupDeps['pick'],
    });
    assert.equal(result, undefined);
    assert.equal(screens, 2);
  })));
  suite.addTest(new Mocha.Test('cancelled advanced edits are discarded without a second approval screen', async () => fixture(async (_dir, context, deps) => {
    let main = 0, advanced = 0;
    const result = await localSetupWizard(context, async () => '/python', { ...deps,
      input: async () => '65536',
      pick: (async (rows: any, opts: any) => {
        if (opts.title === 'C Repair · Reasoning') return rows.find((r: any) => r.value === 'medium');
        if (opts.title === 'C Repair · Local model settings') return ++advanced === 1 ? rows.find((r: any) => r.action === 'reasoning') : undefined;
        return ++main === 1 ? rows.find((r: any) => r.action === 'settings') : rows[0];
      }) as LocalSetupDeps['pick'],
    });
    assert.equal(result?.contextTokens, 131072);
    assert.equal(main, 2);
  })));
  suite.addTest(new Mocha.Test('Custom reasoning opens a picker and stages off without JSON or changing detection', async () => fixture(async (dir, context) => {
    const file = path.join(dir, 'custom.gguf'); await fs.writeFile(file, 'fixture');
    const current = { ...setupDefaults('custom'), modelPath: file, generation: { temperature: 0.6 }, structuredGeneration: {} };
    const original = structuredClone(current); let main = 0;
    const result = await editLocalModelSettings(context, current, {
      hardware: async () => ({ unified: false, ramGiB: 64, vramGiB: 12 }),
      input: async () => { throw new Error('Normal reasoning selection must not open JSON'); },
      pick: (async (rows: any, opts: any) => {
        if (opts.title === 'C Repair · Reasoning') {
          assert.ok(rows.some((r: any) => r.value === 'max'));
          assert.ok(rows.some((r: any) => r.value === 'custom'));
          assert.match(opts.placeHolder, /unverified/);
          return rows.find((r: any) => r.value === 'off');
        }
        const action = ++main === 1 ? 'reasoning' : 'apply';
        return rows.find((r: any) => r.action === action);
      }) as LocalModelSettingsDeps['pick'],
    });
    assert.deepEqual(current, original);
    assert.deepEqual(result?.generation, { temperature: 0.6, chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(result?.structuredGeneration, {});
  })));
  for (const apply of [true, false]) {
    suite.addTest(new Mocha.Test(`Scan reasoning stages independently; apply=${apply}`, async () => fixture(async (dir, context) => {
      const file = path.join(dir, 'custom.gguf'); await fs.writeFile(file, 'fixture');
      const current = { ...setupDefaults('custom'), modelPath: file, generation: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'medium' } } };
      const original = structuredClone(current); let main = 0;
      const result = await editLocalModelSettings(context, current, {
        hardware: async () => ({ unified: false, ramGiB: 64, vramGiB: 12 }),
        input: async () => { throw new Error('Reasoning selection must not open JSON'); },
        pick: (async (rows: any, opts: any) => {
          if (opts.title === 'C Repair · Scan reasoning') return rows.find((r: any) => r.value === 'xhigh');
          assert.ok(rows.some((r: any) => r.label === 'Scan reasoning'));
          assert.ok(rows.some((r: any) => r.label === 'Repair reasoning'));
          const action = ++main === 1 ? 'detectionReasoning' : apply ? 'apply' : undefined;
          return action ? rows.find((r: any) => r.action === action) : undefined;
        }) as LocalModelSettingsDeps['pick'],
      });
      assert.deepEqual(current, original);
      if (apply) {
        assert.deepEqual(result?.generation, current.generation);
        assert.deepEqual(result?.detectionGeneration, { chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'xhigh' } });
      } else assert.equal(result, undefined);
    })));
  }
  for (const scenario of ['cancel', 'reasoning', 'reset', 'recover', 'quantization'] as const) {
    suite.addTest(new Mocha.Test(`Settings editor: ${scenario}`, async () => fixture(async (dir, context, setupDeps) => {
      const filename = 'Qwen3.8-27B-UD-Q4_K_M.gguf';
      const file = path.join(dir, filename);
      if (scenario !== 'recover') await fs.writeFile(file, 'saved');
      const current = { ...setupDefaults('qwen38-27b-q4km'), modelPath: file, managedArtifact: 'qwen38:UD-Q4_K_M', contextTokens: 65536, threads: 7 };
      const original = structuredClone(current);
      let screen = 0, downloads = 0;
      const result = await editLocalModelSettings(context, current, {
        hardware: async () => ({ unified: true, ramGiB: 32 }), diskSpace: async () => 1e12,
        download: async (...args) => { downloads++; return setupDeps.download!(...args); },
        pick: (async (rows: any, opts: any) => {
          if (opts.title === 'C Repair · Reasoning') return rows.find((r: any) => r.value === 'medium');
          if (opts.title === 'C Repair · Model and quantization') return rows.find((r: any) => r.id === 'qwen38:UD-Q5_K_M');
          assert.equal(opts.title, 'C Repair · Local model settings');
          assert.ok(rows.some((r: any) => r.action === 'reasoning'));
          assert.ok(!rows.some((r: any) => r.key === 'gpuLayers'));
          if (++screen === 1) return rows.find((r: any) => r.action === ({ cancel: 'reasoning', reasoning: 'reasoning', reset: 'reset', recover: 'recover', quantization: 'model' }[scenario]));
          if (scenario === 'cancel') return undefined;
          assert.ok(!rows.some((r: any) => r.action === 'error'), JSON.stringify(rows));
          return rows.find((r: any) => r.action === 'apply');
        }) as LocalModelSettingsDeps['pick'],
      });
      assert.deepEqual(current, original, 'editing must not mutate saved settings');
      if (scenario === 'cancel') { assert.equal(result, undefined); assert.equal(downloads, 0); }
      if (scenario === 'reasoning') { assert.equal(result?.effort, 'medium'); assert.equal(result?.threads, 7); assert.equal(downloads, 0); }
      if (scenario === 'reset') { assert.equal(result?.contextTokens, 131072); assert.equal(result?.cacheTypeK, 'q8_0'); assert.equal(result?.threads, 0); assert.equal(downloads, 1); }
      if (scenario === 'recover') { assert.equal(result?.modelPath, file); assert.equal(downloads, 1); }
      if (scenario === 'quantization') { assert.match(result!.modelPath, /UD-Q5_K_M/); assert.equal(result?.managedArtifact, 'qwen38:UD-Q5_K_M'); assert.equal(result?.threads, 7); assert.equal(downloads, 1); }
    })));
  }

}
