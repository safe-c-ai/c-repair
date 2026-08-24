// First-run model-mode selection (D-031, "trial free guarantee"): before any
// billable LLM call, the user is asked once whether to try the free model (`$0`)
// or use the default (usage-based) model, so a credited key never starts billing
// silently. The decision is recorded in globalState (crepair.modelModeChosen) and
// skipped thereafter; it can be re-run any time via `Choose Model Mode`.
//
// The mode itself is stored in the `crepair.modelMode` SETTING (the single source
// of truth — the picker / command only update that setting, never `crepair.model`).
// The globalState flag records only that the first-run prompt has been answered so
// it is not shown again.
//
// Kept free of the `vscode` module (like overrideEnv.ts / resetState.ts) so the
// decision logic is unit-tested under plain Node. extension.ts is the thin adapter
// that shows the QuickPick, reads/writes the flag, and applies the config updates.

import {
  DEFAULT_MODE_LABEL,
  DEFAULT_OVERRIDES,
  hasExplicitModel,
  type ModelMode,
} from '../bridge/overrideEnv';

/** Re-exported so callers keep importing the mode type from this module (D-031). */
export type { ModelMode };

/**
 * The fail-closed scan-gate notice (D-031 billing safety): shown when the first-run
 * model-mode picker is dismissed (Esc / focus-loss) at scan start. The scan is
 * ABORTED — it must never continue on the billable preset model without an explicit
 * choice — and the chosen flag stays unrecorded so the gate asks again next scan.
 * The action button re-opens the picker via the `crepair.chooseModelMode` command.
 * The preset name derives from DEFAULT_MODE_LABEL (D-038) so a label rename stays a
 * one-constant swap.
 */
export const MODEL_MODE_GATE_MESSAGE =
  `Choose a model mode to start scanning — Free ($0) or the ${DEFAULT_MODE_LABEL} ` +
  `model (usage-based).`;

/** The scan-gate notice button: launches the `crepair.chooseModelMode` command. */
export const MODEL_MODE_GATE_ACTION = 'Choose Model Mode';

/**
 * The config updates that switching to `custom` mode implies (D-019): only
 * `crepair.modelMode = 'custom'`. Mirrors `modelModeConfigUpdates('custom')` and is
 * kept as a named export so the config-change "Switch to custom" adapter reuses the
 * same single-source-of-truth write (the mode setting is the only thing written; the
 * model / provider settings the user just edited are read once the mode is custom).
 */
export function switchToCustomConfigUpdates(): ModelModeConfigUpdate[] {
  return modelModeConfigUpdates('custom');
}

/**
 * Whether the first-run model-mode QuickPick should be shown at a given trigger
 * (D-031). The picker is shown only when the user has NOT already chosen a mode
 * AND is still on the `default` mode with NO explicit `crepair.model` — i.e. they
 * have not yet expressed any deliberate model choice. A non-default `crepair.modelMode`
 * (free / custom) or an explicit legacy `crepair.model` is a prior deliberate choice
 * we respect: the caller just records the flag without prompting.
 *
 * - `chosen` — the crepair.modelModeChosen globalState flag.
 * - `mode`   — the current `crepair.modelMode` setting.
 * - `model`  — the current `crepair.model` setting (legacy explicit-choice detection).
 */
export function shouldPromptModelMode(
  chosen: boolean,
  mode: ModelMode,
  model: string,
): boolean {
  if (chosen) return false;
  if (mode !== 'default') return false; // an explicit mode is already a choice
  if (hasExplicitModel(model)) return false; // legacy explicit model wins too
  return true;
}

/**
 * Whether, when NOT prompting, the flag should still be recorded so the picker is
 * not shown again (D-031). True exactly when the reason we are not prompting is a
 * prior deliberate choice (a non-default mode OR an already-explicit legacy model) —
 * the user has effectively already chosen. A default mode with a default model is
 * left unflagged so the next trigger still prompts. When `chosen` is already true
 * there is nothing more to record (returns false).
 */
export function shouldRecordWithoutPrompt(
  chosen: boolean,
  mode: ModelMode,
  model: string,
): boolean {
  if (chosen) return false;
  return mode !== 'default' || hasExplicitModel(model);
}

/**
 * One-time migration (D-031): older builds recorded a `free` choice by writing
 * `crepair.model = crepair.freeModel` directly. Now that `crepair.modelMode` is the
 * source of truth, detect that legacy state at startup and migrate it to
 * `modelMode=free` (clearing the stray `crepair.model`) so the user keeps running
 * the free model. Runs only when the mode is still unset (`default`) — a user who has
 * since set an explicit mode is left alone.
 *
 * @param mode      the current `crepair.modelMode` setting.
 * @param model     the current `crepair.model` setting.
 * @param freeModel the resolved `crepair.freeModel` value.
 */
export function shouldMigrateLegacyFreeModel(
  mode: ModelMode,
  model: string,
  freeModel: string,
): boolean {
  if (mode !== 'default') return false; // already on an explicit mode — nothing to migrate
  const m = model.trim();
  const f = freeModel.trim();
  return m.length > 0 && m === f;
}

/**
 * The config updates a model-mode choice implies (D-031), as a pure value the
 * extension applies with `workspace.getConfiguration().update(...)`. Each entry is
 * `{ key, value }` where `value === undefined` means "reset to the default"
 * (ConfigurationTarget.Global), matching VS Code's update semantics.
 *
 * The mode is the single source of truth, so the picker writes ONLY `crepair.modelMode`
 * — it never touches `crepair.model` / `crepair.providerOrder` (those are for `custom`
 * mode and are read only when the mode is `custom`).
 *
 * - `free`    — `crepair.modelMode = 'free'` (the free env is derived from the mode +
 *               `crepair.freeModel` at bridge spawn — a visible, reversible setting).
 * - `default` — `crepair.modelMode` reset to its default (undefined = the bundled model).
 * - `custom`  — `crepair.modelMode = 'custom'` (the model/provider settings below take effect).
 */
export interface ModelModeConfigUpdate {
  key: 'crepair.modelMode';
  /** The value to write; `undefined` resets the setting to its default (`default`). */
  value: ModelMode | undefined;
}

/**
 * Map a model-mode choice to the settings writes it implies (D-031). The mode is the
 * only setting written; `default` clears the override (undefined) rather than writing
 * the literal `'default'` so the setting stays at its package.json default.
 */
export function modelModeConfigUpdates(mode: ModelMode): ModelModeConfigUpdate[] {
  return [{ key: 'crepair.modelMode', value: mode === 'default' ? undefined : mode }];
}

/** Re-exported so callers building the picker default label share one source. */
export { DEFAULT_OVERRIDES };
