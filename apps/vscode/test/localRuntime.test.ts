import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalRuntime } from '../src/bridge/LocalRuntime';
import { LOCAL_PRESET, type LocalSettings } from '../src/bridge/localSettings';

test('managed runtime lifecycle: exclusive ownership, stop, cancellation and restart', { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-runtime-test-'));
  const executable = path.join(dir, 'llama-server');
  fs.writeFileSync(executable, `#!/usr/bin/env python3
import os, sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer
open(__file__+'.pid','w').write(str(os.getpid()))
port=int(sys.argv[sys.argv.index('--port')+1])
ctx=int(sys.argv[sys.argv.index('-c')+1])
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  time.sleep(0.1)
  self.send_response(200); self.end_headers()
  self.wfile.write(json.dumps({'status':'ok','default_generation_settings':{'n_ctx':ctx}}).encode())
 def log_message(self,*a): pass
HTTPServer(('127.0.0.1',port),Handler).serve_forever()
`, { mode: 0o700 });
  const model = path.join(dir, 'model.gguf'); fs.writeFileSync(model, 'fixture');
  const settings: LocalSettings = { ...LOCAL_PRESET, effort: 'xhigh', serverPath: executable, modelPath: model };
  const runtime = new LocalRuntime();
  const other = new LocalRuntime();
  try {
    await runtime.start(settings);
    assert.equal(runtime.running, true);
    const pid = Number(fs.readFileSync(executable + '.pid', 'utf8'));
    await assert.rejects(other.start(settings), /Another C Repair/);
    await runtime.stop();
    assert.throws(() => process.kill(pid, 0));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(runtime.start(settings, abort.signal), { name: 'AbortError' });
    assert.equal(runtime.running, false);
    const duringLoad = new AbortController();
    const timer = setTimeout(() => duringLoad.abort(), 50);
    await assert.rejects(runtime.start(settings, duringLoad.signal), { name: 'AbortError' });
    clearTimeout(timer);
    assert.equal(runtime.running, false);
    await runtime.start(settings);
    assert.equal(runtime.running, true);
    await runtime.stop();
    assert.equal(runtime.running, false);
  } finally { await runtime.stop(); await other.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
