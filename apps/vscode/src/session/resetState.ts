// Reset Extension State (onboarding re-run): the single source of truth for the
// globalState one-time flags C Repair persists. `crepair.resetExtensionState`
// clears the API key (SecretStorage), these globalState flags, the context cache
// (workspaceState) and the live session so the next scan runs the onboarding from
// scratch (external-route notice + free-model warning both re-appear).
//
// Kept as a pure module (no `vscode` import) so the flag list is unit-testable and
// so extension.ts consumes these constants at every write site — a new one-time
// flag MUST be added here (and used from here) or the reset would silently leave it
// behind. The unit test asserts every crepair.*Acknowledged key is listed.

/** globalState key: the external-route notice (D-016) has been acknowledged. */
export const EXTERNAL_NOTICE_SHOWN_KEY = 'crepair.externalNoticeAcknowledged';

/** globalState key: the free-model warning (B) has been shown once. */
export const FREE_MODEL_NOTICE_SHOWN_KEY = 'crepair.freeModelNoticeAcknowledged';

/**
 * globalState key: the first-run model-mode selection (D-031) has been made (free
 * or default), so the QuickPick is skipped thereafter. Cleared by Reset Extension
 * State so the trial-free prompt re-appears on the next key-set / scan. NB: this
 * flag does NOT follow the `*Acknowledged` naming (it records a two-way choice, not
 * an acknowledgement), so the reset-scan test enforces coverage by the exported
 * constants list below rather than by the `*Acknowledged` literal scan.
 */
export const MODEL_MODE_CHOSEN_KEY = 'crepair.modelModeChosen';

/**
 * globalState key: the Getting Started walkthrough (V3c) has been auto-opened
 * once on first activation. Records a fact, not a choice (so it does not use
 * the `*Acknowledged` naming); the walkthrough never auto-opens again but
 * stays reachable from the Welcome page. Cleared by Reset Extension State so
 * onboarding re-runs whole.
 */
export const WALKTHROUGH_SHOWN_KEY = 'crepair.walkthroughShown';

/**
 * Whether first activation should auto-open the walkthrough (V3c): only when
 * the one-time flag has never been recorded. Pure (the getter is injected) so
 * the first-run behaviour is unit tested.
 */
export function shouldOpenWalkthrough(get: (key: string) => unknown): boolean {
  return get(WALKTHROUGH_SHOWN_KEY) !== true;
}

/**
 * Every globalState one-time flag cleared by Reset Extension State. The flag
 * constants above are also imported by extension.ts for their write sites, so this
 * array and those writes cannot drift: adding a flag means adding it here, and the
 * unit test fails if a `crepair.*Acknowledged` key (or an exported *_KEY flag
 * constant defined in this module) is not listed.
 */
export const RESET_GLOBAL_STATE_KEYS: readonly string[] = [
  EXTERNAL_NOTICE_SHOWN_KEY,
  FREE_MODEL_NOTICE_SHOWN_KEY,
  MODEL_MODE_CHOSEN_KEY,
  WALKTHROUGH_SHOWN_KEY,
];
