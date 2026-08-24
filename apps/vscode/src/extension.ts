// C Repair VS Code extension entry point (VSCODE_V1B_DESIGN.md §1–§6, V1b-1).
//
// Wires together: bridge lifecycle (BridgeManager), the scan flow (infer →
// confirm → scan), Diagnostics + TreeView + status bar rendering, BYOK API-key
// commands (SecretStorage), the one-time external-route notice, and stale
// monitoring (debounced hash comparison on document change).
//
// SECURITY: the API key lives only in SecretStorage; the Bearer token lives only
// in the bridge child's env. Neither is logged. See log.ts / BridgeManager.ts.

import * as vscode from 'vscode';
import { dirname, join as pathJoin } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { API_KEY_SECRET, BridgeError, BridgeManager, type BridgeHandle } from './bridge/BridgeManager';
import {
  runBootstrap,
  BootstrapError,
  UV_MANUAL_INSTALL_URL,
  type BootstrapDeps,
  type ExecResult,
} from './bridge/bootstrap';
import { ScanSession } from './session/ScanSession';
import { contentHash } from './session/hash';
import {
  buildReviewDoc,
  parseReviewDoc,
} from './session/contextReviewDoc';
import {
  getCachedContext,
  setCachedContext,
  evictCachedContext,
  clearAllCachedContext,
} from './session/contextCache';
import {
  EXTERNAL_NOTICE_SHOWN_KEY,
  FREE_MODEL_NOTICE_SHOWN_KEY,
  MODEL_MODE_CHOSEN_KEY,
  RESET_GLOBAL_STATE_KEYS,
  WALKTHROUGH_SHOWN_KEY,
  shouldOpenWalkthrough,
} from './session/resetState';
import {
  MODEL_MODE_GATE_ACTION,
  MODEL_MODE_GATE_MESSAGE,
  shouldPromptModelMode,
  shouldRecordWithoutPrompt,
  shouldMigrateLegacyFreeModel,
  modelModeConfigUpdates,
  switchToCustomConfigUpdates,
  type ModelMode,
} from './session/modelMode';
import {
  decideConfigChangeNotice,
  decideStartupConfigNotice,
  unusedSettingsParts,
  unusedSettingsMessage,
  hasUnusedParts,
  useCustomActionLabel,
  clearUnusedSettingsUpdates,
  DISCARD_ACTION,
  NOT_NOW_ACTION,
  RESTART_MESSAGE,
  RESTART_ACTION,
  type ChangedSettings,
} from './session/configChangeNotice';
import {
  decideReview,
  checkResultMessage,
  scanIncompletenessWarning,
  type ContextReviewMode,
} from './session/contextReview';
import {
  createDiagnostics,
  setScanDiagnostics,
  setStaleDiagnostic,
} from './ui/diagnostics';
import { CRepairTreeProvider, type CRepairNode } from './ui/tree';
import { modelLineText } from './ui/headerMessage';
import { externalRouteText } from './ui/externalRouteNotice';
import { modelProvidersUrl } from './ui/modelProviders';
import { StatusBar } from './ui/statusBar';
import type { HealthCapabilities } from './bridge/health';
import {
  CRepairContentProvider,
  CREPAIR_SCHEME,
  showCandidateDiff,
  reviewLeftUri,
  candidateIdFromUri,
  type DiffSource,
} from './ui/diffView';
import { ValidationLensProvider } from './ui/validationLens';
import {
  violationTargetsInOrder,
  planAutoRepair,
  diffableQueue,
  nextPendingDiffable,
  firstPendingDiffable,
  reviewTally,
  selectAcceptAllReviewed,
  acceptAllSummary,
  type AcceptAllTally,
  type QueueTarget,
} from './session/reviewQueue';
import { stripCommentsPreserveLines } from './session/stripComments';
import { applyCandidate } from './apply/acceptCandidate';
import {
  buildCompileIncludePaths,
  DEFAULT_INCLUDE_PATH_SETTINGS,
} from './session/includePaths';
import {
  evaluateAcceptGuard,
  candidateHasDiff,
  acceptWarningPickItems,
  STALE_RESULTS_MESSAGE,
  type AcceptWarningPickItem,
} from './ui/model';
import { CRepairCodeActionProvider } from './ui/codeActions';
import {
  fetchKeyUsage,
  fetchKeyInfo,
  usageDelta,
  formatUsd,
  shouldQueryUsage,
} from './cost/openrouterUsage';
import {
  decideFreeSwitch,
  hasExplicitModel,
  normalizeModelMode,
  normalizeProviderPolicy,
  DEFAULT_OVERRIDES,
  DEFAULT_MODE_LABEL,
  DEFAULT_MODE_LABEL_LOWER,
} from './bridge/overrideEnv';
import {
  buildRepairReport,
  type RepairReportInput,
  type ProvenanceCount,
} from './session/repairReport';
import { buildFeedbackData, type FeedbackDataInput } from './session/feedbackData';
import {
  REJECT_REASONS,
  REJECT_REASON_PLACEHOLDER,
  type RejectReason,
} from './session/rejectReason';
import { effectiveModelLabel } from './bridge/health';
import { BridgeHttpError, isCancellation } from './bridge/BridgeClient';
import { isLargeRepair } from './bridge/repairTimeout';
import {
  sessionUsageMessage,
  shouldPollUsage,
  type SessionUsage,
} from './cost/sessionUsage';
import {
  runOAuthFlow,
  oauthFailureNotification,
  validateCodeInput,
  CODE_PROMPT,
  CODE_PLACEHOLDER,
  RETRY_ACTION,
  MANUAL_KEY_ACTION,
  OAuthError,
  type OAuthDeps,
} from './auth/openrouterOAuth';
import { initLog, logBlock, logError, logInfo, logShow } from './log';
import type {
  SourceDocument,
  Finding,
  ScanFunction,
  RepairCandidate,
  ContextAugmentationSet,
  Validation,
} from '@c-repair/contract';

const STALE_DEBOUNCE_MS = 300;
// The globalState one-time-flag keys (EXTERNAL_NOTICE_SHOWN_KEY /
// FREE_MODEL_NOTICE_SHOWN_KEY) live in session/resetState.ts so Reset Extension
// State and every write site share one definition; imported above.
/** Default free model (mirrors package.json `crepair.freeModel`). */
const DEFAULT_FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

let bridge: BridgeManager;
let diagnostics: vscode.DiagnosticCollection;
let tree: CRepairTreeProvider;
let statusBar: StatusBar;
let contentProvider: CRepairContentProvider;
/** CodeLens on the candidate diff's right pane surfacing validation results. */
let validationLens: ValidationLensProvider;

/** The single active session (one file / one scan; re-scan replaces it). */
let session: ScanSession | undefined;
let staleTimer: NodeJS.Timeout | undefined;

/**
 * The effective /health capabilities from the last bridge handshake, mirrored at
 * module scope so the always-on TreeView model line can be rebuilt on a settings
 * change / mode switch without a fresh health read. `undefined` before the bridge
 * has reported (or after it is stopped) — the model line then falls back to settings.
 */
let lastCapabilities: HealthCapabilities | undefined;

/**
 * The in-flight Context Review (V2b, design §3). Set when infer returns items and
 * the Review doc is opened; the confirm/skip commands read it, run the scan, and
 * clear it. At most one is pending (a new scan replaces any prior one). Held at
 * module scope so the commands (also runnable from the Command Palette when the
 * notification is dismissed) can act on it.
 */
interface PendingReview {
  /** Stable id keying the read-only left side (stripped Original) in the diff. */
  reviewId: string;
  /** The untitled Review document (right, editable side of the diff). */
  reviewDoc: vscode.TextDocument;
  /** The source scanned (replayed verbatim to confirm/check/scan). */
  source: SourceDocument;
  /** The draft set from /context/infer (its items back the parse). */
  draft: ContextAugmentationSet;
  /** The scanned document's URI string (the real .c file), for the session. */
  targetUri: string;
  filename: string;
  content: string;
  fileDir: string | undefined;
  compileIncludePaths: string[];
  /** The extension context (for workspaceState cache writes on confirm/skip). */
  context: vscode.ExtensionContext;
  /**
   * D-025: whether the caller was "Scan & Fix" (run the auto-repair pipeline after
   * the scan) or plain "Scan" (scan only). Threaded through the Review because the
   * confirm/skip commands run the scan later.
   */
  runFix: boolean;
}
let pendingReview: PendingReview | undefined;

/**
 * The extension context, held at module scope so the cost-usage helpers can read
 * the BYOK key from SecretStorage after a scan/fix without re-plumbing it through
 * every call site. Set once in activate().
 */
let extensionContext: vscode.ExtensionContext | undefined;

/**
 * D-025 cost tracking for the in-flight Scan & Fix pipeline. `session` is the run
 * whose spend we are measuring; `before` is the OpenRouter usage (USD) sampled just
 * before generation started, or null when it could not be read. Read when the review
 * queue completes to show the approximate spend, then cleared. `undefined` when no
 * Scan & Fix run is being measured.
 */
let pipelineUsage: { session: ScanSession; before: number | null } | undefined;

/**
 * A tiny test-only surface, returned from activate() ONLY when the integration
 * hook (CREPAIR_TEST_BRIDGE_URL) is set. It lets the @vscode/test-electron suite
 * seed the BYOK secret and inspect the live session/tree without spawning python
 * or opening input boxes. In production the env var is unset and activate()
 * returns undefined (no test surface leaks).
 */
export interface CRepairTestApi {
  seedApiKey(key: string): Thenable<void>;
  getSession(): ScanSession | undefined;
  getTree(): CRepairTreeProvider;
  /** V2b: the open Review document (untitled), or undefined when none is pending. */
  getReviewDoc(): vscode.TextDocument | undefined;
  /** V2b: replace the Review document's text (simulates a user edit). */
  setReviewDocText(text: string): Thenable<boolean>;
  /** V2b: drop the confirmed-context cache for a content_hash (test isolation). */
  clearContextCache(contentHash: string): Thenable<void>;
  /**
   * D-024: the candidate_id of the diff currently shown in the review queue (the
   * one the title-bar Accept/Reject/Next act on), or undefined when no crepair diff
   * is active. Lets the integration suite drive the queue without a real title bar.
   */
  getActiveDiffCandidateId(): string | undefined;
  /**
   * D-027: install the fake OAuth seams the `crepair.connectOpenRouter` command
   * uses when the CREPAIR_TEST_OAUTH hook env is set (no browser, no socket, no
   * network). Lets the integration suite assert the command is registered and
   * drives the store path without a real OAuth flow.
   */
  setOAuthTestDeps(deps: OAuthDeps): void;
  /** D-027: read the BYOK key from SecretStorage (to assert Connect stored it). */
  getApiKey(): Thenable<string | undefined>;
  /** D-031: whether the model-mode selection flag is set (to assert it was recorded). */
  getModelModeChosen(): boolean;
}

export function activate(context: vscode.ExtensionContext): CRepairTestApi | undefined {
  initLog(context);
  logInfo('C Repair activated.');

  extensionContext = context;
  // V3a (D-036): the globalStorage path hosts the provisioned bridge venv
  // (resolution step ③, populated by "C Repair: Set Up Bridge").
  bridge = new BridgeManager(context.secrets, context.globalStorageUri.fsPath);
  diagnostics = createDiagnostics();
  tree = new CRepairTreeProvider();
  statusBar = new StatusBar();
  // The diff content provider reads candidates off the live session by id, and the
  // Context Review's read-only left side (comment-stripped Original) off the pending
  // review by id.
  contentProvider = new CRepairContentProvider(
    (candidateId) => diffSourceFor(candidateId),
    (reviewId) => reviewLeftContentFor(reviewId),
  );
  // CodeLens on the candidate diff's applied-after (right) side: the validation
  // results (fail reasons / skipped gates / all-pass summary) rendered at the
  // moment of judgment. Resolves the candidate off the live session by id; a diff
  // whose candidate is gone simply gets no lens.
  validationLens = new ValidationLensProvider((candidateId) =>
    session?.candidateById(candidateId),
  );

  // Create the TreeView (not just registerTreeDataProvider) so the session
  // token/cost line (D-030) can be pushed to its `message` header row.
  const treeView = vscode.window.createTreeView('crepairResults', { treeDataProvider: tree });
  tree.attachView(treeView);
  // One-time migration (D-031): older builds recorded a `free` choice by writing
  // crepair.model = crepair.freeModel. Migrate that to crepair.modelMode=free (and
  // clear the stray crepair.model) so the mode is the single source of truth.
  // AFTER it settles, run the startup settings-mismatch check (sample9 follow-up) —
  // sequenced so a legacy state the migration just resolved is not flagged.
  void migrateLegacyFreeModel().then(() => maybeShowStartupConfigNotice());

  // Populate the always-on model line immediately from settings so the header shows
  // the effective model / tier / reasoning before the first scan; a scan replaces it
  // with the live /health value (applyCapabilities).
  refreshModelLine();

  context.subscriptions.push(
    diagnostics,
    statusBar,
    bridge,
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(CREPAIR_SCHEME, contentProvider),
    vscode.languages.registerCodeLensProvider({ scheme: CREPAIR_SCHEME }, validationLens),
    bridge.onStateChange((s) => {
      if (s === 'starting') statusBar.set('starting');
      else if (s === 'error') statusBar.set('error');
      else if (s === 'ready') void refreshUsage(); // D-025: refresh spend when the bridge comes up
      // 'ready'/'stopped' are reflected by the scan flow / stale state instead.
    }),
    // D-025: "Scan Current File" scans only (no auto-generate); "Scan & Fix Current
    // File" additionally runs the D-024 auto-repair pipeline. Both share one scan
    // implementation; only the trailing pipeline differs.
    vscode.commands.registerCommand('crepair.scanCurrentFile', () =>
      scanCurrentFile(context, false),
    ),
    vscode.commands.registerCommand('crepair.scanAndFixCurrentFile', () =>
      scanCurrentFile(context, true),
    ),
    // V2b Context Review commands: also palette-runnable when the notification is
    // dismissed. They act on the single `pendingReview` (a no-op message if none).
    vscode.commands.registerCommand('crepair.confirmContextAndScan', () =>
      confirmContextAndScan(),
    ),
    vscode.commands.registerCommand('crepair.skipContextAndScan', () => skipContextAndScan()),
    vscode.commands.registerCommand('crepair.editContext', () => editContext(context)),
    vscode.commands.registerCommand('crepair.connectOpenRouter', () =>
      connectOpenRouter(context),
    ),
    // A: open the Settings UI filtered to the C Repair section (@ext-style query).
    vscode.commands.registerCommand('crepair.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'crepair'),
    ),
    // Open the OpenRouter model page for the current effective model, which lists the
    // providers serving it. Uses crepair.model (or the verified default when blank).
    vscode.commands.registerCommand('crepair.openModelProviders', () => openModelProviders()),
    vscode.commands.registerCommand('crepair.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('crepair.clearApiKey', () => clearApiKey(context)),
    // D-031: re-run the first-run model-mode selection at any time (free <-> default).
    vscode.commands.registerCommand('crepair.chooseModelMode', () =>
      chooseModelMode(context, { reselect: true }),
    ),
    vscode.commands.registerCommand('crepair.resetExtensionState', () =>
      resetExtensionState(context),
    ),
    vscode.commands.registerCommand('crepair.generateRepair', (node?: CRepairNode) =>
      generateRepair(node),
    ),
    vscode.commands.registerCommand('crepair.regenerateRepair', (node?: CRepairNode) =>
      regenerateRepair(node),
    ),
    vscode.commands.registerCommand('crepair.showDiff', (node?: CRepairNode) => showDiff(node)),
    vscode.commands.registerCommand('crepair.acceptCandidate', (node?: CRepairNode) =>
      acceptCandidate(node),
    ),
    vscode.commands.registerCommand('crepair.acceptAllReviewed', () => acceptAllReviewed()),
    vscode.commands.registerCommand('crepair.exportRepairReport', () =>
      exportRepairReport(context),
    ),
    vscode.commands.registerCommand('crepair.exportFeedbackData', () =>
      exportFeedbackData(context),
    ),
    vscode.commands.registerCommand('crepair.setUpBridge', () => setUpBridge()),
    vscode.commands.registerCommand('crepair.rejectCandidate', (node?: CRepairNode) =>
      rejectCandidate(node),
    ),
    // D-024 diff title-bar commands: act on the candidate whose diff is currently
    // shown (recovered from the active diff editor's URI). Accept/Reject advance to
    // the next pending diffable candidate; Next skips without a decision; Regenerate
    // re-runs /repair for the shown candidate and re-opens its diff.
    vscode.commands.registerCommand('crepair.acceptCurrentDiff', () => acceptCurrentDiff()),
    vscode.commands.registerCommand('crepair.rejectCurrentDiff', () => rejectCurrentDiff()),
    vscode.commands.registerCommand('crepair.regenerateCurrentDiff', () =>
      regenerateCurrentDiff(),
    ),
    vscode.commands.registerCommand('crepair.nextDiff', () => nextDiff()),
    vscode.commands.registerCommand(
      'crepair.showValidationDetail',
      (arg?: ValidationDetailArg) => showValidationDetail(arg),
    ),
    // Quick Fix on a C Repair diagnostic (Ctrl+.) -> generate a repair for that
    // finding via the same generateRepair path as the TreeView action.
    vscode.languages.registerCodeActionsProvider(
      { language: 'c' },
      new CRepairCodeActionProvider(() => session),
      { providedCodeActionKinds: CRepairCodeActionProvider.providedCodeActionKinds },
    ),
    vscode.commands.registerCommand(
      'crepair.generateRepairForFinding',
      (findingId?: string) => generateRepairForFinding(findingId),
    ),
    vscode.workspace.onDidChangeTextDocument(onDocumentChanged),
    vscode.workspace.onDidChangeConfiguration(onConfigChanged),
  );

  // V3c: auto-open the Getting Started walkthrough ONCE, on the very first
  // activation (one-time globalState flag; Reset Extension State re-arms it).
  // Skipped in the integration test host (the walkthrough tab would disturb
  // editor-focused assertions) — the same guard the test bridge uses.
  if (!process.env.CREPAIR_TEST_BRIDGE_URL && shouldOpenWalkthrough((k) => context.globalState.get(k))) {
    void context.globalState.update(WALKTHROUGH_SHOWN_KEY, true);
    void vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      // Derived from the runtime extension id so a publisher change can never
      // silently break the walkthrough deep link.
      `${context.extension.id}#crepair.gettingStarted`,
    );
    logInfo('First activation: opened the Getting Started walkthrough.');
  }

  if (process.env.CREPAIR_TEST_BRIDGE_URL) {
    return {
      seedApiKey: (key: string) => context.secrets.store(API_KEY_SECRET, key),
      getSession: () => session,
      getTree: () => tree,
      getReviewDoc: () => pendingReview?.reviewDoc,
      setReviewDocText: async (text: string): Promise<boolean> => {
        const rd = pendingReview?.reviewDoc;
        if (!rd) return false;
        const edit = new vscode.WorkspaceEdit();
        const full = new vscode.Range(
          rd.positionAt(0),
          rd.positionAt(rd.getText().length),
        );
        edit.replace(rd.uri, full, text);
        return vscode.workspace.applyEdit(edit);
      },
      clearContextCache: (contentHash: string) =>
        evictCachedContext(context.workspaceState, contentHash),
      getActiveDiffCandidateId: () => activeDiffCandidateId(),
      setOAuthTestDeps: (deps: OAuthDeps) => {
        oauthTestDeps = deps;
      },
      getApiKey: () => context.secrets.get(API_KEY_SECRET),
      getModelModeChosen: () => context.globalState.get<boolean>(MODEL_MODE_CHOSEN_KEY) === true,
    };
  }
  return undefined;
}

export function deactivate(): void {
  if (staleTimer) clearTimeout(staleTimer);
  bridge?.kill();
  logInfo('C Repair deactivated.');
}

// --- scan flow --------------------------------------------------------------

/**
 * Scan the active .c file (D-025). `runFix` selects the command variant:
 *   - false ("Scan Current File"): scan only — no auto-repair (pre-D-024 behaviour).
 *   - true  ("Scan & Fix Current File"): scan, then run the D-024 auto-repair
 *     pipeline (auto-generate + diff review queue) with the cost-guard confirm.
 * The two share this whole implementation; only the trailing pipeline differs, so
 * `runFix` is threaded through every scan-complete path (cache-hit / direct /
 * confirm / skip) and the Review's pending state.
 */
async function scanCurrentFile(
  context: vscode.ExtensionContext,
  runFix: boolean,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('C Repair: open a C file to scan.');
    return;
  }
  const doc = editor.document;

  // Only real .c files (not untitled, not other languages).
  if (doc.isUntitled) {
    void vscode.window.showInformationMessage(
      'C Repair: save this file as a .c file before scanning.',
    );
    return;
  }
  if (!doc.fileName.endsWith('.c')) {
    void vscode.window.showInformationMessage('C Repair: scanning is only available for .c files.');
    return;
  }

  // API key required (BYOK). Offer Connect (browser OAuth) / Enter manually, plus
  // a "$OPENROUTER_API_KEY" option when that env var is present (developer path).
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  if (!apiKey) {
    const envKey = process.env.OPENROUTER_API_KEY?.trim();
    const actions = envKey
      ? ['Connect', 'Enter manually', 'Use $OPENROUTER_API_KEY']
      : ['Connect', 'Enter manually'];
    const pick = await vscode.window.showInformationMessage(
      'C Repair needs an OpenRouter API key to scan.',
      ...actions,
    );
    if (pick === 'Connect') await connectOpenRouter(context);
    else if (pick === 'Enter manually') await enterKeyManually(context);
    else if (pick === 'Use $OPENROUTER_API_KEY' && envKey)
      await storeAndVerifyKey(context, envKey, 'Connected ✓');
    return;
  }

  // One-time external-route notice (D-016): source code is sent to an LLM.
  const proceed = await confirmExternalRoute(context);
  if (!proceed) return;

  // D-031: first-run model-mode choice. A scan is a billing boundary, so if the user
  // dismissed (Esc) the picker at key-set time it must appear here — a credited key
  // never starts a billable default-model scan before the user has chosen once.
  // FAIL-CLOSED: when the picker is dismissed again (no mode settled), the scan is
  // aborted — continuing would silently bill the preset model without consent. The
  // flag stays unrecorded, so every scan attempt re-asks until a mode is chosen.
  const modeSettled = await maybePromptModelMode(context);
  if (!modeSettled) {
    void vscode.window
      .showInformationMessage(MODEL_MODE_GATE_MESSAGE, MODEL_MODE_GATE_ACTION)
      .then((pick) => {
        if (pick === MODEL_MODE_GATE_ACTION) {
          void vscode.commands.executeCommand('crepair.chooseModelMode');
        }
      });
    logInfo('Scan aborted: no model mode chosen yet (fail-closed billing gate).');
    return;
  }

  // B (free-model auto-run): a key with no credits (is_free_tier) auto-switches the
  // bridge to the free model (warn once), and a key that later gains credits reverts
  // to the normal construction. Best-effort — a query failure leaves things as-is.
  await applyFreeModelSwitch(context, apiKey);

  const content = doc.getText();
  const filename = fileBasename(doc.fileName);
  const hash = contentHash(content);

  // Directory of the scanned file (D-020): only for real `file`-scheme documents.
  // Auto-included as `-I <dir>` so headers next to the .c are found by compile.
  const fileDir = doc.uri.scheme === 'file' ? dirname(doc.uri.fsPath) : undefined;
  const compileIncludePaths = buildCompileIncludePaths(readIncludePathSettings(), fileDir);

  const source: SourceDocument = {
    source_id: `src-${hash.slice(7, 23)}`, // derived from content_hash (VSCODE_V1B_DESIGN §3)
    filename,
    language: 'c',
    content,
    content_hash: hash,
    size_bytes: Buffer.byteLength(content, 'utf8'),
    origin: 'vscode_document',
  };

  const reviewMode = readContextReviewMode();

  try {
    // 1) Cache fast-path (design §3): a confirmed set for THIS content_hash means
    // the file is unchanged and was already reviewed/skipped — skip infer + Review
    // and scan straight through with the cached set. A source edit changes the
    // hash and misses naturally (D-006).
    const cached = getCachedContext(context.workspaceState, hash);
    if (cached) {
      // D-030: this is a scan entry point — reset + poll session usage over the scan.
      const counts = await withUsageTracking(async () => {
        const handle = await ensureBridgeForScan(true);
        return runScanWithConfirmed(
          handle,
          doc,
          source,
          cached,
          filename,
          content,
          fileDir,
          compileIncludePaths,
          hash,
        );
      });
      notifyScanComplete(counts);
      await afterScanComplete(runFix);
      return;
    }

    // 2) Infer the draft context (design §1), then decide whether to Review. D-030:
    // reset the session counters here (infer is the session's first LLM call) and
    // poll while infer runs.
    const { handle, draft } = await withUsageTracking(() =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'C Repair: inferring context',
          cancellable: false,
        },
        async (progress) => {
          statusBar.set('scanning');
          progress.report({ message: 'starting bridge…' });
          const h = await ensureBridgeForScan(true);
          progress.report({ message: 'inferring context…' });
          const d = await h.client.inferContext(source, compileIncludePaths);
          return { handle: h, draft: d };
        },
      ),
    );

    const decision = decideReview(reviewMode, draft.items.length);

    if (decision === 'review') {
      // 3a) Open the Review UX and stash the pending state; the confirm/skip
      // commands take over from here (they run the scan). `runFix` rides along so
      // the deferred scan runs the right (scan-only vs scan+fix) tail.
      await openContextReview(
        context,
        source,
        draft,
        doc.uri.toString(),
        filename,
        content,
        fileDir,
        compileIncludePaths,
        runFix,
      );
      return;
    }

    // 3b) Direct / Skip: confirm the draft as-is (items stay unconfirmed for a
    // non-empty skip -> assumption-dependent §2; an empty draft is trivially
    // confirmed) and scan. Cache the confirmed set so a re-scan short-circuits.
    const counts = await withUsageTracking(async () => {
      const confirmed = await handle.client.confirmContext(draft);
      await setCachedContext(context.workspaceState, hash, confirmed);
      return runScanWithConfirmed(
        handle,
        doc,
        source,
        confirmed,
        filename,
        content,
        fileDir,
        compileIncludePaths,
        hash,
      );
    });
    notifyScanComplete(counts);
    await afterScanComplete(runFix);
  } catch (err) {
    handleScanError(err);
  }
}

/**
 * The shared tail after every scan completes (D-025). Refreshes the status-bar
 * usage tooltip, then — only for Scan & Fix (`runFix`) — runs the auto-repair
 * pipeline against the just-installed session. Scan-only stops here.
 */
async function afterScanComplete(runFix: boolean): Promise<void> {
  if (!runFix) {
    await refreshUsage();
    return;
  }
  await runAutoRepairPipelineForActiveSession();
}

/**
 * Start the bridge and reflect its effective model/provider in the status bar.
 * `beginSession` (D-030): when true this is a scan entry point, so the session
 * token counters are reset and the cost baseline captured before any LLM call;
 * confirm/skip (which resume an already-begun session) pass false.
 */
async function ensureBridgeForScan(beginSession = false): Promise<BridgeHandle> {
  statusBar.set('scanning');
  const handle = await bridge.ensureStarted();
  applyCapabilities(handle.health.capabilities);
  if (beginSession) await beginUsageSession(handle);
  return handle;
}

/**
 * Run /scan with an already-confirmed context set and install the resulting
 * session (the shared tail of every scan path: cache hit, direct, skip, confirm).
 * Returns the violation / uncertain counts for the completion notification.
 */
async function runScanWithConfirmed(
  handle: BridgeHandle,
  doc: vscode.TextDocument,
  source: SourceDocument,
  confirmed: ContextAugmentationSet,
  filename: string,
  content: string,
  fileDir: string | undefined,
  compileIncludePaths: string[],
  hash: string,
  contextStillMissing?: number,
): Promise<{ v: number; u: number }> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'C Repair: scanning current file',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'scanning functions…' });
      const scan = await handle.client.scan(source, confirmed, compileIncludePaths);

      // Build the session (one file / one scan; replace any prior one). Keep the
      // source + confirmed context set so /repair can be replayed later (the
      // bridge is stateless). Record the file dir so repair sends the same `-I`
      // include paths (D-020). `contextStillMissing` carries the last
      // /context/check residual into the session so the TreeView can flag a
      // known-incomplete context (undefined on paths that never checked).
      const snapshot = ScanSession.makeSnapshot(doc.uri.toString(), filename, content, fileDir);
      session = new ScanSession(
        snapshot,
        confirmed.context_revision_id ?? '',
        scan,
        source,
        confirmed,
      );
      session.contextStillMissing = contextStillMissing;

      setScanDiagnostics(diagnostics, doc.uri, scan);
      tree.setSession(session);
      // A new session replaces every candidate the lens resolves; re-request lenses
      // so any diff still open re-derives against the new session.
      validationLens.refresh();
      statusBar.set('ready');

      const c = scan.functions.reduce(
        (acc, fn) => {
          for (const f of fn.findings) {
            if (f.kind === 'violation') acc.v += 1;
            else acc.u += 1;
          }
          return acc;
        },
        { v: 0, u: 0 },
      );
      logInfo(
        `Scan complete: source_hash=${hash}, functions=${scan.functions.length}, ` +
          `violations=${c.v}, uncertain=${c.u}, ` +
          `context_items=${confirmed.items.length}.`,
      );
      return c;
    },
  );
}

/**
 * Post-scan guidance (V1c-UX task 7): tell the user how many violations /
 * uncertain findings there are and offer a one-click jump into the C Repair
 * TreeView. With zero violations we say so plainly (uncertain-only still offers
 * the results view when present).
 */
function notifyScanComplete(counts: { v: number; u: number }, contextStillMissing?: number): void {
  // Known-incomplete context (Codex review round): the last /context/check
  // still reported missing symbols, so the results may under-report. Append
  // the consequence and use a WARNING notification — especially for the
  // 0-violation case, which would otherwise read as a clean bill of health.
  const incompleteness = scanIncompletenessWarning(contextStillMissing);
  if (counts.v === 0 && counts.u === 0) {
    if (incompleteness) {
      void vscode.window.showWarningMessage(`C Repair: No violations found. ${incompleteness}`);
    } else {
      void vscode.window.showInformationMessage('C Repair: No violations found.');
    }
    return;
  }
  const summary =
    counts.v === 0
      ? `C Repair: No violations found (${counts.u} uncertain).`
      : `C Repair: Scan complete — ${counts.v} violation${counts.v === 1 ? '' : 's'} / ` +
        `${counts.u} uncertain.`;
  const show = incompleteness
    ? vscode.window.showWarningMessage(`${summary} ${incompleteness}`, 'Show Results')
    : vscode.window.showInformationMessage(summary, 'Show Results');
  void show.then((choice) => {
    if (choice === 'Show Results') void vscode.commands.executeCommand('crepairResults.focus');
  });
}

// --- free-model auto-run (B) ------------------------------------------------

/** Read `crepair.freeModel` (default DEFAULT_FREE_MODEL); blank falls back to it. */
function readFreeModel(): string {
  const v = vscode.workspace
    .getConfiguration('crepair')
    .get<string>('freeModel', DEFAULT_FREE_MODEL)
    .trim();
  return v || DEFAULT_FREE_MODEL;
}

/** Read the user's `crepair.model` (default the verified default). */
function readConfiguredModel(): string {
  return vscode.workspace
    .getConfiguration('crepair')
    .get<string>('model', DEFAULT_OVERRIDES.model);
}

/** Read `crepair.modelMode` (D-031, default `default`). Normalized to a valid mode. */
function readModelMode(): ModelMode {
  return normalizeModelMode(
    vscode.workspace.getConfiguration('crepair').get<string>('modelMode'),
  );
}

/**
 * B (free-model auto-run): at scan start, query the key's `is_free_tier` flag and,
 * per `decideFreeSwitch`, switch the bridge to the free model (warn once), revert it
 * to the normal construction, or do nothing. Best-effort and never throws — a failed
 * key query (network / offline test bridge) leaves the current construction as-is so
 * the scan proceeds. `setFreeModel` respawns the bridge lazily on the next scan call.
 */
async function applyFreeModelSwitch(
  context: vscode.ExtensionContext,
  apiKey: string,
): Promise<void> {
  // Offline in tests: the /key endpoint is openrouter.ai direct (not the fixture
  // bridge), so the integration suite must never contact it. Leave the construction
  // untouched under the test-bridge hook.
  if (process.env.CREPAIR_TEST_BRIDGE_URL) return;
  if (!apiKey) return;

  const info = await fetchKeyInfo(apiKey);
  const freeModel = readFreeModel();
  const explicitModel = hasExplicitModel(readConfiguredModel());

  // D-031: the creditless auto-fallback is a `default`-mode convenience only. In
  // `free` / `custom` mode the user owns the construction via modelMode, so
  // decideFreeSwitch returns `none` (or reverts a stale free bridge) and never
  // overrides the mode-selected env.
  const decision = decideFreeSwitch({
    mode: readModelMode(),
    hasApiKey: true,
    isFreeTier: info.isFreeTier,
    explicitModel,
    bridgeOnFree: bridge.onFreeModel,
  });

  if (decision.kind === 'switch-to-free') {
    // Warn exactly once (globalState flag), non-modal, [OK] only.
    if (!context.globalState.get<boolean>(FREE_MODEL_NOTICE_SHOWN_KEY)) {
      await context.globalState.update(FREE_MODEL_NOTICE_SHOWN_KEY, true);
      void vscode.window.showInformationMessage(
        `C Repair: this OpenRouter key has no credits. Running with the free model ` +
          `${freeModel} — quality, speed and availability are reduced. Add credits to ` +
          `use the ${DEFAULT_MODE_LABEL_LOWER} model.`,
        'OK',
      );
    }
    logInfo(`Switching bridge to free model ${freeModel} (key has no credits).`);
    bridge.setFreeModel(freeModel); // respawns lazily on the next ensureStarted()
    // Clear the stale health caps; the model line falls back to settings but now
    // reflects the free construction (onFreeModel forces the FREE tag).
    applyCapabilities(undefined);
  } else if (decision.kind === 'revert-to-normal') {
    // Credits present (or the flag became unreadable / an explicit model is set):
    // drop the free construction and return to the config-derived one. Terse notice.
    logInfo('Reverting bridge to the preset model (key has credits / explicit model set).');
    void vscode.window.showInformationMessage(
      `C Repair: credits detected — switching back to the ${DEFAULT_MODE_LABEL_LOWER} model.`,
    );
    bridge.setFreeModel(undefined); // respawns lazily on the next ensureStarted()
    applyCapabilities(undefined);
  }
  // 'none': nothing to do — already in the correct construction.
}

// --- OpenRouter cost visibility (D-025) -------------------------------------

/** Read `crepair.showCosts` (default true). When false, usage is never queried. */
function readShowCosts(): boolean {
  return vscode.workspace.getConfiguration('crepair').get<boolean>('showCosts', true);
}

/**
 * The current cumulative OpenRouter usage (USD) for the BYOK key, or null when it
 * cannot / should not be read: `crepair.showCosts=false` (no query at all — the
 * key never leaves SecretStorage), no key set, no context, or the query failed
 * (network / timeout / malformed — fetchKeyUsage returns null defensively). Never
 * throws. The key travels only in the Authorization header inside fetchKeyUsage.
 */
async function currentUsage(): Promise<number | null> {
  if (!extensionContext) return null;
  // TEST-ONLY invariant: when attached to the offline fixture bridge, NEVER contact
  // openrouter.ai. The usage endpoint is external (openrouter.ai direct, not the
  // bridge), so the fixture-bridge hook cannot intercept it; disabling it here keeps
  // the integration suite fully offline regardless of the showCosts config. Unset in
  // production, so real usage lookups run normally.
  if (process.env.CREPAIR_TEST_BRIDGE_URL) return null;
  const apiKey = await extensionContext.secrets.get(API_KEY_SECRET);
  // When showCosts is off (or no key), we do NOT contact the endpoint at all — the
  // key never leaves SecretStorage (D-025). Gate decision is the pure predicate.
  if (!shouldQueryUsage(readShowCosts(), apiKey)) return null;
  return fetchKeyUsage(apiKey!);
}

/**
 * Refresh the status-bar tooltip's cumulative-usage line (D-025). Reads the
 * current usage and pushes it to the status bar; a null reading clears the line.
 * Best-effort and silent — never surfaces an error to the user.
 */
async function refreshUsage(): Promise<void> {
  const usage = await currentUsage();
  statusBar.setUsage(usage);
}

// --- always-on model line (TreeView header row 1) ----------------------------
//
// The TreeView header's first row shows the effective model / tier / reasoning at
// all times ("Model: … (PAID) · reasoning: xhigh"), independent of the session
// token line below it. It is driven by `refreshModelLine()`, which reads the last
// /health capabilities (when the bridge is up) or the current settings (before the
// first scan / after a restart), so it tracks settings changes, mode switches and
// bridge restarts through the existing refresh paths.

/**
 * Record the effective /health capabilities and reflect them everywhere: the status
 * bar tooltip, the module mirror (for later model-line rebuilds), and the always-on
 * TreeView model line. Pass undefined when the bridge is stopped / restarting, which
 * falls the model line back to the configured settings.
 */
function applyCapabilities(caps: HealthCapabilities | undefined): void {
  lastCapabilities = caps;
  statusBar.setCapabilities(caps);
  refreshModelLine();
}

/**
 * Rebuild the always-on model line from the last /health capabilities (or, when the
 * bridge has not reported, the configured model / reasoning settings) and push it to
 * the TreeView header. The FREE/PAID tag also reflects the current free-model
 * construction (`bridge.onFreeModel`). Safe to call any time the effective model,
 * reasoning, or mode could have changed.
 */
function refreshModelLine(): void {
  const cfg = vscode.workspace.getConfiguration('crepair');
  const mode = readModelMode();
  tree.setModelLine(
    modelLineText({
      caps: lastCapabilities,
      mode,
      configuredModel: cfg.get<string>('model', DEFAULT_OVERRIDES.model),
      freeModel: readFreeModel(),
      configuredReasoning: cfg.get<string>('reasoningEffort', DEFAULT_OVERRIDES.reasoningEffort),
      // FREE tag when the mode is free OR the creditless auto-fallback is active.
      onFreeModel: mode === 'free' || (bridge?.onFreeModel ?? false),
    }),
  );
}

/**
 * View Model Providers (crepair.openModelProviders): open the OpenRouter model page
 * for the current effective model (crepair.model, or the verified default when
 * blank) in the external browser. The page lists every provider serving that model.
 * The model id maps directly onto the OpenRouter path (the `:free` variant marker is
 * kept verbatim — verified against openrouter.ai).
 */
async function openModelProviders(): Promise<void> {
  const configuredModel = vscode.workspace
    .getConfiguration('crepair')
    .get<string>('model', DEFAULT_OVERRIDES.model);
  const url = modelProvidersUrl(configuredModel);
  logInfo(`Opening model providers page: ${url}`);
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

// --- session token/cost line (D-030) ----------------------------------------
//
// The bridge meters OpenRouter token usage (usage_tracker.py) and exposes it at
// GET /usage; POST /usage/reset zeroes it. On each scan start we reset the counters
// and sample the key-usage cost baseline, then — while any bridge operation is in
// flight (scan / auto-repair pipeline / manual generate / regenerate) — poll every
// ~5s and render the running total into the TreeView header (tree.setMessage):
//   "Session: 18.2k in / 5.1k out (reasoning 2.1k) · ≈$0.0134".
// The poll runs only during operations; when the count drops to zero we fetch one
// final value and pin it until the next scan resets it (D-030). A metering-query
// failure clears the line (tracker disabled -> no display).

const SESSION_USAGE_POLL_MS = 5000;

/** Count of in-flight bridge operations; the usage poll runs while this is > 0. */
let usageInFlightOps = 0;
/** The recurring poll timer, live only while operations are in flight. */
let usagePollTimer: NodeJS.Timeout | undefined;
/**
 * The key-usage cost reading (USD) captured at scan start, used as the baseline for
 * the session's approximate spend. null when cost display is off / unavailable.
 */
let sessionCostBaseline: number | null = null;
/** Whether a scan session is active (reset seen) — gates the cost segment. */
let sessionActive = false;

/**
 * Begin a fresh session (D-030): reset the bridge's token counters and capture the
 * cost baseline, then render the (zeroed) line immediately so the header appears as
 * soon as the scan starts. Best-effort — a failed reset just leaves the line absent.
 */
async function beginUsageSession(handle: BridgeHandle): Promise<void> {
  sessionActive = true;
  sessionCostBaseline = await currentUsage();
  try {
    const usage = await handle.client.resetUsage();
    renderSessionUsage(usage);
  } catch {
    // The bridge is too old to meter (no /usage) or the reset failed: show nothing.
    tree.setMessage(undefined);
  }
}

/**
 * Render the session line from a usage reading + the current cost delta. A null
 * usage clears the header (metering unavailable). The cost segment is appended only
 * for an active session with a resolvable spend delta (baseline + current reading).
 */
function renderSessionUsage(usage: SessionUsage | null, costUsd?: number | null): void {
  tree.setMessage(sessionUsageMessage(usage, costUsd));
}

/**
 * Read GET /usage and the current cost delta, then render the session line (D-030).
 * Best-effort: a failed /usage read clears the header rather than throwing.
 */
async function pollSessionUsageOnce(): Promise<void> {
  if (!sessionActive) return;
  let usage: SessionUsage | null = null;
  try {
    const handle = await bridge.ensureStarted();
    usage = await handle.client.getUsage();
  } catch {
    usage = null;
  }
  const cost = await sessionCostDelta();
  renderSessionUsage(usage, cost);
}

/**
 * The approximate USD spent this session so far: current key usage − baseline.
 * null when either reading is unavailable (cost display off / query failed) or the
 * delta would be negative (a stale read) — the line then shows tokens only.
 */
async function sessionCostDelta(): Promise<number | null> {
  if (!sessionActive) return null;
  const after = await currentUsage();
  return usageDelta(sessionCostBaseline, after);
}

/** Start the recurring poll if it is not already running and a session is active. */
function startUsagePoll(): void {
  if (usagePollTimer || !shouldPollUsage(usageInFlightOps)) return;
  usagePollTimer = setInterval(() => {
    void pollSessionUsageOnce();
  }, SESSION_USAGE_POLL_MS);
}

/** Stop the recurring poll (idle: the last rendered value stays pinned). */
function stopUsagePoll(): void {
  if (usagePollTimer) {
    clearInterval(usagePollTimer);
    usagePollTimer = undefined;
  }
}

/**
 * Wrap an in-flight bridge operation so the session token line polls during it
 * (D-030). Increments the operation count (starting the poll on the first), and on
 * completion decrements it; when the count reaches zero the poll stops after a final
 * reading is taken so the pinned value is current. Any operation that calls the
 * bridge (scan / repair / regenerate / the pipeline) runs inside this.
 */
async function withUsageTracking<T>(fn: () => PromiseLike<T>): Promise<T> {
  usageInFlightOps += 1;
  startUsagePoll();
  try {
    return await fn();
  } finally {
    usageInFlightOps -= 1;
    if (usageInFlightOps <= 0) {
      usageInFlightOps = 0;
      stopUsagePoll();
      // Final reading so the pinned line reflects the completed operation.
      await pollSessionUsageOnce();
    }
  }
}

// --- auto-repair pipeline + review queue (D-024) ----------------------------

/**
 * Bridge a VS Code progress `CancellationToken` to a DOM `AbortController` so a
 * user cancel on the progress notification aborts the in-flight bridge fetch. The
 * fetch abort disconnects from the bridge, which (task A) stops the bridge-side LLM
 * call — so cancelling the UI actually halts generation and billing, not just the
 * spinner. Returns the controller; callers pass `controller.signal` to the bridge
 * call. The listener is disposed when the token is a one-shot progress token (its
 * scope ends with the withProgress callback).
 */
function abortControllerForToken(token: vscode.CancellationToken): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller;
}

/** Read `crepair.autoRepairLimit` (default 5, floored at 0). */
function readAutoRepairLimit(): number {
  const n = vscode.workspace.getConfiguration('crepair').get<number>('autoRepairLimit', 5);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}

/**
 * Kick off the auto-repair pipeline against the session the just-finished scan
 * installed (module `session`). A no-op when no session exists. Called by every
 * scan-complete path after `notifyScanComplete`.
 */
async function runAutoRepairPipelineForActiveSession(): Promise<void> {
  const active = session;
  if (!active) return;
  await runAutoRepairPipeline(active);
}

/**
 * D-024/D-025 pipeline: after a Scan & Fix completes, auto-generate repairs for the
 * violation findings (in start_line order), open the first diffable candidate's diff
 * as soon as it is ready, and let the review queue advance from there. Only reached
 * from the "Scan & Fix Current File" command (plain Scan never calls this).
 *
 * - violation count > `crepair.autoRepairLimit` -> a QuickPick confirm decides
 *   whether to generate all, the first <limit>, or cancel (cost guard).
 * - generation is sequential; a failed generation (repair_failed etc.) is kept in
 *   the tree but does not stop the pipeline; a diff-less candidate is not opened.
 * - the run is cancellable (withProgress); cancelling stops further generation but
 *   keeps what was already generated.
 * - a stale-out (D-006) during the run aborts the pipeline immediately.
 * - D-025: the OpenRouter usage is sampled before and after the run so the
 *   review-complete notice can show the approximate spend of this run.
 *
 * Runs against the session installed by the just-finished scan; a re-scan that
 * replaces the session mid-run is detected and aborts the pipeline.
 */
async function runAutoRepairPipeline(active: ScanSession): Promise<void> {
  if (session !== active) return; // a newer scan replaced this session already

  const targets = violationTargetsInOrder(active.scanResult);
  const plan = planAutoRepair(true, targets.length, readAutoRepairLimit());
  if (plan.kind === 'none') {
    // No violations to repair: still refresh the tooltip usage before returning.
    await refreshUsage();
    return;
  }

  let toGenerate: QueueTarget[] = targets;
  if (plan.kind === 'confirm') {
    // A QuickPick, not a modal (modals make Windows chime, D-028). Esc / focus-loss
    // = Cancel -> leaves everything to the manual path. `readAutoRepairLimit` clamps
    // to >= 1, so "Generate first K" is always a proper subset here.
    const choice = await vscode.window.showQuickPick(
      [
        {
          id: 'all',
          label: `$(run-all) Generate all ${plan.count}`,
          detail: `Generate repairs for every one of the ${plan.count} violations.`,
        },
        {
          id: 'first',
          label: `$(list-ordered) Generate first ${plan.limit} only`,
          detail: `Stop after the first ${plan.limit} (cost guard: crepair.autoRepairLimit).`,
        },
        {
          id: 'cancel',
          label: '$(close) Cancel',
          detail: 'Generate nothing now; repairs stay available from the tree.',
        },
      ] as (vscode.QuickPickItem & { id: string })[],
      {
        title: 'C Repair: Generate repairs',
        placeHolder: `${plan.count} violations found. Generate ${plan.count} repairs now?`,
      },
    );
    if (choice?.id === 'all') toGenerate = targets;
    else if (choice?.id === 'first') toGenerate = targets.slice(0, plan.limit);
    else return; // Cancel / dismissed: leave everything to the manual path.
  }

  // The session may already carry candidates for some findings (a manual generate
  // before the pipeline, or a rescan reusing ids); skip those — they are already in
  // the tree and (if diffable) the queue.
  const pending = toGenerate.filter(
    (t) => active.candidateForFinding(t.finding.finding_id) === undefined,
  );
  if (pending.length === 0) {
    // Nothing new to generate, but existing candidates may still form a queue.
    maybeOpenFirstDiff(active);
    return;
  }

  // D-025: sample the OpenRouter spend before generation so the review-complete
  // notice (advanceQueueAfter) can report the approximate cost of this run. A null
  // reading (cost display off / query failed) just omits the figure later.
  pipelineUsage = { session: active, before: await currentUsage() };

  let firstDiffOpened = false;
  // D-030: poll session usage while the repair pipeline runs; the tokens generated
  // here accrue to the same session started by the scan.
  await withUsageTracking(() =>
   vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'C Repair: generating repairs',
      cancellable: true,
    },
    async (progress, token) => {
      // A user cancel on this progress aborts the in-flight repair fetch, which
      // disconnects from the bridge and stops the bridge-side LLM call (task A).
      const abort = abortControllerForToken(token);
      const total = pending.length;
      for (let i = 0; i < total; i += 1) {
        if (token.isCancellationRequested) break;
        if (session !== active || active.stale) break; // rescan / stale-out (D-006)
        const t = pending[i];
        progress.report({ message: `Generating repairs (${i + 1}/${total})…` });
        try {
          const handle = await bridge.ensureStarted();
          const compileIncludePaths = buildCompileIncludePaths(
            readIncludePathSettings(),
            active.snapshot.fileDir,
          );
          const candidate = await handle.client.repair(
            active.source,
            active.confirmedSet,
            t.fn.function_id,
            t.finding,
            compileIncludePaths,
            abort.signal,
          );
          if (session !== active) break; // session replaced while awaiting
          active.setCandidate(candidate);
          validationLens.refresh();
          tree.refresh();
          logInfo(
            `Auto-repair generated: candidate=${candidate.candidate_id}, ` +
              `status=${candidate.status}, hunks=${candidate.hunks.length}.`,
          );
        } catch (err) {
          // A user cancel stops the whole pipeline cleanly (no error toast).
          if (isCancellation(err) || token.isCancellationRequested) {
            logInfo('Auto-repair pipeline cancelled by user.');
            break;
          }
          // A failed generation is kept as guidance but must not abort the pipeline.
          logError(
            `Auto-repair generation failed for ${t.fn.name}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        // Open the first diffable candidate's diff as soon as one is ready
        // (incremental — do not wait for the whole run).
        if (!firstDiffOpened && session === active && !active.stale) {
          firstDiffOpened = await maybeOpenFirstDiff(active);
        }
      }
    },
   ),
  );

  // A candidate may have completed on the final iteration without a diff open yet
  // (e.g. only the last one was diffable); present the queue ONCE. Guard on
  // `firstDiffOpened` so we never re-open after the user has navigated away from an
  // already-opened diff (activeDiffCandidateId is undefined then, which would
  // otherwise steal focus back to the diff).
  if (!firstDiffOpened && session === active && !active.stale) {
    await maybeOpenFirstDiff(active);
  }
}

/**
 * Open the first pending diffable candidate's diff for `active` if one exists and
 * a crepair diff is not already showing. Returns true when a diff is (now) open for
 * the queue. Idempotent: safe to call repeatedly as candidates complete.
 */
async function maybeOpenFirstDiff(active: ScanSession): Promise<boolean> {
  if (session !== active) return false;
  // If a crepair diff is already active, the queue is being reviewed — leave it.
  if (activeDiffCandidateId() !== undefined) return true;
  const queue = diffableQueue(
    violationTargetsInOrder(active.scanResult),
    (id) => active.candidateForFinding(id),
  );
  const first = firstPendingDiffable(queue, (id) => active.decisionFor(id) === 'pending');
  if (!first) return false;
  await openCandidateDiff(first.candidate_id);
  return true;
}

/**
 * Open (or re-open) the diff for a candidate id. Resolves the DiffSource off the
 * live session (diffSourceFor), so callers must invoke it only while `session` is
 * the intended one.
 */
async function openCandidateDiff(candidateId: string): Promise<void> {
  const src = diffSourceFor(candidateId);
  if (!src) return;
  // D-014 (V1 definition): displaying the candidate's diff marks it reviewed.
  session?.markReviewed(candidateId);
  await showCandidateDiff(src);
}

/**
 * B (429 handling): when the bridge is running the free model and a bridge call
 * fails with a rate-limit (429 — the shared free pool is busy), append a hint that
 * the user can wait or add credits to use the default model. Returns the (possibly
 * augmented) message; a no-op when not on the free model or the error is not a 429.
 * No automatic retry — certfix's own retry owns that.
 */
// --- bridge bootstrap (V3a, D-036) -------------------------------------------

/** Run `cmd` capturing output; never rejects (spawn errors -> code 127). */
function execCapture(
  cmd: string,
  args: string[],
  opts?: { shell?: boolean },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: opts?.shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}\n${e.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Consent prompt for running uv's OFFICIAL installer (D-036: consent-gated; a
 * QuickPick, not a modal — modals chime on Windows, D-028). Declining points at
 * the manual instructions (the caller's error also links them).
 */
async function confirmInstallUvPick(): Promise<boolean> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Install uv', description: "Runs uv's official installer (astral.sh)" },
      { label: 'Cancel', description: `Manual instructions: ${UV_MANUAL_INSTALL_URL}` },
    ],
    {
      title: 'C Repair needs uv to set up the bridge',
      placeHolder: 'uv was not found on this system. Install it now?',
      ignoreFocusOut: true,
    },
  );
  return pick?.label === 'Install uv';
}

/** The production BootstrapDeps (unit tests fake these — see bootstrap.ts). */
function bootstrapDeps(progress: vscode.Progress<{ message?: string }>): BootstrapDeps {
  return {
    exec: execCapture,
    exists: (p) => fs.existsSync(p),
    listWheels: (dir) => {
      try {
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.whl'))
          .sort()
          .map((f) => pathJoin(dir, f));
      } catch {
        return []; // absent dir = no wheels (the stage error explains it)
      }
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    fileSha256: (p) => {
      try {
        return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      } catch {
        return undefined;
      }
    },
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    platform: process.platform,
    homeDir: os.homedir(),
    confirmInstallUv: confirmInstallUvPick,
    report: (message) => progress.report({ message }),
  };
}

/**
 * `C Repair: Set Up Bridge` (V3a): provision the bridge venv under
 * globalStorage from the bundled wheels (design §1-2), then start the bridge
 * through the NORMAL resolution + handshake — which re-applies the existing
 * contract/harness pin checks to the provisioned environment (D-036 pin
 * reuse). In a monorepo dev workspace the repo .venv outranks the provisioned
 * venv (resolution ② > ③), so the verification exercises whichever python an
 * actual scan would use.
 */
async function setUpBridge(): Promise<void> {
  const ctx = extensionContext;
  if (!ctx) return;
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'C Repair: setting up the bridge',
        cancellable: false,
      },
      async (progress) => {
        const { venvPython } = await runBootstrap(bootstrapDeps(progress), {
          globalStorageDir: ctx.globalStorageUri.fsPath,
          extensionDir: ctx.extensionUri.fsPath,
        });
        progress.report({ message: 'starting the bridge and verifying /health…' });
        bridge.kill(); // respawn so resolution sees the newly provisioned venv
        const handle = await bridge.ensureStarted();
        return { venvPython, harness: handle.health.harness };
      },
    );
    statusBar.set('ready');
    void vscode.window.showInformationMessage(
      `C Repair: bridge is ready (harness ${result.harness.id} ${result.harness.version}).`,
    );
    logInfo(`Bootstrap complete: provisioned venv at ${result.venvPython}.`);
  } catch (err) {
    statusBar.set('error');
    if (err instanceof BootstrapError) {
      logError(`Bootstrap failed at stage ${err.stage}: ${err.message}`);
      if (err.stage === 'uv_missing' || err.stage === 'uv_install') {
        void vscode.window
          .showErrorMessage(`C Repair: ${err.message}`, 'Open uv install guide')
          .then((choice) => {
            if (choice) void vscode.env.openExternal(vscode.Uri.parse(UV_MANUAL_INSTALL_URL));
          });
      } else {
        void vscode.window.showErrorMessage(`C Repair: ${err.message}`);
      }
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    logError(`Bootstrap verification failed: ${message}`);
    void vscode.window.showErrorMessage(
      `C Repair: the bridge was provisioned but did not start — ${message}`,
    );
  }
}

function augmentFreePool429(message: string, err: unknown): string {
  if (!bridge.onFreeModel) return message;
  const is429 =
    (err instanceof BridgeHttpError && err.status === 429) || /\b429\b/.test(message);
  if (!is429) return message;
  return (
    `${message} — the free pool is busy. Wait a moment and retry, or add credits ` +
    `to switch to the ${DEFAULT_MODE_LABEL_LOWER} model.`
  );
}

function handleScanError(err: unknown): void {
  statusBar.set('error');
  if (err instanceof BridgeError) {
    logError(`Bridge error (${err.kind}): ${err.message}`);
    // V3a scan-origin affordance: an unconfigured bridge offers the one-click
    // bootstrap instead of a dead-end error.
    if (err.kind === 'not_configured') {
      void vscode.window
        .showErrorMessage(`C Repair: ${err.message}`, 'Set Up Bridge')
        .then((choice) => {
          if (choice === 'Set Up Bridge') void vscode.commands.executeCommand('crepair.setUpBridge');
        });
      return;
    }
    void vscode.window.showErrorMessage(`C Repair: ${augmentFreePool429(err.message, err)}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logError(`Scan failed: ${message}`);
  void vscode.window.showErrorMessage(`C Repair: scan failed — ${augmentFreePool429(message, err)}`);
}

// --- Context Review UX (V2b, design §3) -------------------------------------

/** Read `crepair.contextReview` (default `when-needed`). */
function readContextReviewMode(): ContextReviewMode {
  const v = vscode.workspace
    .getConfiguration('crepair')
    .get<string>('contextReview', 'when-needed');
  return v === 'always' || v === 'never' ? v : 'when-needed';
}

/**
 * Open the Review as a diff (D-021): left = the comment-stripped Original (read-only
 * `crepair` virtual doc — what the LLM sees), right = an editable untitled C buffer
 * holding the whole Augmented C (prelude declarations + the same stripped Original).
 * The inserted declaration block shows as an insertion at the top. Stash the pending
 * state, then present a notification with "Confirm & Scan" / "Skip review & Scan".
 * The notification is non-modal; the same actions are palette commands
 * (crepair.confirmContextAndScan / crepair.skipContextAndScan) in case it is
 * dismissed. This function returns immediately after opening — the scan runs when
 * the user picks an action.
 */
async function openContextReview(
  context: vscode.ExtensionContext,
  source: SourceDocument,
  draft: ContextAugmentationSet,
  targetUri: string,
  filename: string,
  content: string,
  fileDir: string | undefined,
  compileIncludePaths: string[],
  runFix: boolean,
): Promise<void> {
  const reviewId = source.content_hash; // stable per scanned content; unique enough
  const reviewDoc = await vscode.workspace.openTextDocument({
    language: 'c',
    content: buildReviewDoc(draft.items, content),
  });

  pendingReview = {
    reviewId,
    reviewDoc,
    source,
    draft,
    targetUri,
    filename,
    content,
    fileDir,
    compileIncludePaths,
    context,
    runFix,
  };

  // Show the side-by-side diff: read-only stripped Original (left) vs the editable
  // Augmented C (right). The right side is the untitled reviewDoc so the user edits
  // the declarations in place; the left is a crepair virtual doc keyed by reviewId.
  const left = reviewLeftUri(reviewId, filename);
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    reviewDoc.uri,
    `C Repair: Review inferred context — ${filename}`,
    { preview: false },
  );
  statusBar.set('ready');
  logInfo(`Context Review opened: ${draft.items.length} inferred item(s) awaiting confirm/skip.`);

  // Fire the notification WITHOUT awaiting it (scanCurrentFile returns now — the
  // scan resumes when the user picks an action). The buttons run the same commands
  // that are also palette-runnable if the notification is dismissed.
  void vscode.window
    .showInformationMessage(
      `C Repair inferred ${draft.items.length} external declaration${
        draft.items.length === 1 ? '' : 's'
      }. Review & edit them, then confirm.`,
      'Confirm & Scan',
      'Skip review & Scan',
    )
    .then((choice) => {
      if (choice === 'Confirm & Scan') void confirmContextAndScan();
      else if (choice === 'Skip review & Scan') void skipContextAndScan();
      // Dismissed: leave `pendingReview` set so the palette commands still work.
    });
}

/**
 * Confirm & Scan (design §3): parse the (edited) Review doc back onto the draft
 * items, mark them all confirmed, /context/confirm, /context/check, then scan —
 * offering a Continue / Edit choice when the context still does not compile.
 */
async function confirmContextAndScan(): Promise<void> {
  const p = pendingReview;
  if (!p) {
    void vscode.window.showInformationMessage('C Repair: no context review is pending.');
    return;
  }

  // Parse the current buffer. On a broken delimiter structure OR an edited code
  // section, keep the doc open and the pending state alive so the user can fix it
  // and re-run the command.
  const parsed = parseReviewDoc(p.reviewDoc.getText(), p.draft.items, p.content);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`C Repair: ${parsed.reason}`);
    return;
  }

  // All items are confirmed after a review (design §2 / §3).
  const reviewedSet: ContextAugmentationSet = {
    ...p.draft,
    items: parsed.items.map((it) => ({ ...it, confirmed: true })),
  };

  try {
    const handle = await ensureBridgeForScan();
    const confirmed = await handle.client.confirmContext(reviewedSet);

    // /context/check: does the confirmed context make the baseline compile?
    const check = await handle.client.checkContext(
      p.source,
      confirmed,
      p.compileIncludePaths,
    );
    // Residual completeness at scan time (Codex review round): 0 = complete,
    // >0 = the scan will run against a known-incomplete context. Carried into
    // the session + completion notification so the results are not mistaken
    // for a complete picture.
    const stillMissing = check.compiles ? 0 : check.missing_symbols.length;
    const msg = checkResultMessage(check);
    if (msg.blocking) {
      const choice = await vscode.window.showWarningMessage(
        msg.text,
        'Continue',
        'Edit context',
      );
      if (choice !== 'Continue') {
        // Edit context (or dismissed): keep the Review doc open for more editing.
        void vscode.window.showInformationMessage(
          'C Repair: edit the declarations, then run "Confirm Context & Scan" again.',
        );
        return;
      }
    } else {
      void vscode.window.showInformationMessage(msg.text);
    }

    // Cache the confirmed set and run the scan; then tear down the Review.
    const hash = p.source.content_hash;
    await setCachedContext(p.context.workspaceState, hash, confirmed);
    const doc = await findOpenDoc(p.targetUri);
    if (!doc) {
      void vscode.window.showErrorMessage(
        'C Repair: the scanned file is no longer open. Rescan to continue.',
      );
      return;
    }
    await closeReviewDoc(p.reviewDoc);
    pendingReview = undefined;

    // D-030: poll session usage over the (deferred) scan; the session was begun at
    // infer time, so this continues the same accumulation.
    const counts = await withUsageTracking(() =>
      runScanWithConfirmed(
        handle,
        doc,
        p.source,
        confirmed,
        p.filename,
        p.content,
        p.fileDir,
        p.compileIncludePaths,
        hash,
        stillMissing,
      ),
    );
    notifyScanComplete(counts, stillMissing);
    await afterScanComplete(p.runFix);
  } catch (err) {
    handleScanError(err);
  }
}

/**
 * Skip review & Scan (design §3): confirm the draft with items left unconfirmed
 * (confirmed=false), so findings/candidates render as assumption-dependent (§2).
 * No /context/check (the point of skipping is to not resolve the context).
 */
async function skipContextAndScan(): Promise<void> {
  const p = pendingReview;
  if (!p) {
    void vscode.window.showInformationMessage('C Repair: no context review is pending.');
    return;
  }
  try {
    const handle = await ensureBridgeForScan();
    const confirmed = await handle.client.confirmContext(p.draft);
    const hash = p.source.content_hash;
    await setCachedContext(p.context.workspaceState, hash, confirmed);
    const doc = await findOpenDoc(p.targetUri);
    if (!doc) {
      void vscode.window.showErrorMessage(
        'C Repair: the scanned file is no longer open. Rescan to continue.',
      );
      return;
    }
    await closeReviewDoc(p.reviewDoc);
    pendingReview = undefined;

    // D-030: poll session usage over the (deferred) scan (session begun at infer).
    const counts = await withUsageTracking(() =>
      runScanWithConfirmed(
        handle,
        doc,
        p.source,
        confirmed,
        p.filename,
        p.content,
        p.fileDir,
        p.compileIncludePaths,
        hash,
      ),
    );
    notifyScanComplete(counts);
    await afterScanComplete(p.runFix);
  } catch (err) {
    handleScanError(err);
  }
}

/**
 * Edit Context (design §3): evict the cached confirmed set for the active
 * session's source and re-run the scan, forcing a fresh infer + Review.
 */
async function editContext(context: vscode.ExtensionContext): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage('C Repair: scan a file first.');
    return;
  }
  await evictCachedContext(context.workspaceState, session.snapshot.contentHash);
  logInfo('Context cache evicted for the active source; re-inferring on rescan.');
  // Edit Context is about re-reviewing the inferred context, not re-fixing; re-run
  // as scan-only (D-025). The user can run Scan & Fix explicitly afterwards.
  await scanCurrentFile(context, false);
}

/**
 * Close the Review WITHOUT a save prompt. The Review is a diff whose right side is
 * the (now dirty) untitled Augmented C buffer; VS Code prompts on closing a dirty
 * untitled buffer, so we focus the diff, revert it (discarding the edits — they have
 * already been parsed into the confirmed set, clearing the dirty flag) then close
 * just that editor. `revertAndCloseActiveEditor` closes the whole diff editor.
 */
async function closeReviewDoc(reviewDoc: vscode.TextDocument): Promise<void> {
  try {
    // Focus the untitled right side (this activates its diff editor), revert to
    // clear the dirty flag (no save prompt), then close the active (diff) editor.
    await vscode.window.showTextDocument(reviewDoc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  } catch (err) {
    logInfo(`Could not close the Review document cleanly: ${(err as Error).message}`);
  }
}

// --- external-route notice (D-016) ------------------------------------------

async function confirmExternalRoute(context: vscode.ExtensionContext): Promise<boolean> {
  const enabled = vscode.workspace
    .getConfiguration('crepair')
    .get<boolean>('externalRouteNotice', true);
  if (!enabled) return true;
  // Once acknowledged in this workspace, don't ask again unless the user re-enables.
  if (context.globalState.get<boolean>(EXTERNAL_NOTICE_SHOWN_KEY)) return true;

  // Reflect the EFFECTIVE routing in the notice (D-016 / D-019 / D-031): the mode
  // selects the model + provider construction, so the wording follows modelMode /
  // providerPolicy / providerOrder — a ZDR-restricted routing is stated as such, and
  // a paying user sees an informational "here's where your code goes" confirmation
  // rather than a warning (sample15). The wording lives in a pure helper (testable).
  const cfg = vscode.workspace.getConfiguration('crepair');
  const notice = externalRouteText({
    mode: readModelMode(),
    model: cfg.get<string>('model', DEFAULT_OVERRIDES.model),
    freeModel: readFreeModel(),
    providerOrder: cfg.get<string[]>('providerOrder', DEFAULT_OVERRIDES.providerOrder) ?? [],
    providerPolicy: normalizeProviderPolicy(cfg.get<string>('providerPolicy')),
  });

  // A QuickPick, not a modal (modals make Windows chime, D-028). Esc / focus-loss
  // = Cancel -> the scan is aborted (returns false). The existing globalState /
  // setting wiring below is unchanged.
  //
  // Layout so NOTHING is truncated (sample15: a single overloaded placeholder was
  // cut off). The two information lines each get their own row: the where-line is
  // the QuickPick `title` and the data-handling line is the `placeHolder`, so each
  // is short enough to fit and neither competes for the same row. The item `detail`s
  // stay short one-liners describing each choice.
  const choice = await vscode.window.showQuickPick(
    [
      {
        id: 'continue',
        label: '$(cloud-upload) Continue',
        // The data-handling line rides on the actionable choices so the policy is
        // visible on the very item the user picks (and each row wraps, never cut).
        detail: notice.dataLine,
      },
      {
        id: 'dontask',
        label: "$(check) Continue and don't ask again",
        detail: `${notice.dataLine} Skip this notice in future scans.`,
      },
      {
        id: 'cancel',
        label: '$(close) Cancel',
        detail: 'Do not send anything; abort the scan.',
      },
    ] as (vscode.QuickPickItem & { id: string })[],
    {
      // Two rows, neither overloaded (sample15): the question is the compact `title`
      // heading; the where-line (provider + model) is the `placeHolder`. The
      // data-handling line rides on the Continue items' `detail` (which wraps).
      title: notice.title,
      placeHolder: notice.routeLine,
    },
  );
  if (choice?.id === 'continue') {
    // This-scan-only consent (the label promises exactly that): persist NOTHING,
    // so the notice returns on the next scan. Previously this also set the
    // acknowledged flag, making Continue behave like "don't ask again".
    return true;
  }
  if (choice?.id === 'dontask') {
    // Skip future scans via the globalState flag ONLY. Reset Extension State
    // clears it, so onboarding re-runs whole (user report, 2026-08-24: writing
    // crepair.externalRouteNotice=false here survived Reset — settings are
    // deliberately preserved — and the consent never came back). The setting
    // remains the user's explicit, reset-surviving off switch in Settings.
    await context.globalState.update(EXTERNAL_NOTICE_SHOWN_KEY, true);
    return true;
  }
  return false;
}

// --- BYOK -------------------------------------------------------------------

const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

/**
 * The env var whose presence swaps the real OAuth deps for a test double (D-027).
 * When set, `connectOpenRouter` uses the module-level `oauthTestDeps` seams instead
 * of the real browser / loopback server, so the @vscode/test-electron suite can
 * drive the Connect flow WITHOUT opening a browser or a socket. Production never
 * sets it, so the real flow always runs.
 */
const OAUTH_TEST_HOOK_ENV = 'CREPAIR_TEST_OAUTH';

/**
 * Injectable OAuth seams for the integration suite (D-027). Set by the test API
 * (activate's test surface) BEFORE invoking `crepair.connectOpenRouter` when the
 * hook env is present; every seam is a fake (no browser, no network). Unset in
 * production, where connectOpenRouter builds the real deps.
 */
let oauthTestDeps: OAuthDeps | undefined;

/**
 * Store a BYOK key in SecretStorage, restart the bridge so the next scan picks it
 * up, then verify it against OpenRouter (`fetchKeyUsage`) and surface the outcome:
 * "Connected ✓ (usage: $X.XX)" on success, or a "saved but could not verify"
 * warning on failure (the key is stored either way — verification is best-effort).
 * The key is never logged. Skips the live verify when attached to the offline test
 * bridge (CREPAIR_TEST_BRIDGE_URL) so the integration suite stays offline.
 */
async function storeAndVerifyKey(
  context: vscode.ExtensionContext,
  key: string,
  connectedLabel: string,
): Promise<void> {
  await context.secrets.store(API_KEY_SECRET, key);
  // Restart the bridge so the new key is used on the next scan.
  bridge.kill();
  logInfo('OpenRouter API key updated (stored in SecretStorage).');

  // Verify + show balance. Offline in tests: the usage endpoint is openrouter.ai
  // direct (not the fixture bridge), so skip it entirely under the test-bridge hook.
  if (process.env.CREPAIR_TEST_BRIDGE_URL) {
    void vscode.window.showInformationMessage(`C Repair: ${connectedLabel}.`);
    await refreshUsage();
    // D-031: this is a key-set confluence point (Connect / manual / env all reach
    // here) — offer the first-run model-mode choice before any billable scan.
    // Non-blocking by design: setting a key makes no LLM call, so a dismissal here
    // is harmless — the scan-start gate is the fail-closed enforcement point.
    await maybePromptModelMode(context);
    return;
  }
  const usage = await fetchKeyUsage(key);
  if (usage === null) {
    void vscode.window.showWarningMessage(
      `C Repair: key saved, but it could not be verified with OpenRouter right now. ` +
        `It will be used on the next scan.`,
    );
  } else {
    void vscode.window.showInformationMessage(
      `C Repair: ${connectedLabel} (usage: ${formatUsd(usage)}).`,
    );
  }
  await refreshUsage();
  // D-031: first-run model-mode choice at the key-set confluence (see above).
  // Non-blocking by design — the scan-start gate is the fail-closed enforcement point.
  await maybePromptModelMode(context);
}

/**
 * Connect OpenRouter (D-027, HEADLESS copy-paste flow): generate the PKCE
 * verifier/challenge, open the browser at OpenRouter's headless /auth page
 * (challenge + key_label, no callback_url) — after approval the page DISPLAYS
 * the authorization code — and prompt the user to paste it (InputBox with
 * ignoreFocusOut so switching to the browser never closes it). Then exchange
 * the code for a key and store + verify it. No callback transport at all, so
 * WSL / Remote / local behave identically. EVERY failure (cancel / browser /
 * expired or rejected code) offers Retry (which mints a FRESH code) AND the
 * manual-key fallback so the first-run path is never a dead end.
 */
async function connectOpenRouter(context: vscode.ExtensionContext): Promise<void> {
  const deps = oauthDeps();
  try {
    const key = await runOAuthFlow(deps);
    logInfo('OpenRouter OAuth flow completed; key minted (stored in SecretStorage).');
    await storeAndVerifyKey(context, key, 'Connected to OpenRouter ✓');
  } catch (err) {
    // OAuthError messages are already user-safe (no code / verifier / key).
    logError(
      `OpenRouter OAuth failed${err instanceof OAuthError ? ` (${(err as OAuthError).kind})` : ''}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    const { message, actions } = oauthFailureNotification(err);
    const choice = await vscode.window.showErrorMessage(message, ...actions);
    if (choice === RETRY_ACTION) {
      await connectOpenRouter(context);
    } else if (choice === MANUAL_KEY_ACTION) {
      await enterKeyManually(context);
    }
  }
}

/** Build the production OAuth deps (or the injected test doubles under the hook). */
function oauthDeps(): OAuthDeps {
  if (process.env[OAUTH_TEST_HOOK_ENV] && oauthTestDeps) return oauthTestDeps;
  return {
    fetch: globalThis.fetch as unknown as OAuthDeps['fetch'],
    openExternal: (url: string) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
    // The paste prompt survives the focus switch to the browser
    // (ignoreFocusOut) and rejects empty input inline (validateCodeInput).
    promptForCode: () =>
      Promise.resolve(
        vscode.window.showInputBox({
          title: 'Connect OpenRouter',
          prompt: CODE_PROMPT,
          placeHolder: CODE_PLACEHOLDER,
          ignoreFocusOut: true,
          validateInput: validateCodeInput,
        }),
      ),
  };
}

/**
 * Set OpenRouter API Key (D-027): present the connection choices — Connect with
 * browser (the recommended OAuth path), enter a key manually, or open
 * openrouter.ai/keys to get one — plus a "use $OPENROUTER_API_KEY" option when that
 * env var is present in the extension host (developer convenience).
 */
async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  const items: (vscode.QuickPickItem & { id: string })[] = [
    {
      id: 'connect',
      label: '$(link) Connect with browser (recommended)',
      detail: 'Sign in to OpenRouter and create a key automatically (OAuth).',
    },
    {
      id: 'manual',
      label: '$(key) Enter key manually',
      detail: 'Paste an existing OpenRouter API key.',
    },
    {
      id: 'get',
      label: '$(globe) Get a key',
      detail: 'Open openrouter.ai/keys in your browser.',
    },
  ];
  if (envKey) {
    items.push({
      id: 'env',
      label: '$(server-environment) Use $OPENROUTER_API_KEY',
      detail: 'Copy the key from this environment into secure storage.',
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: 'C Repair: Set OpenRouter API Key',
    placeHolder: 'How would you like to provide your OpenRouter API key?',
    ignoreFocusOut: true,
  });
  if (!pick) return; // dismissed

  switch (pick.id) {
    case 'connect':
      await connectOpenRouter(context);
      return;
    case 'get':
      await vscode.env.openExternal(vscode.Uri.parse(OPENROUTER_KEYS_URL));
      // Then go straight to manual entry so the user can paste what they created.
      await enterKeyManually(context);
      return;
    case 'env':
      if (envKey) await storeAndVerifyKey(context, envKey, 'Connected ✓');
      return;
    case 'manual':
    default:
      await enterKeyManually(context);
  }
}

/**
 * Prompt for an OpenRouter key, store it, then verify + show balance (D-027). The
 * key lives only in SecretStorage and is never logged.
 */
async function enterKeyManually(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'C Repair: Set OpenRouter API Key',
    prompt: 'Stored securely in VS Code SecretStorage. Never written to settings or logs.',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return; // cancelled
  const trimmed = key.trim();
  if (!trimmed) {
    void vscode.window.showInformationMessage('C Repair: no key entered.');
    return;
  }
  await storeAndVerifyKey(context, trimmed, 'Connected ✓');
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(API_KEY_SECRET);
  bridge.kill();
  statusBar.setUsage(null);
  void vscode.window.showInformationMessage('C Repair: OpenRouter API key cleared.');
  logInfo('OpenRouter API key cleared.');
}

// --- model-mode selection (D-031, trial-free guarantee) ----------------------

/**
 * The env var whose presence bypasses the model-mode QuickPick (D-031 test hook).
 * Used ONLY by the @vscode/test-electron integration suite so it can drive the
 * first-run selection without a real picker blocking the headless run. Its value
 * selects the simulated choice: 'free' / 'default' picks that mode; 'esc' (or
 * 'cancel') simulates dismissing the picker (no choice recorded). Any other value
 * (or unset in production) means the real QuickPick shows.
 */
const MODEL_MODE_HOOK_ENV = 'CREPAIR_TEST_MODEL_MODE';

/**
 * One-time legacy migration (D-031): older builds recorded a `free` model choice by
 * writing `crepair.model = crepair.freeModel` directly. Now that `crepair.modelMode`
 * is the single source of truth (and `crepair.model` is ignored outside `custom`
 * mode), such a user would silently fall back to the default model. When the mode is
 * still unset (`default`) and `crepair.model` equals `crepair.freeModel`, migrate to
 * `modelMode=free` and clear the stray `crepair.model`. Runs once at activation;
 * best-effort (a settings-write failure just leaves things as-is). One log line.
 */
async function migrateLegacyFreeModel(): Promise<void> {
  const mode = readModelMode();
  const model = readConfiguredModel();
  const freeModel = readFreeModel();
  if (!shouldMigrateLegacyFreeModel(mode, model, freeModel)) return;

  try {
    const cfg = vscode.workspace.getConfiguration();
    await cfg.update('crepair.modelMode', 'free', vscode.ConfigurationTarget.Global);
    await cfg.update('crepair.model', undefined, vscode.ConfigurationTarget.Global);
    logInfo('Migrated legacy free-model selection to crepair.modelMode=free (cleared crepair.model).');
    refreshModelLine();
  } catch (err) {
    logError(
      `Legacy free-model migration failed (leaving settings as-is): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * First-run model-mode gate (D-031): show the trial-free QuickPick once, unless the
 * user already chose a mode OR already set an explicit non-default `crepair.model`
 * (a prior deliberate choice we respect — the flag is then recorded silently so the
 * picker never appears). Called at every key-set confluence (storeAndVerifyKey) and
 * at scan start, so a credited key never starts a billable default-model scan before
 * the user has been asked once. Best-effort: never throws into the scan flow.
 *
 * Returns whether a model mode is SETTLED: true when the choice was already made
 * (or recorded from a prior explicit setting), or the picker was shown and a mode
 * was picked; false when the picker was dismissed (Esc / focus-loss — the flag
 * stays unrecorded so the gate asks again). The scan path MUST treat false as
 * fail-closed and abort (billing safety); the key-set confluence stays advisory
 * (no LLM call happens there — the scan gate is the enforcement point).
 */
async function maybePromptModelMode(context: vscode.ExtensionContext): Promise<boolean> {
  const chosen = context.globalState.get<boolean>(MODEL_MODE_CHOSEN_KEY) === true;
  const mode = readModelMode();
  const model = readConfiguredModel();

  // Already an explicit mode (free / custom) OR an explicit legacy model, and not yet
  // flagged: record the flag without prompting — the user has effectively already
  // chosen, so we respect it and skip the picker.
  if (shouldRecordWithoutPrompt(chosen, mode, model)) {
    await context.globalState.update(MODEL_MODE_CHOSEN_KEY, true);
    logInfo('Model-mode selection skipped: an explicit model mode / crepair.model is already set.');
    return true;
  }
  if (!shouldPromptModelMode(chosen, mode, model)) return true; // already chosen / explicit.

  return chooseModelMode(context, { reselect: false });
}

/**
 * Show the model-mode QuickPick and apply the choice (D-031). Shared by the first-run
 * gate (`reselect: false` — Esc leaves the flag unset so a later trigger re-prompts)
 * and the `Choose Model Mode` command (`reselect: true` — always shown on demand).
 * The command is a shortcut for the `crepair.modelMode` settings dropdown, which is
 * the primary way to switch modes; both write the SAME `crepair.modelMode` setting.
 *
 * The picker writes ONLY `crepair.modelMode` (the source of truth). It never touches
 * `crepair.model` / `crepair.providerOrder` — those are read only in `custom` mode:
 *
 * - Free    -> `crepair.modelMode = 'free'` (the free env is derived from the mode +
 *              `crepair.freeModel` at bridge spawn). One-line confirmation notice.
 * - Default -> `crepair.modelMode` reset to its default (the bundled model). One-line
 *              notice pointing at the status-bar session cost.
 * Either choice records the globalState flag so the picker is skipped thereafter.
 * Esc / focus-loss records nothing (the trial-free prompt returns at the next scan).
 *
 * Returns true when a mode was picked and applied; false when the picker was
 * dismissed. The first-run scan gate uses the false result to abort the scan
 * (fail-closed — see maybePromptModelMode).
 */
async function chooseModelMode(
  context: vscode.ExtensionContext,
  opts: { reselect: boolean },
): Promise<boolean> {
  const mode = await pickModelMode();
  if (!mode) {
    // Esc / dismissed: leave the flag unset (first-run gate re-prompts next time). On
    // the reselect command an explicit "no change" is fine — nothing to persist.
    if (!opts.reselect) logInfo('Model-mode selection deferred (dismissed).');
    return false;
  }

  // Apply the settings writes the choice implies (D-031): only crepair.modelMode. The
  // existing onConfigChanged handler offers a bridge restart when it changes; on the
  // first-run path the bridge is not yet running, so the next scan spawns it with the
  // new env — no explicit restart needed.
  const cfg = vscode.workspace.getConfiguration();
  for (const u of modelModeConfigUpdates(mode)) {
    await cfg.update(u.key, u.value, vscode.ConfigurationTarget.Global);
  }

  await context.globalState.update(MODEL_MODE_CHOSEN_KEY, true);
  // The mode line reflects the new mode immediately (health caps are now stale).
  applyCapabilities(undefined);

  if (mode === 'free') {
    void vscode.window.showInformationMessage(
      'C Repair: running with the free model. Switch anytime via ' +
        '"C Repair: Choose Model Mode".',
    );
    logInfo(`Model mode = free (crepair.modelMode set to free; free model ${readFreeModel()}).`);
  } else {
    void vscode.window.showInformationMessage(
      `C Repair: using the ${DEFAULT_MODE_LABEL_LOWER} model. Usage-based cost applies — ` +
        'see the status bar for session cost.',
    );
    logInfo('Model mode = default (crepair.modelMode reset to its default).');
  }
  return true;
}

/**
 * Present the two-way model-mode QuickPick (D-031) and resolve to the chosen mode,
 * or undefined on Esc / focus-loss. A QuickPick, not a modal, so Windows does not
 * chime (D-028). When the test hook env is set the picker is bypassed and the env
 * value decides the outcome (production behaviour is unchanged — the env is unset).
 */
async function pickModelMode(): Promise<ModelMode | undefined> {
  const hook = process.env[MODEL_MODE_HOOK_ENV];
  if (hook !== undefined) {
    if (hook === 'free' || hook === 'default') return hook;
    return undefined; // 'esc' / 'cancel' / anything else = dismissed
  }

  const freeModel = readFreeModel();
  const choice = await vscode.window.showQuickPick(
    [
      {
        id: 'free',
        label: '$(rocket) Try the free model first',
        detail: '$0 cost. Limited quality, shared rate limits. You can switch anytime.',
      },
      {
        id: 'default',
        label: `$(star) Use the ${DEFAULT_MODE_LABEL_LOWER} model`,
        detail:
          `The tested model of this release (currently ${DEFAULT_OVERRIDES.model}; ` +
          `may change in future releases). Usage-based cost — typically a few cents per file.`,
      },
    ] as (vscode.QuickPickItem & { id: ModelMode })[],
    {
      title: 'C Repair: choose a model mode',
      placeHolder:
        `Start with the free model (${freeModel}, $0) or the ` +
        `${DEFAULT_MODE_LABEL_LOWER} usage-based model?`,
    },
  );
  return choice?.id;
}

// --- Reset Extension State (onboarding re-run) -------------------------------

/**
 * Tear down the live in-memory scan state (session / tree / diagnostics / usage
 * displays). Shared by Reset Extension State; leaves persisted stores (secrets /
 * globalState / workspaceState) untouched — those are cleared by the caller.
 */
function clearLiveSessionState(): void {
  session = undefined;
  pendingReview = undefined;
  // Re-arm the once-per-session startup mismatch notice: Reset means "run
  // onboarding again", so session-scoped latches restart too (Codex reset
  // audit follow-up, 2026-08-24).
  startupConfigNoticeShown = false;
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = undefined;
  }
  tree.setSession(undefined);
  tree.setMessage(undefined);
  diagnostics.clear();
  statusBar.setUsage(null);
  applyCapabilities(undefined);
  statusBar.set('idle');
  validationLens.refresh();
}

/**
 * Reset Extension State: clear everything C Repair persists or holds in memory so
 * the user can re-run onboarding from scratch. After a confirm QuickPick this
 *   1. deletes the BYOK API key from SecretStorage,
 *   2. deletes every one-time-notice flag from globalState (RESET_GLOBAL_STATE_KEYS
 *      — external-route notice + free-model warning re-appear on the next scan),
 *   3. evicts the whole confirmed-context cache from workspaceState,
 *   4. clears the live ScanSession / TreeView / diagnostics / usage displays,
 *   5. kills the bridge (respawned on the next scan; the free-model construction
 *      resets too),
 * then shows a one-line completion notice. User settings (`crepair.*` in
 * settings.json) are intentionally NOT touched; when `externalRouteNotice` was
 * turned off, the notice reminds the user to re-enable it if they want the prompt.
 */
async function resetExtensionState(context: vscode.ExtensionContext): Promise<void> {
  if (!(await confirmReset())) return; // Cancel / dismissed.

  // 1) SecretStorage: the BYOK key.
  await context.secrets.delete(API_KEY_SECRET);
  // 2) globalState: every one-time-notice flag (single source of truth).
  for (const key of RESET_GLOBAL_STATE_KEYS) {
    await context.globalState.update(key, undefined);
  }
  // 3) workspaceState: the whole confirmed-context cache.
  await clearAllCachedContext(context.workspaceState);
  // 4) live in-memory state: session / tree / diagnostics / usage displays.
  clearLiveSessionState();
  // 5) bridge: kill so the next scan respawns it; also drop the free-model
  // construction so a reset key re-enters onboarding cleanly.
  bridge.setFreeModel(undefined); // resets the free construction (kills if it changed)
  bridge.kill();

  logInfo('Extension state reset (API key, notices, context cache, session cleared).');

  // Completion notice. When the external-route setting was turned off (the
  // "don't ask again" path disables it), the acknowledgement flag alone will not
  // bring the prompt back — advise the user to re-enable the setting if they want it.
  const externalNoticeEnabled = vscode.workspace
    .getConfiguration('crepair')
    .get<boolean>('externalRouteNotice', true);
  const settingHint = externalNoticeEnabled
    ? ''
    : ' Re-enable the External Route Notice setting if you want that prompt back.';
  void vscode.window.showInformationMessage(
    `C Repair: State cleared. Run a scan to start onboarding from scratch.${settingHint}`,
  );
}

/**
 * The env var whose presence bypasses the Reset Extension State confirm QuickPick.
 * Used ONLY by the @vscode/test-electron integration suite so it can drive the
 * reset without a real picker blocking the run. Its value selects the simulated
 * choice: 'cancel' (or 'reject') simulates dismissing the picker; anything else
 * (including 'reset') simulates "Reset". Production never sets it, so the real
 * QuickPick always shows.
 */
const RESET_CONFIRM_HOOK_ENV = 'CREPAIR_TEST_RESET_CONFIRM';

/**
 * Confirm the destructive Reset via a QuickPick (not a modal — modals chime on
 * Windows, D-028). Returns true only when the user chose "Reset". Esc / focus-loss
 * = Cancel. When the test hook env is set, the picker is bypassed and its value
 * decides the outcome (production behaviour is unchanged — the env is never set).
 */
async function confirmReset(): Promise<boolean> {
  const hook = process.env[RESET_CONFIRM_HOOK_ENV];
  if (hook !== undefined) return hook !== 'cancel' && hook !== 'reject';

  const choice = await vscode.window.showQuickPick(
    [
      {
        id: 'reset',
        label: '$(trash) Reset',
        detail:
          'Clear the API key, one-time notices, context cache and current session.',
      },
      { id: 'cancel', label: '$(close) Cancel', detail: 'Leave everything as it is.' },
    ] as (vscode.QuickPickItem & { id: string })[],
    {
      title: 'C Repair: Reset Extension State',
      placeHolder:
        'Reset C Repair state? This clears the API key, one-time notices, ' +
        'context cache and current session.',
    },
  );
  return choice?.id === 'reset';
}

// --- Generate Repair (V1b-2) ------------------------------------------------

async function generateRepair(node?: CRepairNode): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage('C Repair: scan a file first.');
    return;
  }
  if (node?.kind !== 'finding') return;
  const { finding, fn } = node;

  // Stale guard: refuse to generate against a changed document (VSCODE_V1B_DESIGN
  // §4). The bridge would repair against the snapshot, which no longer matches.
  if (session.stale) {
    void vscode.window.showWarningMessage(
      'C Repair: the file changed since the scan. Rescan before generating a repair.',
    );
    return;
  }
  if (finding.kind !== 'violation') {
    void vscode.window.showInformationMessage(
      'C Repair: repair is only available for violation findings.',
    );
    return;
  }
  if (session.candidateForFinding(finding.finding_id)) {
    // Already generated — just reveal / diff it instead of regenerating.
    void vscode.window.showInformationMessage(
      'C Repair: a repair candidate already exists for this finding.',
    );
    return;
  }

  const active = session; // capture for the async closure
  try {
    // D-030: poll session usage over this manual generate (accrues to the session).
    await withUsageTracking(() =>
     vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        // Task C: warn up front when the file is large enough that generation is
        // expected to take several minutes (display only — never blocks).
        title: repairProgressTitle(`C Repair: generating repair for ${fn.name}`, active),
        cancellable: true,
      },
      async (progress, token) => {
        // Task B/A: a cancel aborts the fetch -> bridge disconnect -> LLM stop.
        const abort = abortControllerForToken(token);
        progress.report({ message: 'starting bridge…' });
        const handle = await bridge.ensureStarted();
        progress.report({ message: 'generating repair (LLM + validation gates)…' });
        // Re-derive the compile `-I` paths from the session's file dir + settings
        // (D-020) so the baseline pre-check + candidate compile gate see the same
        // include paths the scan used.
        const compileIncludePaths = buildCompileIncludePaths(
          readIncludePathSettings(),
          active.snapshot.fileDir,
        );
        const candidate = await handle.client.repair(
          active.source,
          active.confirmedSet,
          fn.function_id,
          finding,
          compileIncludePaths,
          abort.signal,
        );
        // The session may have been replaced (re-scan) while awaiting; ignore.
        if (session !== active) return;
        active.setCandidate(candidate);
        validationLens.refresh();
        tree.refresh();
        logInfo(
          `Repair generated: candidate=${candidate.candidate_id}, ` +
            `status=${candidate.status}, hunks=${candidate.hunks.length}, ` +
            `validations=${candidate.validations.map((v) => `${v.name}:${v.status}`).join(',')}.`,
        );
      },
     ),
    );
  } catch (err) {
    handleRepairError(err);
  }
}

/**
 * The progress title for a repair, with the task-C "large file" heads-up appended
 * when the session's source is big enough that whole-file generation is expected to
 * take several minutes. Display-only: it never blocks or changes the repair.
 */
function repairProgressTitle(base: string, session: ScanSession): string {
  return isLargeRepair(session.snapshot.content.length)
    ? `${base} (large file — may take several minutes)`
    : base;
}

function handleRepairError(err: unknown): void {
  // A user cancel is not a failure: show a quiet "Cancelled." (task B) and stop.
  // The fetch abort already disconnected the bridge, halting the LLM call (task A).
  if (isCancellation(err)) {
    logInfo('Repair cancelled by user.');
    void vscode.window.showInformationMessage('C Repair: Cancelled.');
    return;
  }
  if (err instanceof BridgeError) {
    logError(`Bridge error (${err.kind}): ${err.message}`);
    void vscode.window.showErrorMessage(`C Repair: ${augmentFreePool429(err.message, err)}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logError(`Generate repair failed: ${message}`);
  void vscode.window.showErrorMessage(
    `C Repair: repair generation failed — ${augmentFreePool429(message, err)}`,
  );
}

/**
 * Regenerate the repair for a finding (D-023): re-run /repair for the same finding
 * and REPLACE the existing candidate + its decision. LLM detection/generation vary
 * run-to-run, so a fresh candidate can differ; the old candidate_id / decision /
 * over-warning flag are dropped (replaceCandidateForFinding) so nothing stale
 * carries over. Refused while stale (same guard as generateRepair — the bridge
 * would repair against a snapshot that no longer matches the document).
 *
 * Invoked from a finding node (with a candidate) OR a candidate node; both resolve
 * to the same `{fn, finding}`.
 */
async function regenerateRepair(node?: CRepairNode): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage('C Repair: scan a file first.');
    return;
  }
  // Resolve the target {fn, finding} from either a finding node or a candidate node.
  const resolved = resolveFindingForRegenerate(node);
  if (!resolved) return;
  const { fn, finding } = resolved;

  if (session.stale) {
    void vscode.window.showWarningMessage(
      'C Repair: the file changed since the scan. Rescan before regenerating a repair.',
    );
    return;
  }
  if (finding.kind !== 'violation') {
    void vscode.window.showInformationMessage(
      'C Repair: repair is only available for violation findings.',
    );
    return;
  }

  const active = session;
  try {
    // D-030: poll session usage over this regenerate (accrues to the session).
    await withUsageTracking(() =>
     vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        // Task C: large-file heads-up; task B: cancellable.
        title: repairProgressTitle(`C Repair: regenerating repair for ${fn.name}`, active),
        cancellable: true,
      },
      async (progress, token) => {
        const abort = abortControllerForToken(token);
        progress.report({ message: 'starting bridge…' });
        const handle = await bridge.ensureStarted();
        progress.report({ message: 'regenerating repair (LLM + validation gates)…' });
        const compileIncludePaths = buildCompileIncludePaths(
          readIncludePathSettings(),
          active.snapshot.fileDir,
        );
        const candidate = await handle.client.repair(
          active.source,
          active.confirmedSet,
          fn.function_id,
          finding,
          compileIncludePaths,
          abort.signal,
        );
        if (session !== active) return; // session replaced (re-scan) while awaiting
        // Replace the prior candidate + decision for this finding (D-023).
        active.replaceCandidateForFinding(finding.finding_id, candidate);
        // The bridge may reuse the same candidate_id (derived from
        // function+finding+revision), so the diff virtual doc for this id must be
        // re-rendered — otherwise a re-opened diff would show the OLD proposed
        // hunks cached by the content provider (same fix as acceptCandidate).
        contentProvider.invalidate(candidate.candidate_id, active.snapshot.filename);
        // The replaced candidate carries new validations; refresh the right-pane lens
        // (same reason we invalidate the virtual doc: a re-opened diff for a reused
        // candidate_id would otherwise keep the prior lens).
        validationLens.refresh();
        tree.refresh();
        logInfo(
          `Repair regenerated: candidate=${candidate.candidate_id}, ` +
            `status=${candidate.status}, hunks=${candidate.hunks.length}, ` +
            `validations=${candidate.validations.map((v) => `${v.name}:${v.status}`).join(',')}.`,
        );
      },
     ),
    );
  } catch (err) {
    handleRepairError(err);
  }
}

/** Resolve the finding to regenerate from a finding node or a candidate node. */
function resolveFindingForRegenerate(
  node?: CRepairNode,
): { fn: ScanFunction; finding: Finding } | undefined {
  if (!session) return undefined;
  if (node?.kind === 'finding') return { fn: node.fn, finding: node.finding };
  if (node?.kind === 'candidate') {
    const findingId = node.candidate.finding_id;
    for (const fn of session.scanResult.functions) {
      const finding = fn.findings.find((f) => f.finding_id === findingId);
      if (finding) return { fn, finding };
    }
  }
  return undefined;
}

/**
 * Quick Fix entry point (V1c-UX task 8): generate a repair for a finding by id
 * (the CodeActionProvider passes the id from the diagnostic). Resolves the id to
 * the same `{fn, finding}` node the TreeView action uses, so both paths run the
 * identical generateRepair flow, then focuses the results view.
 */
async function generateRepairForFinding(findingId?: string): Promise<void> {
  if (!session || !findingId) return;
  for (const fn of session.scanResult.functions) {
    const finding = fn.findings.find((f) => f.finding_id === findingId);
    if (finding) {
      await generateRepair({ kind: 'finding', fn, finding });
      void vscode.commands.executeCommand('crepairResults.focus');
      return;
    }
  }
}

// --- Show validation detail (V1c-UX task 5) ---------------------------------

interface ValidationDetailArg {
  candidateId: string;
  name: string;
  status: string;
  detail: string;
}

/**
 * Dump a validation's full detail to the "C Repair" Output channel and reveal
 * it. The tree row's tooltip already carries the detail; this gives the user a
 * scrollable, copyable full-text view for long details (e.g. compiler stderr).
 */
function showValidationDetail(arg?: ValidationDetailArg): void {
  if (!arg) return;
  logBlock('');
  logBlock(`── validation detail: ${arg.name} [${arg.status}] (candidate ${arg.candidateId}) ──`);
  logBlock(arg.detail);
  logShow();
}

// --- Show Diff (V1b-2, VSCODE_V1B_DESIGN.md §5) -----------------------------

/**
 * Resolve a Context Review's left-side (read-only) content: the comment-stripped
 * Original the LLM sees (D-021). Matched by the pending review's id; undefined when
 * no review is pending or the id does not match, which renders as empty content.
 */
function reviewLeftContentFor(reviewId: string): string | undefined {
  if (!pendingReview || pendingReview.reviewId !== reviewId) return undefined;
  return stripCommentsPreserveLines(pendingReview.content);
}

/** Resolve a candidate id to the data the content provider renders. */
function diffSourceFor(candidateId: string): DiffSource | undefined {
  if (!session) return undefined;
  const candidate = session.candidateById(candidateId);
  if (!candidate) return undefined;
  return {
    snapshotContent: session.snapshot.content,
    candidate,
    ruleId: ruleIdForCandidate(candidate),
    filename: session.snapshot.filename,
  };
}

function ruleIdForCandidate(candidate: RepairCandidate): string | undefined {
  const finding = findingById(candidate.finding_id);
  return finding?.rule_id;
}

function findingById(findingId: string): Finding | undefined {
  if (!session) return undefined;
  for (const fn of session.scanResult.functions) {
    for (const f of fn.findings) {
      if (f.finding_id === findingId) return f;
    }
  }
  return undefined;
}

async function showDiff(node?: CRepairNode): Promise<void> {
  if (node?.kind !== 'candidate') return;
  const src = diffSourceFor(node.candidate.candidate_id);
  if (!src) {
    void vscode.window.showInformationMessage('C Repair: this candidate is no longer available.');
    return;
  }
  // D-014 (V1 definition): displaying the candidate's diff marks it reviewed.
  session?.markReviewed(node.candidate.candidate_id);
  await showCandidateDiff(src);
}

// --- Accept / Reject (V1b-2, VSCODE_V1B_DESIGN.md §5) ------------------------

async function acceptCandidate(node?: CRepairNode): Promise<void> {
  if (!session || node?.kind !== 'candidate') return;
  const active = session;
  const candidate = node.candidate;

  const doc = await findOpenDoc(active.snapshot.uri);
  if (!doc) {
    void vscode.window.showWarningMessage(
      'C Repair: open the scanned file in an editor before accepting a repair.',
    );
    return;
  }

  // Pure Accept guard (stale chain / validation / conflict — VSCODE_V1B_DESIGN §5,
  // D-023). A `warn: 'judgment'` result is acceptable but needs an explicit
  // confirmation (a judgment gate failed).
  const currentHash = contentHash(doc.getText());
  const guard = evaluateAcceptGuard(
    candidate,
    currentHash,
    active.expectedHash,
    active.acceptedCandidates(),
  );
  if (!guard.ok) {
    void vscode.window.showWarningMessage(`C Repair: ${guard.message}`);
    return;
  }

  // D-023: acceptWithWarning — a judgment gate (semantic / violation_removal /
  // regression) failed. Confirm with a QuickPick listing the concerns before
  // applying; the user is the final authority (D-013/D-014). The test hook bypasses
  // the picker. (A QuickPick, not a modal — modals make Windows chime, D-028.)
  const overWarning = 'warn' in guard && guard.warn === 'judgment';
  if (overWarning) {
    const concerns = guard.warn === 'judgment' ? guard.concerns : [];
    const confirmed = await confirmAcceptWarning(concerns, guard.message);
    if (!confirmed) return;
  }

  const { applied, removedIncludeCount } = await applyCandidate(
    doc,
    candidate,
    active.acceptedCandidates(),
  );
  if (!applied) {
    void vscode.window.showErrorMessage('C Repair: could not apply the repair to the document.');
    return;
  }
  // D-026: tell the user when duplicate #include lines were skipped so the omission
  // is visible (an already-present include is not inserted again). Non-modal.
  if (removedIncludeCount > 0) {
    const plural = removedIncludeCount === 1 ? '' : 's';
    void vscode.window.showInformationMessage(
      `C Repair: ${removedIncludeCount} duplicate #include line${plural} skipped.`,
    );
  }

  // Advance the expected-hash chain (D-006 chain version) so the next Accept
  // stale-checks against the now-edited document, not the pristine snapshot. The
  // decision is `accepted` either way; an over-warning accept also flags the
  // override so the tree shows `[accepted ⚠]` (D-023).
  if (overWarning) active.setAcceptedWithWarning(candidate.candidate_id);
  else active.setDecision(candidate.candidate_id, 'accepted');
  active.setExpectedHash(contentHash(doc.getText()));
  active.refreshStale(doc.getText()); // clear any transient stale from the edit

  // Remove the corresponding diagnostic (the finding is now addressed).
  refreshDiagnosticsExcludingAccepted(doc);
  contentProvider.invalidate(candidate.candidate_id, active.snapshot.filename);
  tree.refresh();
  statusBar.set('ready');
  logInfo(
    `Accepted candidate=${candidate.candidate_id}${overWarning ? ' (over judgment-gate warning)' : ''}; ` +
      `document updated (new expected hash recorded)` +
      `${removedIncludeCount > 0 ? `; ${removedIncludeCount} duplicate #include line(s) skipped` : ''}.`,
  );
}

/**
 * Accept all reviewed (V1c, D-014): apply every eligible (D-005) AND reviewed
 * pending candidate in candidate ID ascending order, reusing the single-accept
 * building blocks PER CANDIDATE — the shared guard (stale / conflict /
 * judgment), then `applyCandidate` (dedupeIncludes -> one `edit.set` batch ->
 * one WorkspaceEdit per candidate, the D-026 shape), then the decision + D-006
 * expected-hash chain advance. Sequential per-candidate application is what
 * keeps the run order-safe: each accept's guard and include-dedupe see the
 * REAL current document (already reflecting earlier accepts), exactly as a
 * human clicking Accept N times would get, and each accept stays one undo step.
 *
 * Skip semantics (D-014 — no confirmation dialogs, skip 方式):
 * - not reviewed -> skipped (open the diff first; that is what "reviewed" is);
 * - hunk conflict with an already-accepted candidate -> skipped;
 * - judgment-gate warnings -> skipped (accepting those requires the
 *   per-candidate D-023 confirmation, which a batch must not silently bypass);
 * - a stale document (external edit) aborts the run with the guard's message.
 * The result notification carries the per-reason tally.
 */
async function acceptAllReviewed(): Promise<void> {
  const active = session;
  if (!active) {
    void vscode.window.showInformationMessage('C Repair: no scan session — scan a file first.');
    return;
  }
  const doc = await findOpenDoc(active.snapshot.uri);
  if (!doc) {
    void vscode.window.showWarningMessage(
      'C Repair: open the scanned file in an editor before accepting repairs.',
    );
    return;
  }

  const queue = diffableQueue(violationTargetsInOrder(active.scanResult), (id) =>
    active.candidateForFinding(id),
  );
  const selection = selectAcceptAllReviewed(
    queue,
    (id) => active.decisionFor(id) === 'pending',
    (id) => active.wasReviewed(id),
  );
  if (selection.toAccept.length === 0) {
    const hint =
      selection.notReviewed.length > 0
        ? ` (${selection.notReviewed.length} pending candidate(s) have not been reviewed — open their diffs first)`
        : '';
    void vscode.window.showInformationMessage(`C Repair: nothing to accept${hint}.`);
    return;
  }

  const tally: AcceptAllTally = {
    accepted: 0,
    conflict: 0,
    notReviewed: selection.notReviewed.length,
    needsConfirmation: 0,
    failed: 0,
    dedupedIncludes: 0,
  };
  let staleMessage: string | undefined;

  for (const candidate of selection.toAccept) {
    const guard = evaluateAcceptGuard(
      candidate,
      contentHash(doc.getText()),
      active.expectedHash,
      active.acceptedCandidates(),
    );
    if (!guard.ok) {
      if (guard.reason === 'stale') {
        // External edit: nothing further can apply safely; stop the run.
        staleMessage = guard.message;
        break;
      }
      if (guard.reason === 'conflict') tally.conflict += 1;
      else tally.failed += 1; // not_acceptable should not occur post-selection
      continue;
    }
    if ('warn' in guard && guard.warn === 'judgment') {
      tally.needsConfirmation += 1;
      continue;
    }

    const { applied, removedIncludeCount } = await applyCandidate(
      doc,
      candidate,
      active.acceptedCandidates(),
    );
    if (!applied) {
      tally.failed += 1;
      continue;
    }
    tally.dedupedIncludes += removedIncludeCount;
    active.setDecision(candidate.candidate_id, 'accepted');
    active.setExpectedHash(contentHash(doc.getText()));
    active.refreshStale(doc.getText());
    contentProvider.invalidate(candidate.candidate_id, active.snapshot.filename);
    tally.accepted += 1;
  }

  refreshDiagnosticsExcludingAccepted(doc);
  tree.refresh();
  statusBar.set('ready');
  const summary = acceptAllSummary(tally);
  if (staleMessage) {
    void vscode.window.showWarningMessage(
      `C Repair: Accept all reviewed stopped — ${staleMessage} (${summary})`,
    );
  } else {
    void vscode.window.showInformationMessage(`C Repair: Accept all reviewed — ${summary}.`);
  }
  logInfo(`Accept all reviewed: ${summary}${staleMessage ? ` (stopped: ${staleMessage})` : ''}.`);
}

/** The capitalized model-mode display label for the report (D-038: `default` -> "Preset"). */
function modelModeReportLabel(mode: ModelMode): string {
  if (mode === 'default') return DEFAULT_MODE_LABEL; // "Preset"
  return mode === 'free' ? 'Free' : 'Custom';
}

/**
 * The confirmed-context provenance breakdown for the report scope section (§2):
 * count the confirmed items by provenance. Only confirmed items are counted (a
 * draft item was not part of the scanned context). Deterministic order by first
 * appearance.
 */
function contextProvenanceCounts(set: ContextAugmentationSet): ProvenanceCount[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const item of set.items) {
    if (!item.confirmed) continue;
    const key = item.provenance;
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.map((provenance) => ({ provenance, count: counts.get(provenance) ?? 0 }));
}

/**
 * Export Repair Report (user-approved, Codex-reviewed): assemble a Markdown review
 * report from the current ScanSession and open it as an untitled markdown document
 * (never auto-saved to disk). Requires a scan; otherwise prompts to scan first.
 *
 * The report's value is the CHAIN rule -> location -> accepted fix -> gate
 * evidence/override -> hunk -> result hash (§1-§6), NOT the diff itself. Identity /
 * integrity comes from the scan result (harness / adapter / rule profile), the
 * D-006 expected-hash chain (applied-result hash), and the effective model
 * identity (health caps, else the first candidate's model_identity). The heavy
 * lifting is the pure builder (session/repairReport.ts); this is the thin adapter.
 */
async function exportRepairReport(context: vscode.ExtensionContext): Promise<void> {
  const active = session;
  if (!active) {
    void vscode.window.showInformationMessage('C Repair: no scan session — scan a file first.');
    return;
  }

  const scan = active.scanResult;
  // Effective model: /health caps when the bridge has reported, else the first
  // candidate's model_identity (candidates carry the effective model), else undefined.
  const modelFromHealth = lastCapabilities ? effectiveModelLabel(lastCapabilities) : undefined;
  const modelFromCandidate = active
    .candidates()
    .map((c) => c.model_identity)
    .find((m): m is string => !!m && m.trim().length > 0);
  const model =
    modelFromHealth && modelFromHealth !== 'unknown' ? modelFromHealth : modelFromCandidate;

  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version ?? 'unknown';

  const input: RepairReportInput = {
    generatedAtIso: new Date().toISOString(),
    filename: active.snapshot.filename,
    originalHash: active.snapshot.contentHash,
    expectedHash: active.expectedHash,
    extensionVersion,
    ruleProfile: scan.rule_profile,
    // Bundled catalog size from the last /health handshake (capabilities.rules_count);
    // undefined before the bridge reports -> the Rule set line omits the count.
    ruleCount: lastCapabilities?.rules_count,
    model: { model, mode: modelModeReportLabel(readModelMode()) },
    scan,
    contextStillMissing: active.contextStillMissing,
    contextProvenance: contextProvenanceCounts(active.confirmedSet),
    candidateForFinding: (id) => active.candidateForFinding(id),
    dispositionForCandidate: (id) => active.dispositionFor(id),
    // Opt-in rejected-reference diffs (§5 tail). Default false = lean decision record.
    includeRejectedProposals: vscode.workspace
      .getConfiguration('crepair')
      .get<boolean>('report.includeRejectedProposals', false),
  };

  const markdown = buildRepairReport(input, active.snapshot.content);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(doc, { preview: false });
  logInfo(`Exported repair report for ${active.snapshot.filename} (untitled markdown document).`);
}

/**
 * Export Feedback Data (JSON) (feature B, Codex ruling: structured signal, else the
 * reject-reason picker is a UI ritual). Assemble a versioned, SOURCE-FREE JSON
 * object from the current ScanSession and open it as an untitled JSON document
 * (never auto-saved, NEVER sent over the network). The heavy lifting is the pure
 * builder (session/feedbackData.ts, source-free by construction + guarded by test);
 * this is the thin adapter. Requires a scan; otherwise prompts to scan first.
 */
async function exportFeedbackData(context: vscode.ExtensionContext): Promise<void> {
  const active = session;
  if (!active) {
    void vscode.window.showInformationMessage('C Repair: no scan session — scan a file first.');
    return;
  }

  const scan = active.scanResult;
  // Same effective-model resolution as the repair report: /health caps, else the
  // first candidate's model_identity, else undefined.
  const modelFromHealth = lastCapabilities ? effectiveModelLabel(lastCapabilities) : undefined;
  const modelFromCandidate = active
    .candidates()
    .map((c) => c.model_identity)
    .find((m): m is string => !!m && m.trim().length > 0);
  const model =
    modelFromHealth && modelFromHealth !== 'unknown' ? modelFromHealth : modelFromCandidate;
  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version ?? 'unknown';

  const input: FeedbackDataInput = {
    generatedAtIso: new Date().toISOString(),
    filename: active.snapshot.filename, // already a basename (fileBasename at scan time)
    originalHash: active.snapshot.contentHash,
    extensionVersion,
    ruleProfile: scan.rule_profile,
    model,
    mode: modelModeReportLabel(readModelMode()),
    scan,
    candidateForFinding: (id) => active.candidateForFinding(id),
    dispositionForCandidate: (id) => active.dispositionFor(id),
  };

  const json = JSON.stringify(buildFeedbackData(input), null, 2);
  const doc = await vscode.workspace.openTextDocument({ language: 'json', content: json });
  await vscode.window.showTextDocument(doc, { preview: false });
  logInfo(`Exported feedback data for ${active.snapshot.filename} (untitled JSON document).`);
}

/**
 * The env var whose presence bypasses the acceptWithWarning QuickPick (D-023 test
 * hook). Used ONLY by the @vscode/test-electron integration suite so it can drive
 * the over-warning Accept without a real picker blocking the run. Its value selects
 * the simulated choice: 'cancel' (or 'reject') simulates dismissing the picker;
 * anything else (including 'apply') simulates "Apply Anyway". Production never sets
 * it, so the real QuickPick always shows.
 */
const ACCEPT_WARNING_HOOK_ENV = 'CREPAIR_TEST_ACCEPT_WARNING';

/**
 * Confirm an acceptWithWarning Accept (D-023). Shows a QuickPick listing the
 * failing judgment gates (as non-selectable rows) plus "Accept as a starting point" /
 * "Cancel"; returns true only when the user chose to accept. Esc / focus-loss =
 * Cancel. A QuickPick, not a modal, so Windows does not chime (D-028). The full
 * concern text is logged to the Output channel (rows are truncated for readability).
 *
 * When the test hook env is set, the picker is bypassed and the env value decides
 * the outcome (production behaviour is unchanged — the env is never set there).
 */
async function confirmAcceptWarning(concerns: Validation[], message: string): Promise<boolean> {
  const hook = process.env[ACCEPT_WARNING_HOOK_ENV];
  if (hook !== undefined) {
    // Test hook: 'cancel'/'reject' => not confirmed; otherwise treat as Accept.
    return hook !== 'cancel' && hook !== 'reject';
  }
  // Log the full (untruncated) concern list so the Output channel always has the
  // complete rationale even when a QuickPick row is truncated.
  logBlock(message);

  type Item = AcceptWarningPickItem & vscode.QuickPickItem;
  const items: Item[] = acceptWarningPickItems(concerns).map((it) => ({
    ...it,
    // Concern rows are informational only; keep them visible while un-actionable.
    ...(it.action === 'concern' ? { alwaysShow: true } : {}),
  }));
  const pick = await new Promise<Item | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Accept this candidate as a starting point?';
    qp.placeholder =
      'Judgment gates flagged it (below). You complete any wider changes and re-scan — or Cancel.';
    qp.ignoreFocusOut = false; // focus-loss = Cancel (Esc also resolves undefined)
    qp.items = items;
    let done = false;
    const finish = (value: Item | undefined): void => {
      if (done) return;
      done = true;
      qp.hide();
      qp.dispose();
      resolve(value);
    };
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      // A concern row is not actionable: keep the picker open on such a pick.
      if (!sel || sel.action === 'concern') return;
      finish(sel);
    });
    qp.onDidHide(() => finish(undefined)); // Esc / focus-loss
    qp.show();
  });
  return pick?.action === 'apply';
}

/**
 * Reject a candidate (feature B). The reject itself is unconditional: the decision
 * is recorded first, THEN an OPTIONAL reject-reason QuickPick is offered (Esc =
 * reason-less reject — never blocks the reject). The reason, when given, is stored
 * on the session (local only, never sent anywhere) so it can feed the report and
 * the Feedback Data JSON export. Shared by the tree Reject and the diff-bar Reject.
 */
async function rejectCandidate(node?: CRepairNode): Promise<void> {
  if (!session || node?.kind !== 'candidate') return;
  const active = session;
  const candidateId = node.candidate.candidate_id;
  active.setDecision(candidateId, 'rejected');
  // Diagnostic stays (the violation is unaddressed).
  tree.refresh();
  logInfo(`Rejected candidate=${candidateId}.`);

  // Ask (optionally) why. This must never block or undo the reject: an Esc leaves
  // the reject standing with no reason. A rescan/regenerate that replaced the
  // session or the decision while the picker was open discards the stray reason.
  const reason = await promptRejectReason();
  if (reason && session === active && active.decisionFor(candidateId) === 'rejected') {
    active.setRejectReason(candidateId, reason);
    logInfo(`Reject reason recorded for candidate=${candidateId}: ${reason.code}.`);
  }
}

/**
 * The optional reject-reason QuickPick (feature B). Returns the chosen reason, or
 * undefined when the user dismisses it (Esc / focus-loss) — a reason-less reject.
 * Picking "Other…" opens a one-line InputBox for an optional comment (an empty /
 * cancelled comment still records `other` with no comment). A QuickPick, not a
 * modal, so Windows does not chime (D-028).
 *
 * A test hook (CREPAIR_TEST_REJECT_REASON) bypasses the picker so the integration
 * suite can drive a specific choice without a real title bar: the value is a code
 * (optionally `other:<comment>`); anything else / unset shows the real picker.
 */
async function promptRejectReason(): Promise<RejectReason | undefined> {
  const hook = process.env[REJECT_REASON_HOOK_ENV];
  if (hook !== undefined) {
    if (hook === '' || hook === 'none') return undefined; // simulate Esc
    if (hook.startsWith('other:')) return { code: 'other', comment: hook.slice(6) || undefined };
    return { code: hook as RejectReason['code'] };
  }

  type Item = vscode.QuickPickItem & { code: RejectReason['code'] };
  const items: Item[] = REJECT_REASONS.map((r) => ({ label: r.label, code: r.code }));
  const choice = await vscode.window.showQuickPick(items, {
    title: 'C Repair: Reject reason (optional)',
    placeHolder: REJECT_REASON_PLACEHOLDER,
  });
  if (!choice) return undefined; // Esc / focus-loss = reason-less reject
  if (choice.code !== 'other') return { code: choice.code };

  const comment = await vscode.window.showInputBox({
    title: 'C Repair: Reject reason — comment (optional)',
    prompt: 'One line, optional. Stored locally only; never sent anywhere.',
    placeHolder: 'e.g. duplicates an existing suppression',
  });
  const trimmed = comment?.trim();
  return { code: 'other', ...(trimmed ? { comment: trimmed } : {}) };
}

/** Test hook env: bypasses the reject-reason picker with a fixed choice (see above). */
const REJECT_REASON_HOOK_ENV = 'CREPAIR_TEST_REJECT_REASON';

// --- diff review queue: title-bar commands (D-024) --------------------------

/**
 * The candidate id of the crepair diff currently active in an editor tab, or
 * undefined when the active tab is not a crepair diff. Recovered from the URI (the
 * URI carries `candidate=<id>`), so no separate URI↔candidate map is needed. Checks
 * the active tab's diff input first (the reliable source under a diff editor), then
 * falls back to the active text editor's document URI.
 */
function activeDiffCandidateId(): string | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input as { modified?: vscode.Uri; original?: vscode.Uri } | undefined;
  if (input?.modified) {
    const id = candidateIdFromUri(input.modified);
    if (id) return id;
  }
  if (input?.original) {
    const id = candidateIdFromUri(input.original);
    if (id) return id;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? candidateIdFromUri(active) : undefined;
}

/** The candidate node for a candidate id (for reuse of the node-based commands). */
function candidateNodeFor(candidateId: string): CRepairNode | undefined {
  const candidate = session?.candidateById(candidateId);
  return candidate ? { kind: 'candidate', candidate } : undefined;
}

/**
 * Accept the candidate whose diff is currently shown (title-bar Accept, D-024),
 * then advance to the next pending diffable candidate's diff (closing the current
 * one). Reuses the guarded acceptCandidate path (stale / conflict / judgment
 * warning). When nothing pending remains, the review-complete summary is shown.
 */
async function acceptCurrentDiff(): Promise<void> {
  const id = activeDiffCandidateId();
  const active = session;
  if (!id || !active) {
    void vscode.window.showInformationMessage('C Repair: open a repair diff to accept it.');
    return;
  }
  const node = candidateNodeFor(id);
  if (!node) return;
  const before = active.decisionFor(id);
  await acceptCandidate(node);
  // acceptCandidate may await a confirm QuickPick; a rescan could have replaced the session
  // meanwhile. Only advance when THIS session is still active and its decision
  // flipped to accepted (a blocked/cancelled accept leaves the diff for a retry).
  if (session === active && active.decisionFor(id) === 'accepted' && before !== 'accepted') {
    await advanceQueueAfter(id, { decided: true });
  }
}

/**
 * Reject the candidate whose diff is currently shown (title-bar Reject, D-024),
 * then advance to the next pending diffable candidate's diff (closing the current
 * one).
 */
async function rejectCurrentDiff(): Promise<void> {
  const id = activeDiffCandidateId();
  if (!id || !session) {
    void vscode.window.showInformationMessage('C Repair: open a repair diff to reject it.');
    return;
  }
  const node = candidateNodeFor(id);
  if (!node) return;
  await rejectCandidate(node);
  await advanceQueueAfter(id, { decided: true });
}

/**
 * Move to the next pending diffable candidate WITHOUT deciding the current one
 * (title-bar Next, D-024). The current candidate stays pending; it is simply
 * skipped for now (it remains in the queue and can be revisited from the tree).
 */
async function nextDiff(): Promise<void> {
  const id = activeDiffCandidateId();
  if (!id || !session) {
    void vscode.window.showInformationMessage('C Repair: open a repair diff to step through.');
    return;
  }
  await advanceQueueAfter(id, { decided: false });
}

/**
 * Regenerate the candidate whose diff is currently shown (title-bar Regenerate,
 * D-024): reuse the node-based regenerate path (replaces the candidate + decision),
 * then re-open the (possibly same-id) candidate's diff so the reviewer sees the
 * fresh proposal in place.
 */
async function regenerateCurrentDiff(): Promise<void> {
  const id = activeDiffCandidateId();
  if (!id || !session) {
    void vscode.window.showInformationMessage('C Repair: open a repair diff to regenerate it.');
    return;
  }
  const active = session;
  const node = candidateNodeFor(id);
  if (!node) return;
  // Which finding this candidate repairs, so we can find the replacement afterwards.
  const findingId = node.kind === 'candidate' ? node.candidate.finding_id : undefined;
  await regenerateRepair(node);
  if (session !== active || findingId === undefined) return;
  const fresh = active.candidateForFinding(findingId);
  // Re-open the fresh candidate's diff. When the regenerated candidate has a
  // different id (a stale ghost tab would remain) or produced no fix (nothing to
  // diff), close the current diff first; only open a new diff when it is diffable.
  const sameId = fresh?.candidate_id === id;
  if (!fresh || !candidateHasDiff(fresh)) {
    await closeActiveDiffEditor();
    if (fresh && !candidateHasDiff(fresh)) {
      void vscode.window.showInformationMessage(
        'C Repair: the regenerated repair produced no applicable fix.',
      );
    }
    return;
  }
  if (!sameId) await closeActiveDiffEditor();
  await openCandidateDiff(fresh.candidate_id);
}

/**
 * Close the current crepair diff and open the next pending diffable candidate's
 * diff (D-024 auto-advance). The search starts strictly AFTER the current
 * candidate in queue order, so Next (current still pending) and Accept/Reject
 * (current already decided) both advance correctly. When none remains, close the
 * diff and show the review-complete summary.
 */
async function advanceQueueAfter(
  currentId: string,
  opts: { decided?: boolean } = {},
): Promise<void> {
  const active = session;
  if (!active) return;
  const queue = diffableQueue(
    violationTargetsInOrder(active.scanResult),
    (id) => active.candidateForFinding(id),
  );
  const next = nextPendingDiffable(queue, currentId, (id) => active.decisionFor(id) === 'pending');

  if (next) {
    // Close the current diff and move to the next pending one.
    await closeActiveDiffEditor();
    await openCandidateDiff(next.candidate_id);
    return;
  }

  // No next pending. When the current candidate was only DEFERRED (Next, not
  // decided) and it is the last pending one, keep its diff open rather than closing
  // and declaring the review complete over an unreviewed item.
  const decided = opts.decided ?? true;
  if (!decided && active.decisionFor(currentId) === 'pending') {
    void vscode.window.showInformationMessage(
      'C Repair: no more repairs to review — this is the last pending one.',
    );
    return;
  }

  // Review complete: close the (decided) current diff and summarise the queue.
  await closeActiveDiffEditor();
  const tally = reviewTally(queue, (id) => active.decisionFor(id));
  // D-025: append the approximate spend of this Scan & Fix run (usage after − usage
  // before). Omitted when either reading was unavailable (cost display off / query
  // failed). Also refreshes the tooltip's cumulative figure to the post-run value.
  const costSuffix = await reviewCompleteCostSuffix(active);
  void vscode.window.showInformationMessage(
    `C Repair: Review complete — ${tally.accepted} accepted / ` +
      `${tally.rejected} rejected / ${tally.pending} pending.${costSuffix}`,
  );
  logInfo(
    `Review queue complete: ${tally.accepted} accepted, ${tally.rejected} rejected, ` +
      `${tally.pending} pending.`,
  );
}

/**
 * D-025: build the " ≈$0.XXXX spent (approx.)" suffix for the review-complete
 * notice from the pipeline's before/after usage delta, and refresh the status-bar
 * tooltip to the post-run cumulative figure. Returns "" when there is no delta to
 * show (cost display off, query failed, no run measured, or the session changed).
 * Always clears the per-run `pipelineUsage` so a later re-open of the diff does not
 * re-report a stale spend.
 */
async function reviewCompleteCostSuffix(active: ScanSession): Promise<string> {
  const tracked = pipelineUsage;
  pipelineUsage = undefined; // consumed either way
  const after = await currentUsage(); // also drives refreshUsage's tooltip update
  statusBar.setUsage(after);
  if (!tracked || tracked.session !== active) return '';
  const delta = usageDelta(tracked.before, after);
  if (delta === null) return '';
  return ` ≈${formatUsd(delta)} spent (approx.)`;
}

/** Close the active editor if it is a crepair diff (best-effort). */
async function closeActiveDiffEditor(): Promise<void> {
  if (activeDiffCandidateId() === undefined) return;
  try {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  } catch (err) {
    logInfo(`Could not close the diff editor: ${(err as Error).message}`);
  }
}

/**
 * Re-render diagnostics, dropping the findings whose candidate has been
 * accepted (their violation is addressed in the document now).
 */
function refreshDiagnosticsExcludingAccepted(doc: vscode.TextDocument): void {
  if (!session) return;
  const acceptedFindingIds = new Set(
    session.acceptedCandidates().map((c) => c.finding_id),
  );
  const filtered = {
    ...session.scanResult,
    functions: session.scanResult.functions.map((fn) => ({
      ...fn,
      findings: fn.findings.filter((f) => !acceptedFindingIds.has(f.finding_id)),
    })),
  };
  setScanDiagnostics(diagnostics, doc.uri, filtered);
}

/** Find an open TextDocument matching a session URI string. */
async function findOpenDoc(uriString: string): Promise<vscode.TextDocument | undefined> {
  const target = vscode.Uri.parse(uriString);
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.toString() === target.toString()) return d;
  }
  try {
    return await vscode.workspace.openTextDocument(target);
  } catch {
    return undefined;
  }
}

// --- stale monitoring -------------------------------------------------------

function onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
  if (!session) return;
  if (e.document.uri.toString() !== session.snapshot.uri) return;
  if (staleTimer) clearTimeout(staleTimer);
  const doc = e.document;
  staleTimer = setTimeout(() => {
    staleTimer = undefined;
    if (!session || doc.uri.toString() !== session.snapshot.uri) return;
    const changed = session.refreshStale(doc.getText());
    if (!changed) return;
    if (session.stale) {
      setStaleDiagnostic(diagnostics, doc.uri);
      statusBar.set('stale');
      void vscode.window.showWarningMessage(`C Repair: results are stale. ${STALE_RESULTS_MESSAGE}`);
    } else {
      // Hash restored to the expected state (revert, or the settle after an
      // accept): re-render scan results minus any accepted findings.
      refreshDiagnosticsExcludingAccepted(doc);
      statusBar.set('ready');
    }
    tree.refresh();
  }, STALE_DEBOUNCE_MS);
}

// --- config change -> bridge restart (D-019) --------------------------------

/**
 * The settings whose change requires a bridge restart to take effect: the model
 * / provider overrides are read only at bridge spawn (they become CREPAIR_* env
 * on the child), so an already-running bridge keeps the old effective config
 * until it is respawned.
 */
const BRIDGE_RESTART_SETTINGS = [
  'crepair.modelMode',
  'crepair.model',
  'crepair.freeModel',
  'crepair.providerOrder',
  'crepair.allowFallbacks',
  'crepair.providerPolicy',
  'crepair.bridge.configPath',
  'crepair.reasoningEffort',
];

/**
 * The settings whose change alters the effective model / tier / reasoning shown in
 * the always-on header line, so a change must drop the stale /health caps and fall
 * the line back to the new settings (D-031: modelMode / freeModel drive the tier +
 * effective model just like model / reasoningEffort do).
 */
const MODEL_LINE_SETTINGS = [
  'crepair.modelMode',
  'crepair.model',
  'crepair.freeModel',
  'crepair.reasoningEffort',
];

/**
 * A monotonically increasing token stamped on every config-change notification.
 * Because the settings notice is a single decision that supersedes any earlier one,
 * each new relevant change bumps this token; a still-open notification's callback
 * checks the token before acting so a stale [Restart] / [Switch] click (the user
 * changed the setting again, replacing the notice) becomes a no-op. This is the
 * "debounce / replace" so rapid consecutive edits do not stack notifications.
 */
let configNoticeToken = 0;

/**
 * True while the EXTENSION ITSELF is writing crepair.* settings (the notice actions:
 * switch-to-custom / clear-unused). Those programmatic writes re-enter
 * onConfigChanged, which must not answer them with ANOTHER notice (e.g. clicking
 * "Clear unused setting" resets crepair.model, which would otherwise pop the
 * switch-to-custom prompt — absurd right after the user chose to clear). While
 * suppressed the handler still refreshes the model line and bumps the token (the
 * programmatic write supersedes any open notice), it just shows nothing new.
 */
let suppressConfigNotices = false;

/**
 * Once-per-session latch for the startup mismatch notice (sample9 follow-up): the
 * warning shows at most once per extension-host session, but reappears on every new
 * session while the mismatch persists (so the ignored setting stays visible).
 */
let startupConfigNoticeShown = false;

/**
 * Restart the bridge to apply changed settings: kill the child so the next scan /
 * repair re-spawns it with the new env (the existing exit-monitor / lazy
 * ensureStarted path), then drop the stale /health caps + rebuild the model line.
 */
function restartBridgeForSettings(reason: string): void {
  bridge.kill();
  applyCapabilities(undefined);
  logInfo(`${reason}; bridge stopped, will respawn on next scan.`);
}

/**
 * The shared "Switch to custom & restart bridge" action (used by both the live
 * config-change notice and the startup mismatch notice): write
 * `crepair.modelMode = custom` (the single source-of-truth setting) and restart the
 * bridge so the next scan spawns with the custom model/provider env. The writes run
 * under `suppressConfigNotices` so the re-entrant onConfigChanged does not answer
 * them with another notice.
 */
async function switchToCustomAndRestart(): Promise<void> {
  suppressConfigNotices = true;
  try {
    const cfg = vscode.workspace.getConfiguration();
    for (const u of switchToCustomConfigUpdates()) {
      await cfg.update(u.key, u.value, vscode.ConfigurationTarget.Global);
    }
  } finally {
    suppressConfigNotices = false;
  }
  logInfo('Switched crepair.modelMode to custom to apply the model/provider settings.');
  restartBridgeForSettings('Model mode switched to custom');
}

/**
 * The startup notice's "Clear unused setting" action: reset `crepair.model` and
 * `crepair.providerOrder` to their defaults, resolving the mismatch from the
 * settings side (the mode stays as-is). Runs under `suppressConfigNotices` so the
 * re-entrant onConfigChanged does not pop a switch-to-custom prompt for the writes.
 */
async function clearUnusedCustomSettings(): Promise<void> {
  suppressConfigNotices = true;
  try {
    const cfg = vscode.workspace.getConfiguration();
    for (const u of clearUnusedSettingsUpdates()) {
      await cfg.update(u.key, u.value, vscode.ConfigurationTarget.Global);
    }
  } finally {
    suppressConfigNotices = false;
  }
  logInfo('Cleared unused crepair.model / crepair.providerOrder (mode is not custom).');
  refreshModelLine();
  void vscode.window.showInformationMessage(
    'C Repair: cleared the unused model / provider settings.',
  );
}

/**
 * The model actually in use for a non-custom mode, for the notice body's "what is
 * running" lead: the bundled verified default in `default` mode, the configured free
 * model in `free` mode. (`custom` never reaches the unused-settings notices.)
 */
function effectiveModelForMode(mode: ModelMode): string {
  return mode === 'free' ? readFreeModel() : DEFAULT_OVERRIDES.model;
}

/**
 * Startup mismatch check (sample9 follow-up): a `crepair.model` /
 * `crepair.providerOrder` value that was ALREADY set before this session while the
 * mode is not `custom` is silently ignored — the change listener never fires for it,
 * so without this check the Settings value and the header's effective model disagree
 * with no explanation. Shown once per session, with three ways out: use the value
 * (switch the mode to custom + restart), discard it (clear the unused settings, keep
 * the current mode), or Not now (it returns next session while the mismatch
 * persists). Called after the legacy free-model migration so a migrated
 * (auto-resolved) state is not flagged.
 */
function maybeShowStartupConfigNotice(): void {
  if (startupConfigNoticeShown) return;
  const cfg = vscode.workspace.getConfiguration('crepair');
  const notice = decideStartupConfigNotice(
    {
      model: cfg.get<string>('model', DEFAULT_OVERRIDES.model),
      providerOrder: cfg.get<string[]>('providerOrder', DEFAULT_OVERRIDES.providerOrder),
    },
    readModelMode(),
  );
  if (notice.kind !== 'unused-custom-settings') return;
  startupConfigNoticeShown = true;

  // Participate in the token protocol: a later live settings edit supersedes this
  // notice (its buttons become no-ops), exactly like any other open notice.
  configNoticeToken += 1;
  const token = configNoticeToken;
  logInfo(`Startup settings mismatch: unused custom settings under mode=${notice.mode}.`);
  const useLabel = useCustomActionLabel(notice.parts.modelValue);
  void vscode.window
    .showWarningMessage(
      unusedSettingsMessage(notice.mode, effectiveModelForMode(notice.mode), notice.parts),
      useLabel,
      DISCARD_ACTION,
      NOT_NOW_ACTION,
    )
    .then(async (choice) => {
      if (token !== configNoticeToken) return; // a newer change replaced this notice
      if (choice === useLabel) await switchToCustomAndRestart();
      else if (choice === DISCARD_ACTION) await clearUnusedCustomSettings();
      // Not now / dismissed: leave everything; the notice returns next session.
    });
}

function onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
  if (!BRIDGE_RESTART_SETTINGS.some((s) => e.affectsConfiguration(s))) return;

  // The model / reasoning / mode line reflects the changed setting immediately. Until
  // the bridge is restarted the /health caps are stale, so drop them and fall the line
  // back to the new settings (a later scan replaces it with the live caps).
  if (MODEL_LINE_SETTINGS.some((s) => e.affectsConfiguration(s))) {
    applyCapabilities(undefined);
  }

  const changed: ChangedSettings = {
    model: e.affectsConfiguration('crepair.model'),
    providerOrder: e.affectsConfiguration('crepair.providerOrder'),
    allowFallbacks: e.affectsConfiguration('crepair.allowFallbacks'),
    providerPolicy: e.affectsConfiguration('crepair.providerPolicy'),
    modelMode: e.affectsConfiguration('crepair.modelMode'),
    freeModel: e.affectsConfiguration('crepair.freeModel'),
    reasoningEffort: e.affectsConfiguration('crepair.reasoningEffort'),
    configPath: e.affectsConfiguration('crepair.bridge.configPath'),
  };
  const notice = decideConfigChangeNotice(changed, readModelMode());

  // Debounce / replace: a new relevant change supersedes any still-open notice, so
  // bump the token and let each callback verify it is still the current one.
  configNoticeToken += 1;
  const token = configNoticeToken;

  // A programmatic write from a notice action (switch-to-custom / clear-unused) must
  // not be answered with another notice; the model line above is already refreshed.
  if (suppressConfigNotices) return;

  if (notice.kind === 'switch-to-custom') {
    // The user edited a custom-only setting (model / providerOrder / allowFallbacks)
    // while the mode is NOT custom, so the edit is currently ignored (sample9 UX
    // defect). Explain what is running and when the typed value takes effect, and
    // offer to flip the mode to custom + restart the bridge. Shown regardless of
    // bridge state — the setting is ignored even before the first scan, so the
    // guidance matters (the switch primes the next scan to use it).
    const cfgC = vscode.workspace.getConfiguration('crepair');
    const parts = unusedSettingsParts({
      model: cfgC.get<string>('model', DEFAULT_OVERRIDES.model),
      providerOrder: cfgC.get<string[]>('providerOrder', DEFAULT_OVERRIDES.providerOrder),
      allowFallbacks: cfgC.get<boolean>('allowFallbacks', DEFAULT_OVERRIDES.allowFallbacks),
      providerPolicy: cfgC.get<string>('providerPolicy', DEFAULT_OVERRIDES.providerPolicy),
    });
    // The edit may have REVERTED the setting to its default (nothing is ignored any
    // more) — then there is no mismatch to flag and no notice.
    if (!hasUnusedParts(parts)) return;
    const useLabel = useCustomActionLabel(parts.modelValue);
    void vscode.window
      .showWarningMessage(
        unusedSettingsMessage(notice.mode, effectiveModelForMode(notice.mode), parts),
        useLabel,
        NOT_NOW_ACTION,
      )
      .then(async (choice) => {
        if (token !== configNoticeToken) return; // a newer change replaced this notice
        if (choice !== useLabel) return;
        await switchToCustomAndRestart();
      });
    return;
  }

  if (notice.kind === 'restart') {
    // A bridge-affecting setting that IS in effect changed (or the mode itself). If
    // the bridge was never started / already stopped there is nothing to restart —
    // the model line is already refreshed and the next scan spawns with the new env.
    if (bridge.state === 'stopped') return;
    void vscode.window
      .showInformationMessage(RESTART_MESSAGE, RESTART_ACTION)
      .then((choice) => {
        if (token !== configNoticeToken) return; // a newer change replaced this notice
        if (choice !== RESTART_ACTION) return;
        restartBridgeForSettings('Bridge restart requested for changed model/provider settings');
      });
  }
}

// --- helpers ----------------------------------------------------------------

function fileBasename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}

/** Read the compile include-path settings (D-020) from configuration. */
function readIncludePathSettings(): {
  compileIncludePaths: string[];
  autoIncludeFileDir: boolean;
} {
  const cfg = vscode.workspace.getConfiguration('crepair');
  return {
    compileIncludePaths: cfg.get<string[]>(
      'compileIncludePaths',
      DEFAULT_INCLUDE_PATH_SETTINGS.compileIncludePaths,
    ),
    autoIncludeFileDir: cfg.get<boolean>(
      'autoIncludeFileDir',
      DEFAULT_INCLUDE_PATH_SETTINGS.autoIncludeFileDir,
    ),
  };
}
