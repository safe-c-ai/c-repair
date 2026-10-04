import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufTemplate, readSelectedTemplate } from '../src/bridge/ggufTemplate';
import { analyzeTemplateReasoning, inspectTemplateReasoning, selectReasoning, templateReasoningLabel } from '../src/bridge/templateReasoning';
import { LOCAL_PRESET, type LocalSettings } from '../src/bridge/localSettings';
const tail = String.raw`{%- if add_generation_prompt %}
{%- if enable_thinking is defined and enable_thinking is false %}
{{- '<think>\n\n</think>\n\n' }}
{%- else %}{{- '<think>\n' }}{%- endif %}{%- endif %}`;
const qwen = `{%- if enable_thinking is undefined or enable_thinking is true %}
{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
{%- if resolved_reasoning_effort == 'high' %}{%- set resolved_reasoning_effort = 'xhigh' %}{%- endif %}
{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}{{- raise_exception('unsupported') }}{%- endif %}{%- endif %}\n${tail}`;
const settings: LocalSettings = { ...LOCAL_PRESET, effort: 'xhigh', preset: 'custom', modelPath: '/unused', serverPath: '/engine' };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
function gguf(template: string) { return Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(2),str('tokenizer.ggml.tokens'),u32(9),u32(8),u64(2),str('token1'),str('token2'),str('tokenizer.chat_template'),u32(8),str(template)]); }

test('extracts Qwen effort range, default and aliases without using model names', () => {
 const cap = analyzeTemplateReasoning(qwen);
 assert.deepEqual(cap.values, ['model','xhigh','medium','low','off']);
 assert.equal(cap.defaultValue, 'xhigh'); assert.deepEqual(cap.aliases, {high:'xhigh'});
 assert.equal(templateReasoningLabel(settings, cap), 'xhigh (model default)');
});
test('on/off templates and unfamiliar templates produce distinct choices', () => {
 assert.deepEqual(analyzeTemplateReasoning(tail).values, ['model','on','off']);
 assert.equal(analyzeTemplateReasoning(tail).defaultValue, 'on');
 assert.equal(analyzeTemplateReasoning('unfamiliar template').known, false);
 assert.ok(analyzeTemplateReasoning('unfamiliar template').values.includes('max'));
 assert.equal(analyzeTemplateReasoning("{% set reasoning_effort = 'special' %}" + tail).known, false);
});
test('GGUF metadata read skips tokenizer arrays; override template has priority; malformed files fail safely', async () => {
 const dir = await mkdtemp(join(tmpdir(),'crepair-gguf-test-'));
 try {
  const model = join(dir,'model.gguf'), external = join(dir,'override.jinja');
  await writeFile(model,gguf(qwen)); await writeFile(external,tail);
  assert.equal(await readGgufTemplate(model),qwen);
  assert.equal(await readSelectedTemplate(model,external),tail);
  assert.deepEqual((await inspectTemplateReasoning({...settings,modelPath:model,templatePath:external})).values,['model','on','off']);
  await writeFile(model,gguf(qwen).subarray(0,36));
  await assert.rejects(readGgufTemplate(model));
  assert.equal((await inspectTemplateReasoning({...settings,modelPath:model})).known,false);
  await writeFile(model,Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(1),u64(2**40)]));
  await assert.rejects(readGgufTemplate(model));
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('selection changes only reasoning keys for the chosen stage; default removes stale effort', () => {
 const s = {...settings, generation: { temperature: 0.8, chat_template_kwargs: { preserve_thinking:true, enable_thinking:false,reasoning_effort:'high' } }, structuredGeneration: {chat_template_kwargs:{enable_thinking:false}}};
 const detection = structuredClone(s.structuredGeneration);
 selectReasoning(s,'low');
 assert.deepEqual(s.generation,{temperature:0.8,chat_template_kwargs:{preserve_thinking:true,enable_thinking:true,reasoning_effort:'low'}});
 assert.deepEqual(s.structuredGeneration,detection);
 selectReasoning(s,'model');
 assert.deepEqual(s.generation,{temperature:0.8,chat_template_kwargs:{preserve_thinking:true}});
 selectReasoning(s,'on',true);
 assert.deepEqual(s.structuredGeneration,{chat_template_kwargs:{enable_thinking:true}});
});
test('preset overrides, defaults and template aliases display effective selections', () => {
 const s: LocalSettings = {...settings,preset:'qwen38-27b-q4km'};
 selectReasoning(s,'low');
 assert.equal(templateReasoningLabel(s,analyzeTemplateReasoning(qwen)),'low');
 selectReasoning(s,'model');
 assert.equal(templateReasoningLabel(s,analyzeTemplateReasoning(qwen)),'xhigh (model default)');
 selectReasoning(s,'high');
 assert.equal(templateReasoningLabel(s,analyzeTemplateReasoning(qwen)),'high → xhigh (template alias)');
 assert.equal(templateReasoningLabel(s,analyzeTemplateReasoning(qwen),true),'high → xhigh (template alias)');
});

test('Custom detection follows repair despite separate declaration options', () => {
 const s: LocalSettings = {...settings, structuredGeneration: {temperature: 0.6}};
 const cap = analyzeTemplateReasoning(qwen);
 assert.equal(templateReasoningLabel(s,cap,true),'xhigh (model default)');
 assert.equal(templateReasoningLabel(s,cap),'xhigh (model default)');
 selectReasoning(s,'model',true);
 assert.deepEqual(s.structuredGeneration,{temperature:0.6,chat_template_kwargs:{}});
 assert.equal(templateReasoningLabel(s,cap,true),'xhigh (model default)');
 selectReasoning(s,'on',true);
 assert.equal(templateReasoningLabel(s,cap,true),'xhigh (model default)');
});

test('Scan override is independent from repair and model default can be selected explicitly', () => {
 const s: LocalSettings = {...settings};
 const cap = analyzeTemplateReasoning(qwen);
 selectReasoning(s,'medium');
 selectReasoning(s,'xhigh','detection');
 assert.equal(templateReasoningLabel(s,cap),'medium');
 assert.equal(templateReasoningLabel(s,cap,true),'xhigh');
 selectReasoning(s,'off');
 assert.equal(templateReasoningLabel(s,cap,true),'xhigh');
 selectReasoning(s,'model','detection');
 assert.equal(templateReasoningLabel(s,cap,true),'xhigh (model default)');
 delete s.detectionGeneration;
 assert.equal(templateReasoningLabel(s,cap,true),'off');
});
