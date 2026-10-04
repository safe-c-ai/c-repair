import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { openUserGuide } from './localSettingsGuide';
import { logWarn } from '../log';

/** Open a fresh, writable practice file without changing a previous copy or starting inference. */
export async function openPracticeSample(context: vscode.ExtensionContext): Promise<vscode.Uri> {
  const template = vscode.Uri.joinPath(context.extensionUri, 'resources', 'quick-start.c');
  const content = await vscode.workspace.fs.readFile(template);
  const directory = vscode.Uri.joinPath(context.globalStorageUri, 'practice', randomUUID());
  const storedUri = vscode.Uri.joinPath(directory, 'quick-start.c');
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(storedUri, content);
  // Native VS Code can expose its storage through the vscode-userdata provider.
  // Open the backing file as a normal C document, including file-directory
  // discovery used by Scan and compile validation. Keep remote URIs intact.
  const uri = storedUri.scheme === 'vscode-userdata' ? vscode.Uri.file(storedUri.fsPath) : storedUri;
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  try {
    await openUserGuide(context, true);
  } catch {
    // A disabled Markdown preview should not prevent using the practice file.
    logWarn('Practice file opened; the Markdown preview is unavailable.');
  }
  // Markdown preview commands do not accept a preserveFocus option. Restore the
  // C editor explicitly so the next right-click or Scan acts on the practice file.
  await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preview: false });
  return uri;
}
