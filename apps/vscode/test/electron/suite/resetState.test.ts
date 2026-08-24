// Reset Extension State integration (fixture bridge). Verifies the
// `crepair.resetExtensionState` command: it is registered, and after a scan has
// installed a session + a seeded API key, running it clears the SecretStorage key
// and empties the live session. The destructive confirm QuickPick is bypassed via
// the CREPAIR_TEST_RESET_CONFIRM='reset' hook set in runTest.ts, so no picker
// blocks the headless run.
//
// Runs in the default 'ready' repair / 'empty' infer mode, so it must precede any
// mode-flipping suite. BridgeManager attaches to the fixture bridge via
// CREPAIR_TEST_BRIDGE_URL; the fixture bridge is a standalone HTTP server, so the
// extension's bridge.kill() (part of reset) does not disturb it.

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';

// A minimal self-contained .c with one CERT C violation the fixtures scan into a
// finding, so the scan installs a non-empty session.
const RESET_SRC = [
  '#include <string.h>',
  '',
  'void copy_label(char *dst, const char *src) {',
  '    strcpy(dst, src);',
  '}',
  '',
].join('\n');

interface ResetTestApi {
  seedApiKey(key: string): Thenable<void>;
  getSession(): unknown;
  getApiKey(): Thenable<string | undefined>;
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

async function getTestApi(): Promise<ResetTestApi> {
  const ext =
    vscode.extensions.getExtension('undefined_publisher.c-repair') ??
    vscode.extensions.all.find((e) => e.packageJSON?.name === 'c-repair');
  assert.ok(ext, 'C Repair extension not found');
  const api = (await ext!.activate()) as ResetTestApi | undefined;
  assert.ok(api, 'test API not exposed — is CREPAIR_TEST_BRIDGE_URL set?');
  return api!;
}

export function resetState(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair Reset Extension State (fixture bridge)');

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let api: ResetTestApi;

  suite.beforeAll(async () => {
    // Silence the external-route confirm so the scan runs straight through.
    await vscode.workspace
      .getConfiguration('crepair')
      .update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);
    // Cost display OFF so the offline suite never contacts openrouter.ai.
    await vscode.workspace
      .getConfiguration('crepair')
      .update('showCosts', false, vscode.ConfigurationTarget.Global);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-reset-'));
    filePath = path.join(tmpDir, 'reset_sample.c');
    fs.writeFileSync(filePath, RESET_SRC, 'utf8');

    api = await getTestApi();
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');

    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
  });

  suite.afterAll(async () => {
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

  suite.addTest(
    new Mocha.Test('the command is registered', async () => {
      const all = await vscode.commands.getCommands(true);
      assert.ok(
        all.includes('crepair.resetExtensionState'),
        'crepair.resetExtensionState not registered',
      );
    }),
  );

  suite.addTest(
    new Mocha.Test('reset clears the API key and empties the session', async () => {
      // Precondition: seed + scan gives us a stored key and a live session.
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      await waitFor(() => api.getSession() !== undefined);
      assert.ok(api.getSession(), 'a session should exist after the scan');
      assert.equal(
        await api.getApiKey(),
        'test-key-not-used-by-fixture-bridge',
        'the seeded key should be in SecretStorage before reset',
      );

      // Run the reset (confirm QuickPick bypassed via CREPAIR_TEST_RESET_CONFIRM).
      await vscode.commands.executeCommand('crepair.resetExtensionState');

      // The BYOK key is deleted and the live session is cleared.
      await waitFor(() => api.getSession() === undefined);
      assert.equal(api.getSession(), undefined, 'the session should be cleared after reset');
      assert.equal(
        await api.getApiKey(),
        undefined,
        'the API key should be deleted from SecretStorage after reset',
      );
      // Diagnostics for the scanned file are cleared too.
      assert.equal(
        vscode.languages.getDiagnostics(doc.uri).length,
        0,
        'diagnostics should be cleared after reset',
      );
    }),
  );
}
