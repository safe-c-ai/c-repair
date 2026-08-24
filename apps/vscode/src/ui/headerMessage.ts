// Pure builders for the C Repair TreeView header (`treeView.message`). The header
// is up to three lines:
//   1) the always-on model / tier / reasoning line, e.g.
//        "Model: deepseek/deepseek-v4-flash-0731 (PAID) · reasoning: xhigh"
//   2) the always-on standard line — the supported coding standard, referenced
//        (not a compliance claim): "Standard: CERT® C" (D-039).
//   3) the session token/cost line (cost/sessionUsage.ts), when a scan is active.
// Kept free of the `vscode` module so both the line construction and the FREE/PAID
// classification are unit testable under plain Node (mirrors bridge/health.ts).

import type { HealthCapabilities } from '../bridge/health';
import { effectiveModelLabel, effectiveReasoningLabel } from '../bridge/health';
import { DEFAULT_OVERRIDES, modeDisplayLower, type ModelMode } from '../bridge/overrideEnv';

/** The inputs to the model line, resolved by the caller (health or settings). */
export interface ModelLineInputs {
  /**
   * The effective /health capabilities, when the bridge is up. When undefined the
   * line falls back to the configured settings so the header is populated even
   * before the first scan (the health value replaces it once the bridge reports).
   */
  caps: HealthCapabilities | undefined;
  /**
   * The current `crepair.modelMode` (D-031) — the source of truth for which model the
   * header shows before /health reports: `default` -> the bundled default; `free` ->
   * `freeModel`; `custom` -> `configuredModel`.
   */
  mode: ModelMode;
  /** `crepair.model` (used when caps are absent AND mode is `custom`); blank => default. */
  configuredModel: string;
  /** `crepair.freeModel` (shown when caps are absent AND mode is `free`). */
  freeModel: string;
  /** `crepair.reasoningEffort` (used when caps are absent). */
  configuredReasoning: string;
  /**
   * Whether the bridge is running the free-model construction (B, free-tier auto
   * switch). A free construction is PAID-free regardless of the model string, so it
   * forces the FREE tag. Also true (via the caller) when the mode is `free`.
   */
  onFreeModel: boolean;
}

/**
 * The effective model id to show before /health reports, from the mode + settings
 * (D-031): `free` -> `freeModel`; `default` -> the bundled default (crepair.model is
 * ignored); `custom` -> `configuredModel` (blank resolves to the default). Once the
 * bridge reports, `effectiveModelLabel(caps)` supersedes this.
 */
export function configuredModelForMode(
  mode: ModelMode,
  configuredModel: string,
  freeModel: string,
): string {
  if (mode === 'free') return freeModel.trim() || DEFAULT_OVERRIDES.model;
  if (mode === 'default') return DEFAULT_OVERRIDES.model;
  return configuredModel.trim() || DEFAULT_OVERRIDES.model;
}

/**
 * Whether the effective model is FREE. FREE when the model id carries the OpenRouter
 * `:free` variant marker OR the bridge is in the free-model construction (free
 * fallback / free mode applied). Everything else is PAID.
 */
export function isFreeModel(model: string, onFreeModel: boolean): boolean {
  if (onFreeModel) return true;
  return model.trim().toLowerCase().includes(':free');
}

/**
 * The effective reasoning-effort text for the header. Prefers the /health value
 * (effectiveReasoningLabel); falls back to the configured `crepair.reasoningEffort`
 * when the bridge has not reported yet. A blank configured value renders the verified
 * default. Never returns null (unlike the status-bar helper) — the header always
 * shows a reasoning value.
 */
export function reasoningText(
  caps: HealthCapabilities | undefined,
  configuredReasoning: string,
): string {
  const fromHealth = effectiveReasoningLabel(caps);
  if (fromHealth) return fromHealth;
  const cfg = configuredReasoning.trim() || DEFAULT_OVERRIDES.reasoningEffort;
  if (cfg === 'off') return 'disabled';
  if (cfg === 'default') return 'config default';
  return cfg;
}

/**
 * Build the always-on model line, e.g.
 *   "Model: deepseek/deepseek-v4-flash-0731 (PAID) · reasoning: xhigh · mode: standard"
 * The model id comes from /health when available, else the configured setting (a
 * blank setting resolves to the verified default). The FREE/PAID tag reflects the
 * effective model + free-construction state; the reasoning value follows the same
 * health-then-settings precedence. The trailing `· mode: <label>` surfaces the model
 * mode (D-031) so a user editing `crepair.model` in a non-custom mode can see, in
 * the header, why their model is unchanged (sample9 UX defect). The internal
 * `default` mode renders as its display label (D-038); free/custom as themselves.
 */
export function modelLineText(inputs: ModelLineInputs): string {
  const model =
    inputs.caps !== undefined
      ? effectiveModelLabel(inputs.caps)
      : configuredModelForMode(inputs.mode, inputs.configuredModel, inputs.freeModel);
  const tier = isFreeModel(model, inputs.onFreeModel) ? 'FREE' : 'PAID';
  const reasoning = reasoningText(inputs.caps, inputs.configuredReasoning);
  return `Model: ${model} (${tier}) · reasoning: ${reasoning} · mode: ${modeDisplayLower(inputs.mode)}`;
}

/**
 * The always-on standard line. CERT® is referenced as the supported coding
 * standard — a purely descriptive interoperability reference, NOT a claim of
 * official conformance certification (D-039). The registered-trademark symbol is
 * carried so the mark is acknowledged wherever the standard is named.
 */
export const STANDARD_LINE = 'Standard: CERT® C';

/**
 * Combine the always-on model line, the always-on standard line, and the (optional)
 * session token/cost line into the TreeView `message` string. Lines are joined by
 * newlines; VS Code renders `treeView.message` newlines as separate rows in the
 * header. The standard line sits directly under the model line (D-039); the session
 * line follows only when a scan is active / metering is available.
 */
export function combineHeaderMessage(
  modelLine: string,
  sessionLine: string | undefined,
): string {
  const head = `${modelLine}\n${STANDARD_LINE}`;
  return sessionLine ? `${head}\n${sessionLine}` : head;
}
