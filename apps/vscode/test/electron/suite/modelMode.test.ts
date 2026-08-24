// Model-mode selection integration (D-031, trial-free guarantee), driven against
// the offline fixture bridge. Verifies the first-run QuickPick gate wired into the
// scan flow, now that `crepair.modelMode` is the single source of truth:
//   - the `crepair.chooseModelMode` command is registered;
//   - with the model-mode test hook = 'free', a scan writes `crepair.modelMode` =
//     'free' (and leaves `crepair.model` / `crepair.providerOrder` untouched) and
//     records the chosen flag;
//   - with the hook = 'default', a scan resets `crepair.modelMode` to its default
//     (no model/provider writes) but still records the flag (picker skipped after);
//   - with the hook = 'esc', a scan records NOTHING and is ABORTED (fail-closed
//     billing gate) — the gate re-prompts at the next scan, and a later choice
//     lets the scan through;
//   - a recorded choice passes the gate without consulting the picker;
//   - Reset Extension State clears the choice, so the gate blocks again.
//
// The picker is bypassed via process.env.CREPAIR_TEST_MODEL_MODE, mutated per-test
// (runTest.ts defaults it to 'default'). Reset Extension State clears the flag +
// config between cases so each case starts from a clean, unchosen state. Uses a
// DISTINCT temp file so the confirmed-context cache never collides with other
// suites. No python, no LLM: BridgeManager attaches via CREPAIR_TEST_BRIDGE_URL.

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';

// A minimal self-contained .c with one CERT C violation (strcpy) the fixtures scan
// into a finding, so the scan installs a non-empty session and reaches the gate.
const SRC = [
  '#include <string.h>',
  '',
  'void mm_copy_label(char *dst, const char *src) {',
  '    strcpy(dst, src);',
  '}',
  '',
].join('\n');

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';
const HOOK = 'CREPAIR_TEST_MODEL_MODE';

interface ModelModeTestApi {
  seedApiKey(key: string): Thenable<void>;
  getSession(): unknown;
  getModelModeChosen(): boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  assert.ok(predicate(), 'condition not met within timeout');
}

async function getTestApi(): Promise<ModelModeTestApi> {
  const ext =
    vscode.extensions.getExtension('undefined_publisher.c-repair') ??
    vscode.extensions.all.find((e) => e.packageJSON?.name === 'c-repair');
  assert.ok(ext, 'C Repair extension not found');
  const api = (await ext!.activate()) as ModelModeTestApi | undefined;
  assert.ok(api, 'test API not exposed — is CREPAIR_TEST_BRIDGE_URL set?');
  return api!;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('crepair');
}

export function modelMode(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair model-mode selection (D-031, fixture bridge)');

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let api: ModelModeTestApi;

  suite.beforeAll(async () => {
    // Silence the external-route confirm + cost display so the scan runs straight
    // through offline (never contacts openrouter.ai).
    await cfg().update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);
    await cfg().update('showCosts', false, vscode.ConfigurationTarget.Global);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-mm-'));
    filePath = path.join(tmpDir, 'model_mode_sample.c');
    fs.writeFileSync(filePath, SRC, 'utf8');

    api = await getTestApi();
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
  });

  suite.afterAll(async () => {
    // Restore the default model-mode hook so later suites keep the non-blocking
    // 'default' behaviour, and reset the modelMode / model / provider config the
    // cases may have written.
    process.env[HOOK] = 'default';
    await cfg().update('modelMode', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('model', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('providerOrder', undefined, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** Reset to an unchosen state: clear flag + key + session + modelMode / model config. */
  async function resetToUnchosen(): Promise<void> {
    await vscode.commands.executeCommand('crepair.resetExtensionState');
    await cfg().update('modelMode', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('model', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('providerOrder', undefined, vscode.ConfigurationTarget.Global);
    await delay(50);
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');
  }

  /** Trigger the scan flow (which runs the model-mode gate) and await a session. */
  async function scanOnce(): Promise<void> {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('crepair.scanCurrentFile');
    await waitFor(() => api.getSession() !== undefined);
  }

  /**
   * Trigger the scan flow WITHOUT awaiting a session — for fail-closed gate cases
   * where the scan must abort. A short settle delay guards against a late async
   * session install (which would mean the gate leaked the scan through).
   */
  async function attemptScan(): Promise<void> {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('crepair.scanCurrentFile');
    await delay(600);
  }

  suite.addTest(
    new Mocha.Test('the Choose Model Mode command is registered', async () => {
      const all = await vscode.commands.getCommands(true);
      assert.ok(
        all.includes('crepair.chooseModelMode'),
        'crepair.chooseModelMode not registered',
      );
    }),
  );

  suite.addTest(
    new Mocha.Test('free choice sets modelMode=free (model/provider untouched) and records the flag', async () => {
      await resetToUnchosen();
      process.env[HOOK] = 'free';
      await scanOnce();

      assert.equal(cfg().get<string>('modelMode'), 'free', 'modelMode should be free');
      // The picker no longer touches model / providerOrder — they stay at defaults.
      assert.equal(cfg().get<string>('model'), DEFAULT_MODEL, 'model must stay at the default');
      assert.deepEqual(
        cfg().get<string[]>('providerOrder'),
        ['DeepInfra'],
        'providerOrder must stay at the default pin',
      );
      assert.equal(api.getModelModeChosen(), true, 'the model-mode flag should be recorded');
    }),
  );

  suite.addTest(
    new Mocha.Test('first-run default choice records the flag and writes no model config', async () => {
      // From a clean (default) state, the scan gate shows the picker; the 'default'
      // choice resets modelMode to its default (a no-op here) and records the flag.
      await resetToUnchosen();
      process.env[HOOK] = 'default';
      await scanOnce();

      assert.equal(cfg().get<string>('modelMode'), 'default', 'modelMode should stay at the default');
      assert.equal(cfg().get<string>('model'), DEFAULT_MODEL, 'model should stay at the default');
      assert.equal(api.getModelModeChosen(), true, 'the model-mode flag should be recorded');
    }),
  );

  suite.addTest(
    new Mocha.Test('Choose Model Mode command resets a free mode back to default', async () => {
      // The reselect command (a shortcut for the settings dropdown) always shows the
      // picker; picking 'default' from a free mode resets modelMode to its default.
      await resetToUnchosen();
      await cfg().update('modelMode', 'free', vscode.ConfigurationTarget.Global);
      process.env[HOOK] = 'default';

      await vscode.commands.executeCommand('crepair.chooseModelMode');
      await waitFor(() => cfg().get<string>('modelMode') === 'default');

      assert.equal(cfg().get<string>('modelMode'), 'default', 'modelMode should be reset to default');
      assert.equal(api.getModelModeChosen(), true, 'the model-mode flag should be recorded');
    }),
  );

  suite.addTest(
    new Mocha.Test('dismissed (esc) ABORTS the scan and records NOTHING (fail-closed gate)', async () => {
      await resetToUnchosen();
      process.env[HOOK] = 'esc';
      await attemptScan();

      // Billing safety: no mode chosen => the scan must NOT run (no session — the
      // bridge was never asked to scan on the billable preset model).
      assert.equal(
        api.getSession(),
        undefined,
        'a dismissed picker must ABORT the scan (fail-closed billing gate)',
      );
      assert.equal(
        api.getModelModeChosen(),
        false,
        'a dismissed picker must NOT record the flag',
      );
      // Config untouched by a dismissal.
      assert.equal(cfg().get<string>('modelMode'), 'default');
      assert.equal(cfg().get<string>('model'), DEFAULT_MODEL);

      // The gate re-prompts at the next scan; choosing then lets the scan through.
      process.env[HOOK] = 'free';
      await scanOnce();
      assert.equal(cfg().get<string>('modelMode'), 'free', 'the re-prompted choice applies');
      assert.equal(api.getModelModeChosen(), true, 'the re-prompted choice records the flag');

      process.env[HOOK] = 'default';
    }),
  );

  suite.addTest(
    new Mocha.Test('a recorded choice passes the gate without consulting the picker', async () => {
      await resetToUnchosen();
      // Record the choice via the command (no scan involved) …
      process.env[HOOK] = 'default';
      await vscode.commands.executeCommand('crepair.chooseModelMode');
      await waitFor(() => api.getModelModeChosen());

      // … then scan with the hook forced to 'esc': if the gate consulted the picker
      // it would abort, so a completed session proves the recorded flag short-circuits.
      process.env[HOOK] = 'esc';
      await scanOnce();
      assert.notEqual(api.getSession(), undefined, 'a chosen mode must let the scan through');

      process.env[HOOK] = 'default';
    }),
  );

  suite.addTest(
    new Mocha.Test('Reset Extension State clears the choice — the scan gate blocks again', async () => {
      // From the previous test the flag is recorded; the reset (inside
      // resetToUnchosen) must clear it so the gate fails closed once more.
      await resetToUnchosen();
      process.env[HOOK] = 'esc';
      await attemptScan();

      assert.equal(
        api.getSession(),
        undefined,
        'after Reset Extension State the gate must block an unchosen scan again',
      );
      assert.equal(api.getModelModeChosen(), false, 'the reset must clear the chosen flag');

      // Restore the non-blocking default for any following suite.
      process.env[HOOK] = 'default';
    }),
  );
}
