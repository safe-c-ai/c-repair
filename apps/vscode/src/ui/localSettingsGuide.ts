import * as vscode from 'vscode';
import { guideFilename, type GuideKind } from './guideFilename';

async function openGuide(context: vscode.ExtensionContext, kind: GuideKind, beside = false): Promise<void> {
  await vscode.commands.executeCommand(beside ? 'markdown.showPreviewToSide' : 'markdown.showPreview',
    vscode.Uri.joinPath(context.extensionUri, 'docs', guideFilename(kind, vscode.env.language)));
}

export function openLocalSettingsGuide(context: vscode.ExtensionContext): Promise<void> {
  return openGuide(context, 'local');
}

export function openUserGuide(context: vscode.ExtensionContext, beside = false): Promise<void> {
  return openGuide(context, 'user', beside);
}
