// Own one runtime on the extension host. A guardian terminates it on stdin EOF
// (also when the extension host crashes). Runtime output can contain prompts:
// discard it. Only the guardian's lifecycle status is observed.
import { engineEnv } from './localEngine';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { localServerArgs, type LocalSettings } from './localSettings';

const GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
let child, stopping = false, timer;
function stop() {
  if(stopping) return; stopping = true;
  if(!child) return process.exit(0);
  child.kill('SIGTERM');
  timer = setTimeout(() => child.kill('SIGKILL'), 3000);
}
process.stdin.resume();
process.stdin.on('end', stop); process.stdin.on('error', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child = spawn(process.env.CREPAIR_RUNTIME_BIN, JSON.parse(process.env.CREPAIR_RUNTIME_ARGS),
  {stdio:'ignore', windowsHide:true});
child.on('error', () => process.exit(1));
child.on('exit', code => {clearTimeout(timer); process.exit(stopping ? 0 : (code || 1));});
`;

export class LocalRuntime {
  private child?: ChildProcess;
  private stopped?: Promise<void>;
  private release?: () => void;
  get running(): boolean { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }

  async start(settings: LocalSettings, signal?: AbortSignal, mlxScript?: string): Promise<number> {
    await this.stop();
    if (settings.runtime === 'mlx') {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MLX requires native Apple Silicon macOS.');
      if (!mlxScript || !fs.statSync(mlxScript).isFile() || !path.isAbsolute(settings.modelPath) || !fs.statSync(settings.modelPath).isDirectory()) throw new Error('MLX requires an existing model directory and runtime.');
    }
    for (const p of [settings.serverPath, ...(settings.runtime === 'mlx' ? [] : [settings.modelPath]), ...(settings.templatePath ? [settings.templatePath] : [])]) {
      if (!path.isAbsolute(p) || !fs.statSync(p).isFile()) throw new Error('Local runtime, model and template paths must be existing absolute file paths.');
    }
    // One model per OS user on this host, across VS Code windows/workspaces.
    const lock = path.join(os.tmpdir(), `c-repair-local-${process.getuid?.() ?? os.userInfo().username}.lock`);
    try {
      const old = Number(fs.readFileSync(lock, 'utf8'));
      if (old > 0) {
        let alive = true;
        try { process.kill(old, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another C Repair window owns the local model. Stop its bridge before starting here.');
        fs.unlinkSync(lock);
      } else throw new Error('Local runtime lock is invalid. Check for another C Repair window before removing the lock.');
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
    this.release = () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } };
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer(); server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No local port available.')));
        });
      });
      signal?.throwIfAborted();
      const child = spawn(process.execPath, ['-e', GUARDIAN], {
        env: { ...engineEnv(settings.serverPath), ...(settings.runtime === 'mlx' ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' } : {}), ELECTRON_RUN_AS_NODE: '1', CREPAIR_RUNTIME_BIN: settings.serverPath,
          CREPAIR_RUNTIME_ARGS: JSON.stringify(settings.runtime === 'mlx' ? [mlxScript!, '--model', settings.modelPath, '--context', String(settings.contextTokens), '--port', String(port), ...(settings.templatePath ? ['--template', settings.templatePath] : [])] : localServerArgs(settings, port)) },
        stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
      });
      this.child = child;
      this.stopped = new Promise<void>(resolve => {
        const done = () => { this.release?.(); this.release = undefined; resolve(); };
        child.once('close', done);
      });
      let spawnError = false;
      child.once('error', () => { spawnError = true; });
      const stop = () => { void this.stop(); };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          if (spawnError || !this.running) throw new Error('Local model could not load. Check runtime compatibility, model path and VRAM/RAM.');
          try {
            const r = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
            if (r.ok) {
              const props = await fetch(`http://127.0.0.1:${port}/props`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
              const data = await props.json() as { default_generation_settings?: { n_ctx?: number } };
              if (data.default_generation_settings?.n_ctx !== settings.contextTokens) throw new Error('Runtime context does not match configuration.');
              signal?.throwIfAborted();
              return port;
            }
          } catch (err) {
            if (err instanceof Error && err.message === 'Runtime context does not match configuration.') throw err;
          }
          await new Promise(r => setTimeout(r, 300));
        }
        throw new Error('Local model did not become ready within 5 minutes. Check runtime and memory settings.');
      } finally { signal?.removeEventListener('abort', stop); }
    } catch (err) { await this.stop(); throw err; }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child) {
      child.stdin?.end(); // guardian terminates the model, then exits
      await this.stopped;
      if (this.child === child) this.child = undefined;
    } else { this.release?.(); this.release = undefined; }
  }
}
