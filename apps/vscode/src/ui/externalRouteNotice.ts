// Pure builder for the external-route consent notice (D-016). This scan sends the
// user's file to OpenRouter, so before the first send we surface WHERE the code
// goes (model + provider) and HOW the data is handled — as an informational
// consent confirmation, NOT a warning (sample15: a paying user reads a warning as
// alarming; this is a "you're about to send code, here's where" confirmation).
//
// Kept free of the `vscode` module so the wording is unit-testable under plain
// Node (mirrors headerMessage.ts / overrideEnv.ts). extension.ts reads the four
// settings, resolves them to the effective routing per mode (matching what the
// bridge actually does), and renders the returned strings into the QuickPick's
// title / placeholder / item detail — never truncated (the file previously packed
// everything into a single placeholder line, which VS Code cut off).

import {
  DEFAULT_OVERRIDES,
  type ModelMode,
  type ProviderPolicy,
} from '../bridge/overrideEnv';
import { configuredModelForMode } from './headerMessage';

/** The settings that shape the notice, already read from configuration. */
export interface ExternalRouteInputs {
  /** `crepair.modelMode` (D-031) — decides which model/provider construction applies. */
  mode: ModelMode;
  /** `crepair.model` — the custom-mode model id (ignored in default/free mode). */
  model: string;
  /** `crepair.freeModel` — the free-mode model id. */
  freeModel: string;
  /** `crepair.providerOrder` — the custom-mode provider pin ([] = automatic routing). */
  providerOrder: string[];
  /** `crepair.providerPolicy` — the custom-mode auto-routing profile (applies only when order is empty). */
  providerPolicy: ProviderPolicy;
}

/** The rendered text of the notice, split so no line is truncated in the QuickPick. */
export interface ExternalRouteText {
  /** QuickPick title — a question-form confirmation, deliberately not a warning. */
  title: string;
  /** Line 1: where the code goes (provider + model). Shown as the placeholder. */
  routeLine: string;
  /** Line 2: how the data is handled — only what we can truthfully assert. */
  dataLine: string;
}

/** The confirmation title (question form, informational — never a warning). */
export const EXTERNAL_ROUTE_TITLE = 'C Repair: send code to provider?';

/**
 * Resolve the provider display for a mode's EFFECTIVE routing (what the bridge does):
 *   - `free`   — the free construction forces automatic routing (the DeepInfra pin
 *     cannot serve `:free` models), so the provider is auto-selected. There is no
 *     ZDR policy on the free path, so it is never the ZDR phrasing.
 *   - `default`— the bundled config keeps its verified provider pin, so show the
 *     pinned name(s).
 *   - `custom` — the user's `providerOrder` / `providerPolicy` apply verbatim:
 *       * a non-empty pin       -> the pinned name(s), "A → B";
 *       * empty + private-cheap -> a Zero-Data-Retention provider (auto-selected);
 *       * empty + balanced      -> an automatically selected provider.
 * `isZdrEnforced` is true ONLY when WE restrict routing to ZDR endpoints (custom +
 * private-cheap + empty order) — the single case the data line may claim ZDR.
 */
export function resolveProviderDisplay(inputs: ExternalRouteInputs): {
  providerText: string;
  isZdrEnforced: boolean;
} {
  const pin = inputs.providerOrder.map((p) => p.trim()).filter((p) => p.length > 0);

  if (inputs.mode === 'free') {
    return { providerText: 'an automatically selected provider', isZdrEnforced: false };
  }

  if (inputs.mode === 'default') {
    // The bundled default keeps its verified provider pin.
    const order = DEFAULT_OVERRIDES.providerOrder;
    return { providerText: order.join(' → '), isZdrEnforced: false };
  }

  // custom: the user's pin / policy apply verbatim.
  if (pin.length > 0) {
    return { providerText: pin.join(' → '), isZdrEnforced: false };
  }
  if (inputs.providerPolicy === 'private-cheap') {
    return {
      providerText: 'a Zero-Data-Retention provider (auto-selected)',
      isZdrEnforced: true,
    };
  }
  return { providerText: 'an automatically selected provider', isZdrEnforced: false };
}

/**
 * Build the external-route consent text (D-016), tone: informational confirmation.
 *   routeLine: "This scan sends the file to OpenRouter → <provider> (model <id>)."
 *   dataLine (only what we can truthfully assert):
 *     - ZDR enforced (custom + private-cheap + empty order):
 *         "Routing is restricted to endpoints marked Zero Data Retention on OpenRouter."
 *     - otherwise:
 *         "Data handling depends on the provider — see its data policy on OpenRouter."
 * The model id follows the mode (custom -> crepair.model; free -> freeModel; default
 * -> the bundled default), matching what actually runs.
 */
export function externalRouteText(inputs: ExternalRouteInputs): ExternalRouteText {
  const model = configuredModelForMode(inputs.mode, inputs.model, inputs.freeModel);
  const { providerText, isZdrEnforced } = resolveProviderDisplay(inputs);

  const routeLine = `This scan sends the file to OpenRouter → ${providerText} (model ${model}).`;
  const dataLine = isZdrEnforced
    ? 'Routing is restricted to endpoints marked Zero Data Retention on OpenRouter.'
    : 'Data handling depends on the provider — see its data policy on OpenRouter.';

  return { title: EXTERNAL_ROUTE_TITLE, routeLine, dataLine };
}
