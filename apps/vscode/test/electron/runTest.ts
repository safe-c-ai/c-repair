// Entry point for the @vscode/test-electron integration suite (VSCODE_V1B_DESIGN
// §7). Downloads a pinned VS Code build, starts the offline fixture bridge, and
// launches the Extension Development Host with CREPAIR_TEST_BRIDGE_URL pointing
// at it, then runs the Mocha suite in test/electron/suite.
//
// Requires a display; on headless Linux run under xvfb (see README). Also
// requires network on first run to download the VS Code build. The fixture
// bridge is fully offline (no python / no LLM).

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { startFixtureBridge } from './suite/fixtureBridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // The extension root (apps/vscode): where package.json lives.
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  // The compiled suite index (built by esbuild into dist-test).
  const extensionTestsPath = path.resolve(__dirname, '../../dist-test/suite/index.js');

  const bridge = await startFixtureBridge();
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Empty workspace; the suite creates a temp .c doc as needed.
      launchArgs: ['--disable-extensions', '--disable-gpu'],
      // The fixture-bridge hook: BridgeManager attaches here instead of spawning
      // python. Unset in real usage, so production behaviour is unchanged.
      extensionTestsEnv: {
        CREPAIR_TEST_BRIDGE_URL: bridge.url,
        // D-023 test hook: bypass the acceptWithWarning QuickPick and simulate the
        // "Apply Anyway" choice. Only affects an over-judgment-warning Accept (the
        // semantic-fail candidate); every other Accept path is unaffected. Unset
        // in real usage, so the QuickPick always shows in production.
        CREPAIR_TEST_ACCEPT_WARNING: 'apply',
        // Reset Extension State test hook: bypass the destructive-confirm QuickPick
        // and simulate the "Reset" choice so the resetState suite can drive the
        // command without a picker blocking the headless run. Unset in real usage,
        // so the confirm QuickPick always shows in production.
        CREPAIR_TEST_RESET_CONFIRM: 'reset',
        // D-031 model-mode test hook: default the first-run model-mode picker to the
        // "default" choice (which writes NO config — bit-identical to today) so every
        // existing suite's scan/setApiKey path is never blocked by the QuickPick. The
        // dedicated modelMode suite overrides process.env.CREPAIR_TEST_MODEL_MODE
        // per-test to drive 'free' / 'esc'. Unset in production (the picker shows).
        CREPAIR_TEST_MODEL_MODE: 'default',
      },
    });
  } catch (err) {
    console.error('Integration suite failed:', err);
    process.exitCode = 1;
  } finally {
    await bridge.close();
  }
}

void main();
