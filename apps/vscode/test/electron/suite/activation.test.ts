// Activation smoke (VSCODE_V1B_DESIGN §7, V1b-1 scope): the extension activates
// and registers its four commands. This does NOT exercise a real bridge or LLM
// (that is V1b-2's fixture-bridge integration).
//
// Tests are registered programmatically against the Mocha Suite (the file is
// bundled, so there is no glob-based file discovery / BDD globals).

import assert from 'node:assert';
import * as vscode from 'vscode';
import Mocha from 'mocha';

const EXPECTED_COMMANDS = [
  'crepair.scanCurrentFile',
  'crepair.connectOpenRouter',
  'crepair.openSettings',
  'crepair.setApiKey',
  'crepair.clearApiKey',
  'crepair.generateRepair',
];

export function activation(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair activation');

  suite.addTest(
    new Mocha.Test('activates and registers all contributed commands', async () => {
      // Commands are declared in the manifest but only *registered* once the
      // extension activates. Executing one command triggers the onCommand
      // activation event; clearApiKey is side-effect-free with no key set.
      await vscode.commands.executeCommand('crepair.clearApiKey');
      const all = await vscode.commands.getCommands(true);
      for (const cmd of EXPECTED_COMMANDS) {
        assert.ok(all.includes(cmd), `command not registered: ${cmd}`);
      }
    }),
  );
}
