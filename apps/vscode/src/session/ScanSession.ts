// ScanSession: the state for one scanned file (VSCODE_V1B_DESIGN.md §3). One
// file → one session; a re-scan replaces it. Holds the snapshot (uri / content /
// content_hash), the confirmed revision id, the FunctionScanResult, and — for
// V1b-2 — the source document + confirmed context set needed to call /repair,
// the generated candidates, per-candidate decisions, and the "expected hash"
// chain that tracks the document as accepted repairs are applied (D-006 chain).
//
// This class is VS Code-API-light: it stores the uri as a string and never
// imports `vscode`, so the stale logic stays unit testable. The command layer
// owns the DiagnosticCollection / TreeView and reacts to session changes.

import type {
  FunctionScanResult,
  SourceDocument,
  ContextAugmentationSet,
  RepairCandidate,
  Decision,
} from '@c-repair/contract';
import { contentHash, isStale } from './hash';
import type { RejectReason } from './rejectReason';

export interface Snapshot {
  /** Document URI as a string (vscode.Uri.toString()). */
  uri: string;
  filename: string;
  /** Full Original C text captured at scan time. */
  content: string;
  /** `sha256:<hex>` of `content`. */
  contentHash: string;
  /**
   * The scanned file's directory, when the source is a real on-disk file (D-020).
   * `undefined` for a non-`file`-scheme document (untitled, virtual, etc.). Used
   * to auto-add `-I <dir>` so project headers next to the file are found by the
   * compile gate. Held here (not `vscode`-typed) so include-path assembly stays
   * unit testable.
   */
  fileDir?: string;
}

export class ScanSession {
  readonly snapshot: Snapshot;
  readonly revisionId: string;
  readonly scanResult: FunctionScanResult;
  /** The SourceDocument sent to /scan — replayed to /repair (bridge is stateless). */
  readonly source: SourceDocument;
  /** The confirmed context set — replayed to /repair. */
  readonly confirmedSet: ContextAugmentationSet;

  /**
   * Residual missing-symbol count from the last /context/check run before this
   * scan (Codex review round). `undefined` = no check ran on this scan path
   * (skip / cache / direct — nothing asserted); `0` = the check passed; `> 0`
   * = the context was known-incomplete at scan time, so findings may be
   * incomplete (0 violations is not a safety guarantee). UI session state only
   * (not in the contract); independent of the confirmed/assumption-dependent
   * axis; cleared with the session on re-scan (D-006).
   */
  contextStillMissing: number | undefined;

  /** candidate_id -> candidate (V1b-2). At most one candidate per finding here. */
  private readonly _candidates = new Map<string, RepairCandidate>();
  /** candidate_id -> decision (accepted / rejected). Absent = pending. */
  private readonly _decisions = new Map<string, Decision>();
  /**
   * candidate_ids accepted over a judgment-gate warning (D-023). The decision is
   * still `accepted`; this set records that the user overrode a failing judgment
   * gate, so the TreeView can surface `[accepted ⚠]`. UI session state only (not
   * in the contract); cleared with the session on re-scan (D-006).
   */
  private readonly _acceptedWithWarning = new Set<string>();

  /**
   * candidate_id -> the optional reject-reason feedback recorded when the user
   * rejected it (feature B). Present only for a `rejected` candidate that carried a
   * reason (an Esc-dismissed picker leaves it absent — a reason-less reject). Local
   * only, never sent anywhere; follows the same discard semantics as _decisions
   * (cleared when the decision leaves `rejected`, dropped on regenerate / re-scan).
   */
  private readonly _rejectReasons = new Map<string, RejectReason>();

  /**
   * candidate_ids whose diff has been DISPLAYED this session (D-014 "reviewed",
   * V1 simple definition: showing the candidate's diff on Screen 4 marks it
   * reviewed — no scroll/dwell/checkbox refinement). Drives `Accept all
   * reviewed` (eligible ∧ reviewed). UI session state only, NOT in the
   * contract (D-014); discarded with the session on re-scan / D-006 reset.
   */
  private readonly _reviewed = new Set<string>();

  private _stale = false;

  /**
   * The hash the document is EXPECTED to have right now (D-006 chain version).
   * Starts as the snapshot hash. Each accepted candidate advances it to the hash
   * of the document after that accept, so subsequent Accept stale-checks compare
   * against the live edited document, not the pristine snapshot.
   */
  private _expectedHash: string;

  constructor(
    snapshot: Snapshot,
    revisionId: string,
    scanResult: FunctionScanResult,
    source: SourceDocument,
    confirmedSet: ContextAugmentationSet,
  ) {
    this.snapshot = snapshot;
    this.revisionId = revisionId;
    this.scanResult = scanResult;
    this.source = source;
    this.confirmedSet = confirmedSet;
    this._expectedHash = snapshot.contentHash;
  }

  get stale(): boolean {
    return this._stale;
  }

  /** The hash the document should currently have (snapshot, then post-accept). */
  get expectedHash(): string {
    return this._expectedHash;
  }

  /** Advance the expected hash after applying an accepted repair. */
  setExpectedHash(hash: string): void {
    this._expectedHash = hash;
  }

  // --- candidates -----------------------------------------------------------

  /** Store (or replace) the candidate for a finding. */
  setCandidate(candidate: RepairCandidate): void {
    this._candidates.set(candidate.candidate_id, candidate);
  }

  /**
   * Replace the candidate for a finding (Regenerate, D-023): drop any prior
   * candidate for the same finding along with its decision / override flag, then
   * install the fresh one. A regenerated candidate may reuse the same
   * candidate_id (the bridge derives it from function+finding+revision), so an
   * old `accepted` decision must not silently carry over to the new candidate.
   */
  replaceCandidateForFinding(findingId: string, candidate: RepairCandidate): void {
    for (const [id, c] of [...this._candidates]) {
      if (c.finding_id !== findingId) continue;
      this._candidates.delete(id);
      this._decisions.delete(id);
      this._acceptedWithWarning.delete(id);
      this._rejectReasons.delete(id);
    }
    this._candidates.set(candidate.candidate_id, candidate);
  }

  candidateById(candidateId: string): RepairCandidate | undefined {
    return this._candidates.get(candidateId);
  }

  /** The candidate generated for a given finding, if any. */
  candidateForFinding(findingId: string): RepairCandidate | undefined {
    for (const c of this._candidates.values()) {
      if (c.finding_id === findingId) return c;
    }
    return undefined;
  }

  candidates(): RepairCandidate[] {
    return [...this._candidates.values()];
  }

  // --- decisions ------------------------------------------------------------

  setDecision(candidateId: string, decision: Decision): void {
    if (decision === 'pending') {
      this._decisions.delete(candidateId);
      this._acceptedWithWarning.delete(candidateId);
      this._rejectReasons.delete(candidateId);
    } else {
      this._decisions.set(candidateId, decision);
      // Any decision other than an over-warning accept clears the override flag.
      if (decision !== 'accepted') this._acceptedWithWarning.delete(candidateId);
      // A reject reason only belongs to a `rejected` decision; drop it otherwise.
      if (decision !== 'rejected') this._rejectReasons.delete(candidateId);
    }
  }

  /**
   * Record the optional reject-reason feedback for a candidate (feature B). Only
   * meaningful for a `rejected` candidate; passing `undefined` clears any prior
   * reason (a reason-less reject). Local only — never sent over the network.
   */
  setRejectReason(candidateId: string, reason: RejectReason | undefined): void {
    if (reason) this._rejectReasons.set(candidateId, reason);
    else this._rejectReasons.delete(candidateId);
  }

  /** The recorded reject reason for a candidate, or undefined (reason-less / not rejected). */
  rejectReasonFor(candidateId: string): RejectReason | undefined {
    return this._rejectReasons.get(candidateId);
  }

  decisionFor(candidateId: string): Decision {
    return this._decisions.get(candidateId) ?? 'pending';
  }

  /**
   * Record that a candidate was accepted over a judgment-gate warning (D-023).
   * Sets the decision to `accepted` and flags the override for the TreeView.
   */
  setAcceptedWithWarning(candidateId: string): void {
    this._decisions.set(candidateId, 'accepted');
    this._acceptedWithWarning.add(candidateId);
  }

  /** Whether this candidate was accepted over a judgment-gate warning (D-023). */
  wasAcceptedWithWarning(candidateId: string): boolean {
    return this._acceptedWithWarning.has(candidateId);
  }

  /**
   * The disposition record for a candidate: its decision plus, for an `accepted`
   * candidate, whether it was accepted over a failing judgment gate (D-023
   * override). This is the single source the Export Repair Report reads, so both
   * accept paths (single accept via setAcceptedWithWarning / bulk accept via
   * setDecision) surface a consistent override fact — bulk accept never overrides
   * a judgment gate (those are skipped, needing per-candidate confirmation), so it
   * always reports `overrode: false`. `overrode` is only meaningful when the
   * decision is `accepted`; it is false for pending / rejected.
   */
  dispositionFor(
    candidateId: string,
  ): { decision: Decision; overrode: boolean; rejectReason?: RejectReason } {
    const decision = this.decisionFor(candidateId);
    const reason = decision === 'rejected' ? this._rejectReasons.get(candidateId) : undefined;
    return {
      decision,
      overrode: decision === 'accepted' && this._acceptedWithWarning.has(candidateId),
      ...(reason ? { rejectReason: reason } : {}),
    };
  }

  // --- reviewed (D-014, V1c) ------------------------------------------------

  /** Record that this candidate's diff was displayed (D-014: that IS reviewed). */
  markReviewed(candidateId: string): void {
    this._reviewed.add(candidateId);
  }

  /** Whether this candidate's diff has been displayed this session (D-014). */
  wasReviewed(candidateId: string): boolean {
    return this._reviewed.has(candidateId);
  }

  /** Every candidate currently marked accepted (for conflict / offset math). */
  acceptedCandidates(): RepairCandidate[] {
    const out: RepairCandidate[] = [];
    for (const [id, decision] of this._decisions) {
      if (decision !== 'accepted') continue;
      const c = this._candidates.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  // --- stale ----------------------------------------------------------------

  /**
   * Recompute stale-ness from the document's current text. Returns true if the
   * stale state CHANGED (so the caller can refresh UI only when needed).
   *
   * Stale is measured against the EXPECTED hash (the snapshot hash, or — once
   * repairs have been accepted and applied — the post-accept hash). So an
   * accepted-then-still document is NOT stale, but any further manual edit (or
   * an undo that unwinds an accepted repair) makes it stale. Reverting exactly
   * to the current expected content clears stale (hash-based, D-006 mapping).
   */
  refreshStale(currentContent: string): boolean {
    const nowStale = isStale(this._expectedHash, currentContent);
    if (nowStale === this._stale) return false;
    this._stale = nowStale;
    return true;
  }

  /**
   * Build a snapshot from raw document data (hashing the content). `fileDir` is
   * the scanned file's directory for a real on-disk file, else undefined (D-020).
   */
  static makeSnapshot(
    uri: string,
    filename: string,
    content: string,
    fileDir?: string,
  ): Snapshot {
    return { uri, filename, content, contentHash: contentHash(content), fileDir };
  }
}
