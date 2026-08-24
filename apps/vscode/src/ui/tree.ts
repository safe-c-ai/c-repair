// C Repair TreeView (view id `crepairResults`, VSCODE_V1B_DESIGN.md §4). Shows:
//   <filename>  (N functions / V violations / U uncertain)
//   ├─ fn <name>   CLEAN | <rule> violation | uncertain
//   │   └─ <finding>  (violation findings expose an inline "Generate Repair")
//   │       └─ candidate cand-xx  [repair_ready] | [insufficient evidence] | …
//   │           ├─ ✓ compile: pass
//   │           └─ ⚠ behavior_check: skipped — <detail>
// Value derivation (counts, aggregate status, badges, validation labels) lives
// in ui/model.ts; this file only builds vscode.TreeItem nodes and passes the
// node itself as the command argument (VS Code hands the node to view/item
// commands, so identifiers ride on the node, not on ad-hoc item properties).

import * as vscode from 'vscode';
import type { Finding, ScanFunction, RepairCandidate, Validation } from '@c-repair/contract';
import type { ScanSession } from '../session/ScanSession';
import {
  aggregateStatus,
  findingMessage,
  scanCounts,
  candidateBadge,
  candidateLabel,
  candidateTooltip,
  candidateHasDiff,
  badgeAcceptable,
  validationDescriptor,
  STALE_RESULTS_MESSAGE,
  type FunctionStatus,
  type CandidateBadge,
} from './model';
import {
  contextStateFor,
  contextStateLabel,
  contextIncompleteLabel,
} from '../session/contextReview';
import { combineHeaderMessage } from './headerMessage';

// --- node model -------------------------------------------------------------

export type CRepairNode =
  | { kind: 'file' }
  | { kind: 'stale' }
  | { kind: 'function'; fn: ScanFunction }
  | { kind: 'finding'; fn: ScanFunction; finding: Finding }
  | { kind: 'candidate'; candidate: RepairCandidate }
  | { kind: 'validation'; candidateId: string; validation: Validation };

type Node = CRepairNode;

export class CRepairTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private session: ScanSession | undefined;

  /**
   * The TreeView this provider backs, attached after `createTreeView` so the
   * session token/cost line (D-030) can be pushed to `treeView.message` (the row of
   * text VS Code renders above the tree). Optional so the provider still works when
   * used bare (e.g. some unit contexts).
   */
  private view: vscode.TreeView<Node> | undefined;

  /**
   * The last session-usage line (D-030), mirrored here so it survives a tree
   * refresh and so the integration suite can assert it via `(tree as any).message`.
   * `undefined` clears the session line (no metering reading / tracker disabled) —
   * the always-on model line still shows.
   */
  message: string | undefined;

  /**
   * The always-on model / tier / reasoning line shown as the header's first row
   * (e.g. "Model: … (PAID) · reasoning: xhigh"). Kept separate from `message` so a
   * scan reset that clears the session line never hides the model line, and so the
   * integration suite can assert it via `(tree as any).modelLine`. `undefined`
   * before the first model line is computed.
   */
  modelLine: string | undefined;

  /** Attach the TreeView so the header-driving setters can push its `message` row. */
  attachView(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.renderHeader();
  }

  /**
   * Set the session token/cost line shown above the tree (D-030). Mirrors to the
   * public `message` field (test-observable, survives refresh) and re-renders the
   * combined header (model line + session line). Pass undefined to clear the
   * session line; the model line stays.
   */
  setMessage(message: string | undefined): void {
    this.message = message;
    this.renderHeader();
  }

  /**
   * Set the always-on model / tier / reasoning line and re-render the header. Driven
   * by the extension whenever the effective model/reasoning could change (bridge
   * ready, settings change, mode switch, bridge restart). Pass undefined to clear it.
   */
  setModelLine(modelLine: string | undefined): void {
    this.modelLine = modelLine;
    this.renderHeader();
  }

  /**
   * Push the combined header (model line, then session line) to the live TreeView.
   * The model line is always first; the session line follows on its own row when a
   * scan is active. With neither, the header is cleared.
   */
  private renderHeader(): void {
    if (!this.view) return;
    this.view.message = this.modelLine
      ? combineHeaderMessage(this.modelLine, this.message)
      : this.message;
  }

  /** Replace the displayed session (or clear it). Fires a full refresh. */
  setSession(session: ScanSession | undefined): void {
    this.session = session;
    this._onDidChange.fire(undefined);
  }

  /** Re-render (e.g. after stale toggled, or a candidate/decision changed). */
  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'file':
        return this.fileItem();
      case 'stale':
        return this.staleItem();
      case 'function':
        return this.functionItem(node.fn);
      case 'finding':
        return this.findingItem(node.finding);
      case 'candidate':
        return this.candidateItem(node.candidate);
      case 'validation':
        return this.validationItem(node.candidateId, node.validation);
    }
  }

  getChildren(node?: Node): Node[] {
    if (!this.session) return [];
    if (!node) {
      // Roots: the file node, plus a stale banner node when stale.
      const roots: Node[] = [{ kind: 'file' }];
      if (this.session.stale) roots.unshift({ kind: 'stale' });
      return roots;
    }
    if (node.kind === 'file') {
      return this.session.scanResult.functions.map((fn) => ({ kind: 'function', fn }));
    }
    if (node.kind === 'function') {
      return node.fn.findings.map((finding) => ({ kind: 'finding', fn: node.fn, finding }));
    }
    if (node.kind === 'finding') {
      // A finding gains a candidate child once one has been generated.
      const candidate = this.session.candidateForFinding(node.finding.finding_id);
      return candidate ? [{ kind: 'candidate', candidate }] : [];
    }
    if (node.kind === 'candidate') {
      return node.candidate.validations.map((validation) => ({
        kind: 'validation',
        candidateId: node.candidate.candidate_id,
        validation,
      }));
    }
    // 'validation' / 'stale' are leaves.
    return [];
  }

  // --- items ----------------------------------------------------------------

  private fileItem(): vscode.TreeItem {
    const session = this.session!;
    const counts = scanCounts(session.scanResult.functions);
    const item = new vscode.TreeItem(
      session.snapshot.filename,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.description = `${counts.functions} functions / ${counts.violations} violations / ${counts.uncertain} uncertain`;
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.contextValue = 'crepair.file';
    // Context state (V2b, design §3): items count + confirmed / assumption-dependent
    // / none, in the tooltip so it is available without cluttering the row label.
    // Completeness (Codex review round) is an INDEPENDENT axis: when the last
    // /context/check before the scan still reported missing symbols, a second
    // tooltip line flags that findings may be incomplete.
    const items = session.confirmedSet.items;
    const state = contextStateFor(items);
    const incomplete = contextIncompleteLabel(session.contextStillMissing);
    item.tooltip = incomplete
      ? `${contextStateLabel(state, items.length)}\n${incomplete}`
      : contextStateLabel(state, items.length);
    if (session.stale) item.description += ' — stale';
    return item;
  }

  private staleItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'Results are stale — scan again',
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon('warning');
    item.tooltip = STALE_RESULTS_MESSAGE;
    item.contextValue = 'crepair.stale';
    item.command = {
      command: 'crepair.scanCurrentFile',
      title: 'Rescan',
    };
    return item;
  }

  private functionItem(fn: ScanFunction): vscode.TreeItem {
    const status = aggregateStatus(fn);
    const hasChildren = fn.findings.length > 0;
    const item = new vscode.TreeItem(
      fn.name,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = statusLabel(status, fn);
    item.iconPath = statusIcon(status);
    item.contextValue = 'crepair.function';
    return item;
  }

  private findingItem(finding: Finding): vscode.TreeItem {
    const session = this.session!;
    const hasCandidate = session.candidateForFinding(finding.finding_id) !== undefined;
    const item = new vscode.TreeItem(
      findingMessage(finding),
      // Expand to reveal the candidate once generated; a finding without one is a leaf.
      hasCandidate
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath =
      finding.kind === 'violation'
        ? new vscode.ThemeIcon('warning')
        : new vscode.ThemeIcon('question');
    // contextValue drives the inline "Generate Repair" action. Once a candidate
    // exists the action is hidden (a second generate is not offered in V1b).
    if (finding.kind === 'violation') {
      item.contextValue = hasCandidate
        ? 'crepair.finding.violation.hasCandidate'
        : 'crepair.finding.violation';
    } else {
      item.contextValue = 'crepair.finding.uncertain';
    }
    // Jump to the finding location when clicked.
    const uri = vscode.Uri.parse(session.snapshot.uri);
    const line = Math.max(0, finding.location.start_line - 1);
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }],
    };
    return item;
  }

  private candidateItem(candidate: RepairCandidate): vscode.TreeItem {
    const session = this.session!;
    const badge = candidateBadge(candidate);
    const decision = session.decisionFor(candidate.candidate_id);
    const hasChildren = candidate.validations.length > 0;
    // Primary label leads with a human "Proposed fix <badge>" (V1c-UX); the
    // internal candidate_id / model_identity move to the tooltip.
    const item = new vscode.TreeItem(
      candidateLabel(badge),
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    // Description carries only the decision tag (badge is already in the label).
    // An accept over a judgment-gate warning (D-023) shows `[accepted ⚠]` so the
    // override fact is visible after the fact.
    const acceptedWithWarning =
      decision === 'accepted' && session.wasAcceptedWithWarning(candidate.candidate_id);
    item.description = acceptedWithWarning
      ? '[accepted ⚠]'
      : decision === 'accepted'
        ? '[accepted]'
        : decision === 'rejected'
          ? '[rejected]'
          : '';
    item.iconPath = candidateIcon(badge, decision);
    item.tooltip = candidateTooltip(candidate);
    item.contextValue = candidateContextValue(badge, decision);
    return item;
  }

  private validationItem(candidateId: string, v: Validation): vscode.TreeItem {
    const d = validationDescriptor(v);
    const item = new vscode.TreeItem(d.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = validationIcon(v);
    item.contextValue = 'crepair.validation';
    // The full detail (untruncated in the response) lives in the tooltip, and a
    // click dumps it to the "C Repair" Output channel for the full text (V1c-UX).
    if (v.detail) {
      item.tooltip = v.detail;
      item.command = {
        command: 'crepair.showValidationDetail',
        title: 'Show validation detail',
        arguments: [{ candidateId, name: v.name, status: v.status, detail: v.detail }],
      };
    }
    return item;
  }
}

// --- badge / context / icon helpers -----------------------------------------

/**
 * The candidate node's contextValue selects which inline actions show
 * (package.json view/item/context `when`). Encodes badge acceptability +
 * whether a diff exists + the decision, so Accept/Reject/Show Diff appear only
 * when meaningful:
 *   crepair.candidate.<diffable|nodiff>.<acceptable|blocked>.<pending|accepted|rejected>
 */
export function candidateContextValue(badge: CandidateBadge, decision: string): string {
  const diff = badge === 'no_fix' ? 'nodiff' : 'diffable';
  const accept = badgeAcceptable(badge) ? 'acceptable' : 'blocked';
  const dec = decision === 'accepted' ? 'accepted' : decision === 'rejected' ? 'rejected' : 'pending';
  return `crepair.candidate.${diff}.${accept}.${dec}`;
}

function candidateIcon(badge: CandidateBadge, decision: string): vscode.ThemeIcon {
  if (decision === 'accepted') {
    return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
  }
  if (decision === 'rejected') {
    return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
  }
  switch (badge) {
    case 'repair_ready':
      return new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('testing.iconPassed'));
    case 'insufficient_evidence':
      return new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('list.warningForeground'));
    case 'review_required':
      // A judgment gate failed: Accept is allowed but flagged (D-023). Warning
      // colour, not error, since it is not a hard mechanical fault.
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'validation_failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    case 'no_fix':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
  }
}

function validationIcon(v: Validation): vscode.ThemeIcon {
  switch (v.status) {
    case 'pass':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'fail':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    case 'skipped':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'not_run':
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
  }
}

export { candidateHasDiff };

function statusLabel(status: FunctionStatus, fn: ScanFunction): string {
  if (status === 'VIOLATION_FOUND') {
    const v = fn.findings.find((f) => f.kind === 'violation');
    const rule = v?.rule_id ? `${v.rule_id} ` : '';
    return `${rule}violation`;
  }
  if (status === 'UNCERTAIN') return 'uncertain';
  return 'CLEAN';
}

function statusIcon(status: FunctionStatus): vscode.ThemeIcon {
  switch (status) {
    case 'VIOLATION_FOUND':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.warningForeground'));
    case 'UNCERTAIN':
      return new vscode.ThemeIcon('question');
    case 'CLEAN':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
  }
}
