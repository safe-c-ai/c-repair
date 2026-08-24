// Unit tests for the V3a bridge bootstrap (D-036 / V3_PACKAGING_DESIGN §1-2):
// the 4-step python resolution order, the consent-gated uv install, the
// stage-classified failures (wheels missing / network / disk), and the
// bootstrap-success -> resolution-③ handoff. Pure Node; spawn/fs are fakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  resolveBridgePython,
  provisionedPythonPath,
  provisionedVenvDir,
  bridgeDistDir,
  runBootstrap,
  findUv,
  failureDetail,
  BootstrapError,
  UV_MANUAL_INSTALL_URL,
  type BootstrapDeps,
  type ExecResult,
} from '../src/bridge/bootstrap';

const STORAGE = '/gs';
const EXT = '/ext';

function res(code: number, stderr = ''): ExecResult {
  return { code, stdout: '', stderr };
}

// The default bundled wheel + its manifest (the exact shape
// tools/build-bridge-dist.sh writes — format pinned by these tests).
const WHEEL_NAME = 'repair_api-1.0-py3-none-any.whl';
const WHEEL_PATH = path.join(bridgeDistDir(EXT), WHEEL_NAME);
const WHEEL_SHA = 'a'.repeat(64);
const MANIFEST_PATH = path.join(bridgeDistDir(EXT), 'MANIFEST.json');
const MANIFEST_JSON = JSON.stringify({
  format: 1,
  files: [{ file: WHEEL_NAME, sha256: WHEEL_SHA, size: 12345 }],
});

/** A scripted BootstrapDeps: `execs` records calls; behaviour via overrides. */
function makeDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps & {
  execs: { cmd: string; args: string[] }[];
  reports: string[];
  mkdirs: string[];
} {
  const execs: { cmd: string; args: string[] }[] = [];
  const reports: string[] = [];
  const mkdirs: string[] = [];
  const deps: BootstrapDeps & {
    execs: typeof execs;
    reports: typeof reports;
    mkdirs: typeof mkdirs;
  } = {
    execs,
    reports,
    mkdirs,
    exec: async (cmd, args) => {
      execs.push({ cmd, args });
      return res(0);
    },
    exists: (p) => p === WHEEL_PATH,
    listWheels: () => [WHEEL_PATH],
    readFile: (p) => (p === MANIFEST_PATH ? MANIFEST_JSON : undefined),
    fileSha256: (p) => (p === WHEEL_PATH ? WHEEL_SHA : undefined),
    mkdirp: (dir) => {
      mkdirs.push(dir);
    },
    platform: 'linux',
    homeDir: '/home/u',
    confirmInstallUv: async () => true,
    report: (m) => {
      reports.push(m);
    },
    ...overrides,
  };
  return deps;
}

// --- resolution order (D-036 ①→②→③→④) ----------------------------------------

const REPO_PY = path.join('/ws', 'services', 'repair-api', '.venv', 'bin', 'python');

function resolve(exists: (p: string) => boolean, configured = '', storage: string | undefined = STORAGE) {
  return resolveBridgePython({
    configuredPath: configured,
    workspaceFolders: ['/ws'],
    globalStorageDir: storage,
    platform: 'linux',
    exists,
  });
}

test('① an existing configured pythonPath wins over everything', () => {
  const r = resolve(() => true, '/custom/python');
  assert.deepEqual(r, { kind: 'configured', python: '/custom/python' });
});

test('① a MISSING configured pythonPath is an error, never a silent fallthrough', () => {
  const r = resolve((p) => p !== '/custom/python', '/custom/python');
  assert.equal(r.kind, 'configured_missing');
  if (r.kind === 'configured_missing') assert.match(r.message, /crepair\.bridge\.pythonPath/);
});

test('② the repo .venv outranks the provisioned venv (dev route unaffected)', () => {
  const provisioned = provisionedPythonPath(STORAGE, 'linux');
  const r = resolve((p) => p === REPO_PY || p === provisioned);
  assert.deepEqual(r, { kind: 'repo', python: REPO_PY });
});

test('③ the provisioned globalStorage venv serves end users', () => {
  const provisioned = provisionedPythonPath(STORAGE, 'linux');
  const r = resolve((p) => p === provisioned);
  assert.deepEqual(r, { kind: 'provisioned', python: provisioned });
});

test('④ nothing available -> bootstrap guidance naming Set Up Bridge', () => {
  const r = resolve(() => false);
  assert.equal(r.kind, 'bootstrap_needed');
  if (r.kind === 'bootstrap_needed') assert.match(r.message, /Set Up Bridge/);
  // No globalStorage dir (unit constructions): step ③ is skipped, same outcome.
  assert.equal(resolve(() => false, '', undefined).kind, 'bootstrap_needed');
});

test('provisioned python path follows the platform venv layout', () => {
  assert.equal(
    provisionedPythonPath(STORAGE, 'linux'),
    path.join(STORAGE, 'bridge-venv', 'bin', 'python'),
  );
  assert.equal(
    provisionedPythonPath(STORAGE, 'win32'),
    path.join(STORAGE, 'bridge-venv', 'Scripts', 'python.exe'),
  );
});

// --- bootstrap stages ---------------------------------------------------------

test('missing bridge-dist wheels fail fast with a human-readable stage error', async () => {
  const deps = makeDeps({ listWheels: () => [] });
  await assert.rejects(
    runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT }),
    (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.stage, 'wheels_missing');
      assert.match(err.message, /bridge-dist/);
      assert.match(err.message, /services\/repair-api\/\.venv/); // dev hint
      return true;
    },
  );
  // Fails BEFORE any command runs (nothing to install anyway).
  assert.equal(deps.execs.length, 0);
});

test('uv absent + consent declined -> uv_missing error with the manual guide', async () => {
  const deps = makeDeps({
    exec: async (cmd, args) => {
      deps.execs.push({ cmd, args });
      return res(cmd === 'uv' ? 127 : 0); // uv --version fails; nothing else runs
    },
    confirmInstallUv: async () => false,
  });
  await assert.rejects(
    runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT }),
    (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.stage, 'uv_missing');
      assert.ok(err.message.includes(UV_MANUAL_INSTALL_URL));
      return true;
    },
  );
});

test('happy path: uv present -> venv + wheel install into globalStorage', async () => {
  const deps = makeDeps();
  const out = await runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT });
  assert.equal(out.venvPython, provisionedPythonPath(STORAGE, 'linux'));
  assert.deepEqual(deps.mkdirs, [STORAGE]);
  const cmds = deps.execs.map((e) => [e.cmd, ...e.args].join(' '));
  assert.equal(cmds[0], 'uv --version');
  assert.equal(cmds[1], `uv venv --python 3.10 ${provisionedVenvDir(STORAGE)}`);
  // --reinstall pins the same-version-wheel refresh behaviour (a repaired
  // bundled wheel must actually replace the installed copy).
  assert.equal(cmds[2], `uv pip install --reinstall --python ${out.venvPython} ${WHEEL_PATH}`);
});

test('uv absent + consent -> official installer runs, then local-bin uv is used', async () => {
  const localUv = path.join('/home/u', '.local', 'bin', 'uv');
  let installed = false;
  const deps = makeDeps({
    exec: async (cmd, args, opts) => {
      deps.execs.push({ cmd, args });
      if (cmd === 'uv') return res(127); // never lands on PATH in this process
      if (opts?.shell) {
        installed = true;
        return res(0); // the installer succeeded
      }
      if (cmd === localUv) return res(0); // --version / venv / pip via local bin
      return res(0);
    },
    exists: (p) => p === WHEEL_PATH || (installed && p === localUv),
  });
  const out = await runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT });
  assert.equal(out.venvPython, provisionedPythonPath(STORAGE, 'linux'));
  // The install + all uv work went through the local-bin binary.
  const localCalls = deps.execs.filter((e) => e.cmd === localUv);
  assert.ok(localCalls.some((e) => e.args[0] === 'venv'));
  assert.ok(localCalls.some((e) => e.args[0] === 'pip'));
});

test('network-looking failures are classified as network in the stage error', async () => {
  const deps = makeDeps({
    exec: async (cmd, args) => {
      deps.execs.push({ cmd, args });
      if (args[0] === 'venv') return res(1, 'error: could not resolve host astral.sh');
      return res(0);
    },
  });
  await assert.rejects(
    runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT }),
    (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.stage, 'venv');
      assert.match(err.message, /network problem/);
      return true;
    },
  );
});

test('disk-full failures are classified as disk in the stage error', async () => {
  const deps = makeDeps({
    exec: async (cmd, args) => {
      deps.execs.push({ cmd, args });
      if (args[0] === 'pip') return res(1, 'OSError: [Errno 28] ENOSPC: no space left on device');
      return res(0);
    },
  });
  await assert.rejects(
    runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT }),
    (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.stage, 'install');
      assert.match(err.message, /disk appears to be full/);
      return true;
    },
  );
});

test('failureDetail falls back to a bounded stderr tail', () => {
  assert.match(failureDetail('some\nweird\nfailure text'), /details: /);
  assert.equal(failureDetail(''), 'no further details were reported');
});

test('findUv prefers PATH, probes the local-bin fallback, else undefined', async () => {
  // On PATH.
  assert.equal(
    await findUv({ exec: async () => res(0), exists: () => false, platform: 'linux', homeDir: '/h' }),
    'uv',
  );
  // Not on PATH, present in ~/.local/bin.
  const local = path.join('/h', '.local', 'bin', 'uv');
  assert.equal(
    await findUv({
      exec: async (cmd) => res(cmd === 'uv' ? 127 : 0),
      exists: (p) => p === local,
      platform: 'linux',
      homeDir: '/h',
    }),
    local,
  );
  // Nowhere.
  assert.equal(
    await findUv({ exec: async () => res(127), exists: () => false, platform: 'linux', homeDir: '/h' }),
    undefined,
  );
});

test('bootstrap success enables resolution step ③ (end-to-end handoff)', async () => {
  // Fake fs: the provisioned python "exists" only after the venv command ran.
  const provisioned = provisionedPythonPath(STORAGE, 'linux');
  let venvCreated = false;
  const deps = makeDeps({
    exec: async (cmd, args) => {
      deps.execs.push({ cmd, args });
      if (args[0] === 'venv') venvCreated = true;
      return res(0);
    },
    exists: (p) => p === WHEEL_PATH || (venvCreated && p === provisioned),
  });

  // Before: nothing available -> bootstrap guidance (④).
  assert.equal(resolve((p) => deps.exists(p)).kind, 'bootstrap_needed');

  const out = await runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT });
  assert.equal(out.venvPython, provisioned);

  // After: the SAME resolution now lands on the provisioned venv (③).
  const after = resolve((p) => deps.exists(p));
  assert.deepEqual(after, { kind: 'provisioned', python: provisioned });
});

// --- wheel manifest verification (V3b, D-036 pin) ------------------------------

import { parseManifest } from '../src/bridge/bootstrap';

test('parseManifest accepts the pinned format-1 shape the build script writes', () => {
  const entries = parseManifest(MANIFEST_JSON);
  assert.deepEqual(entries, [{ file: WHEEL_NAME, sha256: WHEEL_SHA }]);
});

test('parseManifest rejects malformed shapes', () => {
  assert.equal(parseManifest('not json'), undefined);
  assert.equal(parseManifest('{"format":2,"files":[]}'), undefined);
  assert.equal(parseManifest('{"files":[]}'), undefined);
  assert.equal(
    parseManifest('{"format":1,"files":[{"file":"x.txt","sha256":"' + 'a'.repeat(64) + '"}]}'),
    undefined, // not a wheel
  );
  assert.equal(
    parseManifest('{"format":1,"files":[{"file":"x.whl","sha256":"nothex"}]}'),
    undefined, // not a 64-hex digest
  );
});

test('wheels present but MANIFEST.json missing -> wheels_corrupt', async () => {
  const deps = makeDeps({ readFile: () => undefined });
  await assert.rejects(
    runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT }),
    (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.stage, 'wheels_corrupt');
      assert.match(err.message, /MANIFEST\.json is missing/);
      return true;
    },
  );
  assert.equal(deps.execs.length, 0); // fails before any command runs
});

test('a checksum mismatch -> wheels_corrupt naming the wheel', async () => {
  const deps = makeDeps({ fileSha256: () => 'b'.repeat(64) });
  await assert.rejects(
    runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT }),
    (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.stage, 'wheels_corrupt');
      assert.match(err.message, /does not match its recorded checksum/);
      assert.ok(err.message.includes(WHEEL_NAME));
      return true;
    },
  );
});

test('a manifest-listed wheel missing on disk -> wheels_corrupt', async () => {
  const deps = makeDeps({ exists: () => false }); // wheel not on disk
  await assert.rejects(
    runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT }),
    (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.stage, 'wheels_corrupt');
      assert.match(err.message, /is missing/);
      return true;
    },
  );
});

test('verified wheels (per the manifest) are what gets installed', async () => {
  // A second manifest-listed wheel: install must carry BOTH manifest paths.
  const other = path.join(bridgeDistDir(EXT), 'certfix-0.4.1-py3-none-any.whl');
  const manifest = JSON.stringify({
    format: 1,
    files: [
      { file: 'certfix-0.4.1-py3-none-any.whl', sha256: 'c'.repeat(64), size: 1 },
      { file: WHEEL_NAME, sha256: WHEEL_SHA, size: 1 },
    ],
  });
  const deps = makeDeps({
    readFile: (p) => (p === MANIFEST_PATH ? manifest : undefined),
    exists: (p) => p === WHEEL_PATH || p === other,
    fileSha256: (p) => (p === WHEEL_PATH ? WHEEL_SHA : p === other ? 'c'.repeat(64) : undefined),
  });
  await runBootstrap(deps, { globalStorageDir: STORAGE, extensionDir: EXT });
  const pip = deps.execs.find((e) => e.args[0] === 'pip');
  assert.ok(pip);
  assert.deepEqual(pip!.args.slice(-2), [other, WHEEL_PATH]); // manifest order
});

// --- vsix packaging expectations (V3b) ----------------------------------------

test('.vscodeignore ships dist + bridge-dist and excludes sources/tests', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
  const lines = ignore.split('\n').map((l) => l.trim());
  // Sources / tests / build tooling never ship.
  assert.ok(lines.includes('src/**'));
  assert.ok(lines.includes('test/**'));
  assert.ok(lines.includes('node_modules/**'));
  // The bundled runtime and the bridge wheels DO ship (no un-ignore needed:
  // anything not ignored is packaged).
  assert.ok(!lines.some((l) => l === 'dist/**' || l === 'dist'));
  assert.ok(!lines.some((l) => l === 'bridge-dist/**' || l === 'bridge-dist'));
});
