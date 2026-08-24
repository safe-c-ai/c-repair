// Status bar item (VSCODE_V1B_DESIGN.md §2/§4): shows the current C Repair state
// — ready / scanning / error / stale / starting. The tooltip also surfaces the
// effective model + provider once the bridge is up (D-019).

import * as vscode from 'vscode';
import {
  effectiveModelLabel,
  effectiveProviderLabel,
  effectiveReasoningLabel,
  type HealthCapabilities,
} from '../bridge/health';
import { usageTooltipLine } from '../cost/openrouterUsage';
import { STALE_RESULTS_MESSAGE } from './model';

export type StatusKind = 'idle' | 'starting' | 'ready' | 'scanning' | 'stale' | 'error';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  /** Effective LLM identity from the last /health, appended to the tooltip. */
  private caps: HealthCapabilities | undefined;
  /** Base tooltip text for the current state, before model/usage info is appended. */
  private baseTooltip = '';
  /** Cumulative OpenRouter usage (USD) for this key, appended to the tooltip (D-025). */
  private usage: number | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'crepair.scanCurrentFile';
    this.set('idle');
    this.item.show();
  }

  /**
   * Record the effective model / provider (from a /health capabilities block) so
   * subsequent tooltips show which LLM the bridge is actually using (D-019).
   * Pass undefined to clear (e.g. bridge stopped). Re-renders the current state.
   */
  setCapabilities(caps: HealthCapabilities | undefined): void {
    this.caps = caps;
    this.renderTooltip();
  }

  /**
   * Record the cumulative OpenRouter key usage in USD (D-025), appended to the
   * tooltip as an approximate-spend line. Pass null to clear (query failed /
   * disabled), which removes the line. Re-renders the tooltip in place.
   */
  setUsage(usage: number | null): void {
    this.usage = usage;
    this.renderTooltip();
  }

  /** Re-render the tooltip from the base text + model + usage, in place. */
  private renderTooltip(): void {
    this.item.tooltip = this.withExtraInfo(this.baseTooltip);
  }

  /** Append the effective model + provider + usage to a base tooltip, when known. */
  private withExtraInfo(baseText: string): string {
    let text = baseText;
    if (this.caps) {
      const model = effectiveModelLabel(this.caps);
      const provider = effectiveProviderLabel(this.caps);
      text += `\nModel: ${model}\nProvider: ${provider}`;
      const reasoning = effectiveReasoningLabel(this.caps);
      if (reasoning) text += `\nReasoning: ${reasoning}`;
    }
    const usageLine = usageTooltipLine(this.usage);
    if (usageLine) text += `\n${usageLine}`;
    return text;
  }

  set(kind: StatusKind, detail?: string): void {
    let tooltip: string;
    switch (kind) {
      case 'idle':
        this.item.text = '$(shield) C Repair';
        tooltip = 'C Repair: scan the current .c file';
        this.item.backgroundColor = undefined;
        break;
      case 'starting':
        this.item.text = '$(loading~spin) C Repair: starting';
        tooltip = 'Starting the C Repair bridge…';
        this.item.backgroundColor = undefined;
        break;
      case 'ready':
        this.item.text = '$(shield) C Repair: ready';
        tooltip = 'C Repair bridge is ready';
        this.item.backgroundColor = undefined;
        break;
      case 'scanning':
        this.item.text = '$(loading~spin) C Repair: scanning';
        tooltip = 'Scanning the current file…';
        this.item.backgroundColor = undefined;
        break;
      case 'stale':
        this.item.text = '$(warning) C Repair: stale';
        tooltip = detail ?? STALE_RESULTS_MESSAGE;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'error':
        this.item.text = '$(error) C Repair: error';
        tooltip = detail ?? 'C Repair encountered an error — see the Output channel';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
    this.baseTooltip = tooltip;
    this.item.tooltip = this.withExtraInfo(tooltip);
  }

  dispose(): void {
    this.item.dispose();
  }
}
