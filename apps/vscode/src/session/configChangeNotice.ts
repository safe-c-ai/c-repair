// Config-change notice classification (D-019 / D-031). When the user edits a
// bridge-affecting setting, the extension must tell them what will (and will NOT)
// take effect, because the model / provider overrides are read only at bridge spawn
// AND `crepair.model` / `crepair.providerOrder` are ignored outside `custom` mode.
//
// The silent-ignore case is the UX defect this fixes (user feedback, sample9):
// editing `crepair.model` while the mode is `default` changed nothing and said
// nothing. This module is the pure decision; extension.ts is the thin adapter that
// shows the matching notification + buttons and performs the restart / mode switch.
//
// Kept free of the `vscode` module (like overrideEnv.ts / modelMode.ts / resetState.ts)
// so the branching is unit-tested under plain Node.
//
// Two entry points:
//   - decideConfigChangeNotice — classifies a LIVE settings edit (the change listener).
//   - decideStartupConfigNotice — detects a PRE-EXISTING mismatch at activation: a
//     custom-only setting already holds a non-default value while the mode is not
//     `custom`, so it has been silently ignored since before this session (sample9
//     follow-up — the change listener alone never fires for a mismatch that predates
//     the session). The extension adapter shows it once per session.

import {
  DEFAULT_OVERRIDES,
  DEFAULT_MODE_LABEL_LOWER,
  hasExplicitModel,
  type ModelMode,
} from '../bridge/overrideEnv';

/**
 * Which settings changed, as booleans the caller derives from the
 * ConfigurationChangeEvent (`e.affectsConfiguration(...)`). Only the settings that
 * bear on the notice are listed; anything else is irrelevant here.
 */
export interface ChangedSettings {
  /** `crepair.model` changed. */
  model: boolean;
  /** `crepair.providerOrder` changed. */
  providerOrder: boolean;
  /** `crepair.allowFallbacks` changed (a custom-only routing setting, like the two above). */
  allowFallbacks: boolean;
  /** `crepair.providerPolicy` changed (a custom-only routing setting; only effective with an empty Provider Order). */
  providerPolicy: boolean;
  /** `crepair.modelMode` itself changed. */
  modelMode: boolean;
  /** `crepair.freeModel` changed. */
  freeModel: boolean;
  /** `crepair.reasoningEffort` changed. */
  reasoningEffort: boolean;
  /** `crepair.bridge.configPath` changed (advanced escape hatch). */
  configPath: boolean;
}

/**
 * The notice to surface for a config change:
 *   - `switch-to-custom` — a custom-only setting (model / providerOrder /
 *     allowFallbacks) changed while the mode is NOT `custom`, so the edit is
 *     currently ignored. Offer to switch the mode to `custom` (which makes it take
 *     effect) and restart the bridge.
 *   - `restart` — a bridge-affecting setting changed that IS in effect (or is the
 *     mode itself), so it just needs a bridge restart to apply.
 *   - `none` — nothing relevant changed (no notice).
 */
export type ConfigChangeNotice =
  | { kind: 'switch-to-custom'; mode: ModelMode }
  | { kind: 'restart' }
  | { kind: 'none' };

/** The custom-only routing settings (read only when the mode is `custom`). */
function changedCustomOnly(changed: ChangedSettings): boolean {
  return (
    changed.model || changed.providerOrder || changed.allowFallbacks || changed.providerPolicy
  );
}

/** Any setting that requires a bridge restart to take effect. */
function changedRestartRelevant(changed: ChangedSettings): boolean {
  return (
    changed.model ||
    changed.providerOrder ||
    changed.allowFallbacks ||
    changed.providerPolicy ||
    changed.modelMode ||
    changed.freeModel ||
    changed.reasoningEffort ||
    changed.configPath
  );
}

/**
 * Classify a config change into the notice to show (D-019 / D-031).
 *
 * The load-bearing rule: a custom-only setting (`crepair.model` /
 * `crepair.providerOrder` / `crepair.allowFallbacks`) changed while the mode is not
 * `custom` is silently ignored today — so it gets the `switch-to-custom` notice
 * (offer to flip the mode + restart) rather than a plain restart prompt that would
 * do nothing. When the mode already IS `custom`, or the change is to `modelMode` /
 * `freeModel` / `reasoningEffort` / `configPath` itself (settings that ARE in
 * effect), a plain restart notice is correct. Everything else is `none`.
 *
 * `switch-to-custom` takes precedence: if a user changes both `crepair.model` and
 * `crepair.reasoningEffort` in one edit while in `default` mode, the model change is
 * the ignored one worth flagging, so the switch prompt wins.
 */
export function decideConfigChangeNotice(
  changed: ChangedSettings,
  mode: ModelMode,
): ConfigChangeNotice {
  if (changedCustomOnly(changed) && mode !== 'custom') {
    return { kind: 'switch-to-custom', mode };
  }
  if (changedRestartRelevant(changed)) {
    return { kind: 'restart' };
  }
  return { kind: 'none' };
}

/** The dismiss label shared by every settings notice. */
export const NOT_NOW_ACTION = 'Not now';

/** The plain `restart` notice text (D-019): the changed setting is in effect. */
export const RESTART_MESSAGE =
  'C Repair: the model / provider settings changed. Restart the bridge to apply.';
/** The `restart` primary action label. */
export const RESTART_ACTION = 'Restart bridge to apply';

// --- unused-setting notices (change-time + startup, sample9 follow-up) -------
//
// Wording principle (user review round): the body reads "what is running now →
// when the typed value takes effect", and the buttons state OUTCOMES, not
// mechanisms:
//   body   — `C Repair is running on the preset model (<effective>). Your Model
//             setting "<value>" takes effect only when Model Mode is set to "custom".`
//             (free mode: the leading part names the free model instead)
//   button — `Use "<value>" (switch to custom)` / `Discard it (keep preset)` /
//             `Not now`.
// "preset" is the internal `default` mode's display label (D-038), derived from
// DEFAULT_MODE_LABEL so a future rename stays a one-constant swap.

/**
 * Which custom-only settings currently hold ignored (non-default) values, resolved
 * by the caller from configuration. Drives both the message body and the primary
 * button label.
 */
export interface UnusedSettingsParts {
  /** The explicit `crepair.model` value being ignored, or undefined when at default. */
  modelValue: string | undefined;
  /** Whether `crepair.providerOrder` differs from its default (ignored non-custom). */
  providerOrder: boolean;
  /** Whether `crepair.allowFallbacks` differs from its default (change notice only). */
  allowFallbacks: boolean;
  /** Whether `crepair.providerPolicy` differs from its default (change notice only). */
  providerPolicy: boolean;
}

/** Whether any custom-only setting is currently being ignored (notice-worthy). */
export function hasUnusedParts(parts: UnusedSettingsParts): boolean {
  return (
    parts.modelValue !== undefined ||
    parts.providerOrder ||
    parts.allowFallbacks ||
    parts.providerPolicy
  );
}

/**
 * Whether `crepair.providerOrder` still holds its verified default (`["DeepInfra"]`),
 * after the same normalization the override env applies (trim, drop blanks). An empty
 * array is a DELIBERATE non-default (automatic routing), so it is not "default".
 */
export function providerOrderIsDefault(order: string[]): boolean {
  const normalized = order.map((p) => p.trim()).filter((p) => p.length > 0);
  const def = DEFAULT_OVERRIDES.providerOrder;
  return normalized.length === def.length && normalized.every((x, i) => x === def[i]);
}

/**
 * Resolve the UnusedSettingsParts from the current setting values (pure; the caller
 * reads configuration). `allowFallbacks` participates only when the caller passes it
 * (the startup check scopes to model + providerOrder per the design ask).
 */
export function unusedSettingsParts(current: {
  model: string;
  providerOrder: string[];
  allowFallbacks?: boolean;
  providerPolicy?: string;
}): UnusedSettingsParts {
  return {
    modelValue: hasExplicitModel(current.model) ? current.model.trim() : undefined,
    providerOrder: !providerOrderIsDefault(current.providerOrder),
    allowFallbacks:
      current.allowFallbacks !== undefined &&
      current.allowFallbacks !== DEFAULT_OVERRIDES.allowFallbacks,
    providerPolicy:
      current.providerPolicy !== undefined &&
      current.providerPolicy !== DEFAULT_OVERRIDES.providerPolicy,
  };
}

/**
 * The notice body: what is running now, then when the typed value takes effect.
 * `effectiveModel` is the model actually in use (the bundled preset in `default`
 * mode; `crepair.freeModel` in `free` mode) — resolved by the caller.
 */
export function unusedSettingsMessage(
  mode: ModelMode,
  effectiveModel: string,
  parts: UnusedSettingsParts,
): string {
  const running =
    mode === 'free'
      ? `the free model (${effectiveModel})`
      : `the ${DEFAULT_MODE_LABEL_LOWER} model (${effectiveModel})`;
  const named: string[] = [];
  if (parts.modelValue !== undefined) named.push(`Model setting "${parts.modelValue}"`);
  if (parts.providerOrder) named.push('Provider Order setting');
  if (parts.allowFallbacks) named.push('Allow Fallbacks setting');
  if (parts.providerPolicy) named.push('Provider Policy setting');
  const verb = named.length === 1 ? 'takes' : 'take';
  return (
    `C Repair is running on ${running}. Your ${named.join(' and ')} ${verb} effect ` +
    `only when Model Mode is set to "custom".`
  );
}

/**
 * The primary action label: the OUTCOME of switching to custom mode. Names the model
 * value when one is set (`Use "<value>" (switch to custom)`); a provider-only /
 * fallbacks-only mismatch has no model value to name, so a generic form is used.
 */
export function useCustomActionLabel(modelValue: string | undefined): string {
  return modelValue !== undefined
    ? `Use "${modelValue}" (switch to custom)`
    : 'Use this setting (switch to custom)';
}

/** The startup notice's discard action: clear the unused settings, keep the mode. */
export const DISCARD_ACTION = `Discard it (keep ${DEFAULT_MODE_LABEL_LOWER})`;

// --- startup mismatch check (sample9 follow-up) ------------------------------

/** The custom-only settings' CURRENT values, read from configuration at activation. */
export interface StartupSettings {
  /** `crepair.model` (the raw setting value; blank / default = not explicitly set). */
  model: string;
  /** `crepair.providerOrder` (the raw array; `["DeepInfra"]` is the verified default). */
  providerOrder: string[];
}

/**
 * The startup notice: `unused-custom-settings` when a custom-only setting already
 * holds a non-default value while the mode is not `custom` (so it is being silently
 * ignored right now); `none` otherwise. `parts` carries which settings are ignored
 * (and the model value) for the message body and button label.
 */
export type StartupConfigNotice =
  | { kind: 'unused-custom-settings'; mode: ModelMode; parts: UnusedSettingsParts }
  | { kind: 'none' };

/**
 * Detect, at activation, a pre-existing settings/mode mismatch (sample9 follow-up):
 * `crepair.model` explicitly set (non-blank, non-default) and/or `crepair.providerOrder`
 * differing from its default, while `crepair.modelMode` is not `custom` — meaning those
 * values are silently ignored and the header's effective model will not match what the
 * user sees in Settings. In `custom` mode (or with both settings at their defaults)
 * there is no mismatch and no notice.
 */
export function decideStartupConfigNotice(
  settings: StartupSettings,
  mode: ModelMode,
): StartupConfigNotice {
  if (mode === 'custom') return { kind: 'none' };
  const parts = unusedSettingsParts({
    model: settings.model,
    providerOrder: settings.providerOrder,
  });
  if (!hasUnusedParts(parts)) return { kind: 'none' };
  return { kind: 'unused-custom-settings', mode, parts };
}

/**
 * The config updates the `Discard it (keep default)` action implies: reset
 * `crepair.model` and `crepair.providerOrder` to their defaults (`undefined` = remove
 * the user value, matching VS Code update semantics), resolving the mismatch from the
 * settings side instead of switching the mode. Pure list so the write set is
 * unit-tested.
 */
export interface ClearUnusedSettingUpdate {
  key: 'crepair.model' | 'crepair.providerOrder';
  value: undefined;
}
export function clearUnusedSettingsUpdates(): ClearUnusedSettingUpdate[] {
  return [
    { key: 'crepair.model', value: undefined },
    { key: 'crepair.providerOrder', value: undefined },
  ];
}
