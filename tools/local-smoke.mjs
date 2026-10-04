// Run from the monorepo root: node --import tsx tools/local-smoke.mjs <llama-server> <model.gguf>
// Uses the development bridge venv. All inference is loopback-only. The model is
// always stopped on completion/failure; the temporary synthetic output is removed.
import { LocalRuntime } from '../apps/vscode/src/bridge/LocalRuntime.ts';
import { LOCAL_PRESET, LOCAL_PRESETS, localBridgeEnv } from '../apps/vscode/src/bridge/localSettings.ts';
import { gpuMemorySummary } from '../apps/vscode/src/bridge/localMemory.ts';
import { memorySample } from './local-smoke-metrics.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHunks } from '../packages/core/src/patches.js';

if (![4, 5].includes(process.argv.length) || (process.argv[4] && !['--custom-qwen38', '--qwen36-gpu', '--qwen36-ram'].includes(process.argv[4]))) throw new Error('Usage: node --import tsx tools/local-smoke.mjs <llama-server> <model.gguf> [--custom-qwen38|--qwen36-gpu|--qwen36-ram]');
const root = fileURLToPath(new URL('../', import.meta.url));
const settings = { ...LOCAL_PRESET, serverPath: resolve(process.argv[2]), modelPath: resolve(process.argv[3]) };
if (process.argv[4] === '--custom-qwen38') {
  Object.assign(settings, { preset: 'custom', modelName: 'Qwen3.8-27B custom', effort: 'model',
    generation: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1, presence_penalty: 0,
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true, reasoning_effort: 'xhigh' } },
    structuredGeneration: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, repeat_penalty: 1, presence_penalty: 1.5,
      chat_template_kwargs: { enable_thinking: false } } });
}
if (process.argv[4]?.startsWith('--qwen36-')) {
  Object.assign(settings, LOCAL_PRESETS['qwen36-35b-a3b'], { cpuExperts: process.argv[4] === '--qwen36-ram' });
}
const runtime = new LocalRuntime();
const temp = mkdtempSync(join(tmpdir(), 'crepair-local-smoke-'));
const output = join(temp, 'result.json');
const measurements = { settings, baseline: await memorySample(), samples: [], status: 'running' };
let timer, inFlight;
try {
  console.log('Loading managed local runtime');
  const started = Date.now();
  const port = await runtime.start(settings);
  measurements.loadSeconds = (Date.now() - started) / 1000;
  measurements.loaded = await memorySample(port);
  timer = setInterval(() => {
    if (!inFlight) inFlight = memorySample(port).then(s => measurements.samples.push(s)).finally(() => { inFlight = undefined; });
  }, 2000);
  console.log('Loaded:', await gpuMemorySummary() ?? 'GPU memory measurement unavailable');
  const env = { ...process.env, ...localBridgeEnv(settings, port), CREPAIR_SMOKE_OUTPUT: output };
  delete env.OPENROUTER_API_KEY;
  const python = process.env.CREPAIR_SMOKE_PYTHON || join(root, 'services/repair-api/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const code = await new Promise(resolve => {
    const child = spawn(python, [join(root, 'services/repair-api/scripts/local-smoke.py')], { env, stdio: 'inherit' });
    child.on('exit', resolve); child.on('error', () => resolve(1));
  });
  if (!existsSync(output)) throw new Error('Live local bridge verification failed before producing a candidate');
  const { source, candidate, metrics } = JSON.parse(readFileSync(output, 'utf8'));
  measurements.pipeline = metrics;
  measurements.gates = candidate.validations.map(g => ({ name: g.name, status: g.status }));
  if (code !== 0) throw new Error('Live local bridge verification failed; see recorded gate results');
  const applied = applyHunks(source, candidate.hunks);
  if (applied === source || /CREPAIR_PRELUDE/.test(applied)) throw new Error('Applied output invariant failed');
  console.log('Shared applyHunks: changed output, no prelude marker');
  measurements.status = 'pass';
} finally {
  clearInterval(timer);
  if (inFlight) await inFlight;
  await runtime.stop();
  measurements.afterStop = await memorySample();
  if (measurements.status === 'running') measurements.status = 'failed';
  if (process.env.CREPAIR_SMOKE_METRICS) writeFileSync(process.env.CREPAIR_SMOKE_METRICS, JSON.stringify(measurements, null, 2) + '\n');
  rmSync(temp, { recursive: true, force: true });
  console.log('Managed runtime stopped');
}
