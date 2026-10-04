import * as vscode from 'vscode';

export const LOCAL_LEADERBOARD_URL = 'https://safe-c-ai.github.io/c-repair-leaderboard/cert-c/';
export const LOCAL_LEADERBOARD_ITEM = {
  label: 'C Repair Leaderboard',
  action: 'leaderboard',
  description: 'Compare CERT C model evaluation results in your browser',
};

/** Navigation only: the settings editor keeps its unsaved draft. */
export async function openLocalLeaderboard(): Promise<void> {
  try {
    if (await vscode.env.openExternal(vscode.Uri.parse(LOCAL_LEADERBOARD_URL))) return;
  } catch { /* Keep the editor open when no browser can be launched. */ }
  await vscode.window.showErrorMessage(`Could not open the leaderboard. Open this address in your browser: ${LOCAL_LEADERBOARD_URL}`);
}
