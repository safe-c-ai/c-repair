// TypeScript types for the 6 contract objects (CONTRACT.md / packages/contract/schemas).
//
// These types follow the JSON Schemas exactly (field names, enum values). The
// schemas are the source of truth and must NOT be changed to fit the types.
// Enums are expressed as string-literal unions.

// --- shared -----------------------------------------------------------------

export interface IdVersion {
  id: string;
  version: string;
}

/** Original C basis, 1-indexed, both ends inclusive (CONTRACT.md §1). */
export interface LineRange {
  start_line: number;
  end_line: number;
}

// --- 2.1 SourceDocument -----------------------------------------------------

export type SourceOrigin = 'web_upload' | 'vscode_document' | 'fixture';

export interface SourceDocument {
  source_id: string;
  filename: string;
  language: 'c';
  content: string;
  /** sha256: prefixed hex of the UTF-8 content bytes. */
  content_hash: string;
  size_bytes: number;
  origin: SourceOrigin;
}

// --- 2.2 ContextAugmentationSet ---------------------------------------------

export type AugmentationStatus = 'draft' | 'confirmed';

export type AugmentationKind =
  | 'inferred_type'
  | 'external_global'
  | 'external_function_declaration'
  | 'external_function_stub'
  | 'inferred_macro'
  | 'opaque_type'
  | 'validation_helper'
  | 'other';

export type AugmentationProvenance =
  | 'exact_same_file'
  | 'derived_from_usage'
  | 'llm_inferred'
  | 'user_corrected';

export interface UsageEvidence {
  /** Original C line (1-indexed) of the usage. */
  line: number;
  snippet: string;
}

export interface ContextAugmentationItem {
  item_id: string;
  kind: AugmentationKind;
  /** LLM (fixture) generated original text. Immutable. */
  generated_text: string;
  /** Currently displayed / used text. Editable. */
  current_text: string;
  provenance: AugmentationProvenance;
  /** True when current_text !== generated_text. */
  user_edited: boolean;
  confirmed: boolean;
  rationale: string;
  usage_evidence: UsageEvidence[];
}

export interface ContextAugmentationSet {
  set_id: string;
  source_id: string;
  original_hash: string;
  status: AugmentationStatus;
  /** Non-null once confirmed. */
  context_revision_id: string | null;
  /** Line count of the synthesized prelude (markers + note + blank included). */
  prelude_line_count: number;
  items: ContextAugmentationItem[];
}

// --- 2.3 FunctionScanResult -------------------------------------------------

export type FindingKind = 'violation' | 'uncertain';

export interface Finding {
  finding_id: string;
  kind: FindingKind;
  /** Required for kind=violation; optional for uncertain. */
  rule_id?: string;
  rule_summary: string;
  explanation: string;
  location: LineRange;
  assumption_dependent: boolean;
}

export interface ScanFunction {
  function_id: string;
  name: string;
  original_range: LineRange;
  /** V1: 0..1 elements (D-003). Schema permits more. */
  findings: Finding[];
}

export interface FunctionScanResult {
  scan_id: string;
  source_id: string;
  original_hash: string;
  context_revision_id: string;
  rule_profile: IdVersion;
  adapter: IdVersion;
  harness: IdVersion;
  functions: ScanFunction[];
}

// --- 2.4 RepairCandidate ----------------------------------------------------

export type CandidateStatus = 'repair_ready' | 'repair_failed' | 'validation_failed';

export type ValidationStatus = 'pass' | 'fail' | 'skipped' | 'not_run';

export interface Validation {
  name: string;
  status: ValidationStatus;
  detail?: string;
}

/** Patch unit (Original C basis, generation-method-neutral — D-004). */
export interface Hunk {
  hunk_id: string;
  /** 1-indexed. */
  start_line: number;
  /** 0 = insert before start_line. n>0 = replace n lines from start_line. */
  line_count: number;
  /** Empty string + line_count>0 = deletion. */
  replacement_text: string;
}

export interface RepairCandidate {
  candidate_id: string;
  finding_id: string;
  function_id: string;
  source_id: string;
  original_hash: string;
  context_revision_id: string;
  status: CandidateStatus;
  repair_explanation: string;
  hunks: Hunk[];
  validations: Validation[];
  model_identity?: string;
}

// --- 2.5 PatchSelection -----------------------------------------------------

export type Decision = 'accepted' | 'rejected' | 'pending';

export interface SelectionDecision {
  candidate_id: string;
  decision: Decision;
}

export interface SelectionConflict {
  candidate_ids: string[];
  reason: string;
}

export interface PatchSelection {
  selection_id: string;
  source_id: string;
  original_hash: string;
  context_revision_id: string;
  decisions: SelectionDecision[];
  conflicts: SelectionConflict[];
}

// --- 2.6 ExportReport -------------------------------------------------------

export interface ExportAcceptedEntry {
  candidate_id: string;
  finding_id: string;
  rule_id: string;
  validations: Validation[];
}

export interface ExportReport {
  export_id: string;
  source: {
    filename: string;
    original_hash: string;
  };
  context_revision_id: string;
  rule_profile: IdVersion;
  adapter: IdVersion;
  harness: IdVersion;
  accepted: ExportAcceptedEntry[];
  rejected_count: number;
  pending_count: number;
  output: {
    filename: string;
    content_hash: string;
  };
  assumption_dependent: boolean;
  disclaimer: string;
}
