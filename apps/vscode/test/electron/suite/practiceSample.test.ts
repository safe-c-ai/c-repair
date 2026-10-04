import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import type { ScanSession } from '../../../src/session/ScanSession';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate(), 'the practice workflow did not reach the expected state');
}

async function inferenceCounts(): Promise<number[]> {
  const response = await fetch(`${process.env.CREPAIR_TEST_BRIDGE_URL}/__test__/request-counts`);
  assert.equal(response.status, 200);
  const counts = await response.json() as Record<string, number>;
  return ['/context/infer', '/context/check', '/context/confirm', '/scan', '/repair'].map(route => counts[route] ?? 0);
}

export function practiceSample(root: Mocha.Suite): void {
  const suite = Mocha.Suite.create(root, 'Practice sample (offline fixture bridge)');
  const created: vscode.Uri[] = [];

  async function openSample(): Promise<vscode.TextDocument> {
    const uri = await vscode.commands.executeCommand<vscode.Uri>('crepair.openPracticeSample');
    assert.ok(uri);
    created.push(uri);
    assert.ok(uri.path.includes(`/globalStorage/safe-c-ai.c-repair/practice/`));
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString());
    return vscode.window.activeTextEditor!.document;
  }

  suite.afterAll(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const uri of created) await vscode.workspace.fs.delete(vscode.Uri.joinPath(uri, '..'), { recursive: true });
  });

  suite.addTest(new Mocha.Test('opens saved C copies without inference and preserves previous edits and the template', async () => {
    const extension = vscode.extensions.all.find(e => e.packageJSON?.name === 'c-repair');
    assert.ok(extension);
    await extension.activate();
    assert.equal(vscode.workspace.workspaceFolders?.length ?? 0, 0, 'exercise an empty window');
    const template = vscode.Uri.joinPath(extension.extensionUri, 'resources', 'quick-start.c');
    const original = await vscode.workspace.fs.readFile(template);
    const originalStat = await vscode.workspace.fs.stat(template);
    const before = await inferenceCounts();
    const first = await openSample();
    assert.equal(first.languageId, 'c');
    assert.equal(first.isUntitled, false);
    assert.equal(first.isDirty, false);
    assert.equal(first.getText(), Buffer.from(original).toString());
    const edit = new vscode.WorkspaceEdit();
    edit.insert(first.uri, new vscode.Position(0, 0), '/* My practice edit. */\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await first.save(), true);
    const edited = first.getText();
    const second = await openSample();
    assert.notEqual(second.uri.toString(), first.uri.toString());
    assert.equal(second.getText(), Buffer.from(original).toString());
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(first.uri)).toString(), edited);
    assert.deepEqual(await vscode.workspace.fs.readFile(template), original);
    assert.equal((await vscode.workspace.fs.stat(template)).mtime, originalStat.mtime);
    assert.deepEqual(await inferenceCounts(), before, 'opening the sample must not invoke inference');
  }));

  suite.addTest(new Mocha.Test('Scan & Fix, diff review, Accept, save and rescan work outside a workspace', async () => {
    const extension = vscode.extensions.all.find(e => e.packageJSON?.name === 'c-repair');
    assert.ok(extension);
    const api = await extension.activate() as {
      seedApiKey(key: string): Thenable<void>;
      getSession(): ScanSession | undefined;
    };
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');
    const doc = await openSample();
    const original = doc.getText();
    await vscode.commands.executeCommand('crepair.scanAndFixCurrentFile');
    await waitFor(() => api.getSession()?.snapshot.uri === doc.uri.toString()
      && api.getSession()?.candidates().length === 1);
    await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'crepair')));
    assert.equal(doc.getText(), original, 'showing a proposed diff must not apply it');
    await vscode.commands.executeCommand('crepair.acceptCurrentDiff');
    await waitFor(() => api.getSession()?.decisionFor('cand-practice') === 'accepted');
    assert.match(doc.getText(), /if \(index < 0 \|\| index >= 3\)/);
    assert.equal(doc.isDirty, true, 'Accept edits the document; the user saves it');
    assert.equal(await doc.save(), true);
    await vscode.window.showTextDocument(doc, { preview: false });
    const before = api.getSession();
    await vscode.commands.executeCommand('crepair.scanCurrentFile');
    await waitFor(() => api.getSession() !== before);
    assert.equal(api.getSession()?.scanResult.functions.flatMap(fn => fn.findings).length, 0);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString(), doc.getText());
  }));
}
