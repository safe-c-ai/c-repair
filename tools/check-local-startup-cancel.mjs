// Verify the actual packaged BridgeManager class with a delayed runtime load.
// Run with native Node (or VS Code's ELECTRON_RUN_AS_NODE=1) and a VSIX path.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const vsix = process.argv[2];
if (!vsix) throw new Error('Usage: check-local-startup-cancel.mjs FILE.vsix');
const bundle = execFileSync('/usr/bin/unzip', ['-p', vsix, 'extension/dist/extension.js'], { encoding: 'utf8', maxBuffer: 4e6 });
const start = bundle.indexOf('var BridgeManager = class {');
assert.ok(start >= 0);
const end = bundle.indexOf('\n};', start) + 3;
class Runtime {
  stops = 0;
  stop() { this.stops++; return Promise.resolve(); }
}
class BridgeError extends Error {
  constructor(message, kind) { super(message); this.name = 'BridgeError'; this.kind = kind; }
}
const context = {
  LocalRuntime: Runtime, BridgeError, DOMException, process: { env: {} },
  validateLocalSettings() {},
};
vm.createContext(context);
vm.runInContext(bundle.slice(start, end), context);

async function check(retire) {
  const manager = new context.BridgeManager({ get: async () => undefined });
  manager.resolvePython = () => '/fake/python';
  manager.configuredPort = () => 12345;
  manager.modelMode = () => 'local';
  manager.localSettings = () => ({ serverPath: '/fake/runtime', runtime: 'mlx' });
  let entered, fail;
  const loading = new Promise(resolve => { entered = resolve; });
  const pending = new Promise((_resolve, reject) => { fail = reject; });
  manager.localRuntime.start = () => { entered(); return pending; };
  const result = manager.start().catch(error => error);
  await loading;
  if (retire) manager.kill();
  fail(new Error('Local model could not load.'));
  const error = await result;
  if (retire) {
    assert.equal(error.name, 'AbortError', 'retired start must be cancellation, not a model error');
    assert.equal(manager.state, 'stopped');
    assert.equal(manager.localRuntime.stops, 1, 'stale catch must not stop a newer runtime');
  } else {
    assert.equal(error.name, 'BridgeError');
    assert.equal(error.kind, 'spawn');
    assert.equal(manager.state, 'error', 'real load failures must remain visible');
  }
  return { retired: retire, error: error.name, state: manager.state, stops: manager.localRuntime.stops };
}
console.log(JSON.stringify({ vsix, checks: [await check(true), await check(false)] }, null, 2));
