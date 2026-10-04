import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import { CRepairTreeProvider } from '../../../src/ui/tree';
import type { CRepairNode } from '../../../src/ui/tree';
import type { ScanSession } from '../../../src/session/ScanSession';
import { guideFilename } from '../../../src/ui/guideFilename';

export function guides(root: Mocha.Suite): void {
  const suite = Mocha.Suite.create(root, 'Bundled user guide');
  suite.addTest(new Mocha.Test('empty results leave welcome actions visible and scans restore the retained header', () => {
    const tree = new CRepairTreeProvider();
    const view = { message: 'old header' } as vscode.TreeView<CRepairNode>;
    tree.setModelLine('Model: fixture');
    tree.setMessage('Session: 12 in / 3 out');
    tree.attachView(view);
    assert.equal(view.message, undefined, 'a message hides VS Code viewsWelcome');
    tree.setModelLine('Model: fixture');
    tree.setMessage('Session: 12 in / 3 out');
    assert.equal(view.message, undefined);
    tree.setSession({ scanResult: { functions: [] } } as unknown as ScanSession);
    const roots = tree.getChildren();
    assert.equal(roots.length, 1);
    assert.deepEqual(tree.getChildren(roots[0]), []);
    assert.match(view.message ?? '', /Model: fixture/);
    assert.match(view.message ?? '', /Session: 12 in \/ 3 out/);
    tree.setSession(undefined);
    assert.equal(view.message, undefined);
    assert.equal(tree.modelLine, 'Model: fixture');
  }));
  suite.addTest(new Mocha.Test('the user-guide command opens the bundled preview', async () => {
    const extension = vscode.extensions.all.find(e => e.packageJSON?.name === 'c-repair');
    assert.ok(extension);
    await extension.activate();
    await vscode.commands.executeCommand('crepair.openUserGuide');
    const filename = guideFilename('user', vscode.env.language);
    const deadline = Date.now() + 5000;
    while (!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label.includes(filename))) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label.includes(filename))));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }));
}
