// Pure mapping from C Repair model/provider settings to the CREPAIR_* env vars
// the bridge reads (D-019). Kept free of the `vscode` module so it is unit
// testable under plain Node, mirroring bridge/health.ts.
//
// Design (D-019, default-safe): when a setting still holds its verified default
// we DO NOT emit its env var, so the bridge falls back to its bundled config —
// guaranteeing the effective config is bit-identical to today's behaviour when
// the user changes nothing. Only a value that differs from the default is
// forwarded as an override. The one nuance is providerOrder: an empty array is
// a *deliberate* choice (OpenRouter automatic routing), distinct from the
// default ["DeepInfra"], so it is emitted as CREPAIR_PROVIDER_ORDER="".
//
// Model mode (D-031): `crepair.modelMode` is the single source of truth for the
// model/provider construction. It selects HOW the model/provider env is built:
//   - `default` — emit NO model/provider env (bundled default). `crepair.model`
//     and `crepair.providerOrder` are IGNORED (they only apply in `custom`).
//   - `free`    — pin `crepair.freeModel` + automatic routing (empty provider).
//   - `custom`  — the legacy per-setting mapping (model/providerOrder/allowFallbacks).
// The reasoning effort and configPath are orthogonal to the mode and applied in
// every mode; see buildModeOverrideEnv.

/** The model/provider/reasoning settings, already read from configuration. */
export interface OverrideSettings {
  /** `crepair.model` — OpenRouter model id. */
  model: string;
  /** `crepair.providerOrder` — provider pin; [] = automatic routing. */
  providerOrder: string[];
  /** `crepair.allowFallbacks`. */
  allowFallbacks: boolean;
  /** `crepair.bridge.configPath` — full escape hatch; '' = bundled config. */
  configPath: string;
  /** `crepair.reasoningEffort` — one of max|xhigh|high|medium|low|minimal|off (D-028). */
  reasoningEffort: string;
  /**
   * `crepair.providerPolicy` — automatic OpenRouter provider-preference profile that
   * applies ONLY in custom mode when `providerOrder` is empty (D-019 follow-up):
   *   - `private-cheap` — `{"zdr": true, "sort": "price", "allow_fallbacks": true}`:
   *     Zero-Data-Retention providers only, cheapest first (latency is OpenRouter's
   *     same-tier tie-break). This is the default.
   *   - `balanced` — no provider preference (OpenRouter default routing).
   * An explicit `providerOrder` always wins: when the order is non-empty this policy
   * is not emitted at all (the pin owns routing).
   */
  providerPolicy: ProviderPolicy;
}

/** The `crepair.providerPolicy` values (D-019 follow-up). */
export type ProviderPolicy = 'private-cheap' | 'balanced';

/** The default provider policy (must match package.json `crepair.providerPolicy`). */
export const DEFAULT_PROVIDER_POLICY: ProviderPolicy = 'private-cheap';

/** Normalize an arbitrary string to a valid ProviderPolicy, defaulting on anything else. */
export function normalizeProviderPolicy(value: string | undefined): ProviderPolicy {
  return value === 'balanced' || value === 'private-cheap' ? value : DEFAULT_PROVIDER_POLICY;
}

/** The verified defaults (must match package.json contributes.configuration). */
export const DEFAULT_OVERRIDES: OverrideSettings = {
  model: 'deepseek/deepseek-v4-flash-0731',
  providerOrder: ['DeepInfra'],
  allowFallbacks: false,
  configPath: '',
  reasoningEffort: 'xhigh',
  providerPolicy: DEFAULT_PROVIDER_POLICY,
};

/**
 * The model mode (D-031): the single source of truth for the model/provider
 * construction, from `crepair.modelMode`.
 *   - `default` — the bundled verified model (usage-based); model/provider settings ignored.
 *   - `free`    — the free model (`crepair.freeModel`, $0) with automatic routing.
 *   - `custom`  — use the `crepair.model` / providerOrder / allowFallbacks settings verbatim.
 */
export type ModelMode = 'default' | 'free' | 'custom';

/** The default model mode (must match package.json `crepair.modelMode`). */
export const DEFAULT_MODEL_MODE: ModelMode = 'default';

/**
 * D-038: the user-visible DISPLAY name for the internal `default` mode. The stored
 * enum value stays `'default'` (compat, D-037-style display/ID separation), because
 * the bundled model is only the preset of the CURRENT release and may change in
 * future releases — "default" would read as permanent.
 *
 * This single constant is the ONE place the name lives. Every display surface
 * derives from it (header mode tag, notices, the model-mode QuickPick), and the
 * branding guard asserts package.json's `enumItemLabels[0]` (a static string)
 * equals it.
 */
export const DEFAULT_MODE_LABEL = 'Preset';
/** The lowercase form for running text (e.g. "the preset model", "mode: preset"). */
export const DEFAULT_MODE_LABEL_LOWER = DEFAULT_MODE_LABEL.toLowerCase();

/**
 * The display form of a model mode (D-038): `default` renders as the display label
 * (lowercase for running text); `free` / `custom` render as themselves.
 */
export function modeDisplayLower(mode: ModelMode): string {
  return mode === 'default' ? DEFAULT_MODE_LABEL_LOWER : mode;
}

/** Normalize an arbitrary string to a valid ModelMode, defaulting on anything else. */
export function normalizeModelMode(value: string | undefined): ModelMode {
  return value === 'free' || value === 'custom' || value === 'default'
    ? value
    : DEFAULT_MODEL_MODE;
}

/** The CREPAIR_* env var names (mirrored by repair_api.config_override). */
export const ENV_MODEL_ID = 'CREPAIR_MODEL_ID';
export const ENV_PROVIDER_ORDER = 'CREPAIR_PROVIDER_ORDER';
export const ENV_ALLOW_FALLBACKS = 'CREPAIR_ALLOW_FALLBACKS';
export const ENV_CONFIG_PATH = 'CREPAIR_CONFIG_PATH';
export const ENV_REASONING_EFFORT = 'CREPAIR_REASONING_EFFORT';
export const ENV_PROVIDER_POLICY = 'CREPAIR_PROVIDER_POLICY';

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Build the override env fragment from settings. Returns only the vars that
 * differ from the verified defaults (empty object when nothing changed), so a
 * default configuration spawns the bridge with no CREPAIR_* override and the
 * effective config stays bit-identical to the bundled one (D-019).
 *
 * providerOrder is normalized (trim, drop blanks). An empty (or all-blank)
 * array emits `CREPAIR_PROVIDER_ORDER=""` — the explicit "remove the pin"
 * signal — because that differs from the default pin.
 */
export function buildOverrideEnv(
  settings: OverrideSettings,
): Record<string, string> {
  const env: Record<string, string> = {};

  const model = settings.model.trim();
  if (model && model !== DEFAULT_OVERRIDES.model) {
    env[ENV_MODEL_ID] = model;
  }

  const order = settings.providerOrder.map((p) => p.trim()).filter((p) => p.length > 0);
  if (!sameStringArray(order, DEFAULT_OVERRIDES.providerOrder)) {
    // Empty array => "" (automatic routing); otherwise the comma-joined list.
    env[ENV_PROVIDER_ORDER] = order.join(',');
  }

  // Provider policy (D-019 follow-up): an automatic provider-preference profile that
  // applies ONLY when there is no explicit pin (order empty). An explicit providerOrder
  // always wins, so the policy is not forwarded while a pin is set — the bridge keeps
  // the same order-over-policy precedence. This is emitted regardless of whether the
  // policy differs from the default, because the bridge only sees it when the order is
  // empty (a deliberate "let OpenRouter route" choice), so there is no bit-identical
  // concern: an empty order already emits CREPAIR_PROVIDER_ORDER="".
  if (order.length === 0) {
    env[ENV_PROVIDER_POLICY] = settings.providerPolicy;
  }

  if (settings.allowFallbacks !== DEFAULT_OVERRIDES.allowFallbacks) {
    env[ENV_ALLOW_FALLBACKS] = settings.allowFallbacks ? 'true' : 'false';
  }

  const configPath = settings.configPath.trim();
  if (configPath && configPath !== DEFAULT_OVERRIDES.configPath) {
    env[ENV_CONFIG_PATH] = configPath;
  }

  // Reasoning effort (D-028): emit only when it differs from the default so a
  // default configuration passes no override (bit-identical to bundled). The
  // bridge validates the value; a blank setting falls back to the default.
  const reasoningEffort = settings.reasoningEffort.trim();
  if (reasoningEffort && reasoningEffort !== DEFAULT_OVERRIDES.reasoningEffort) {
    env[ENV_REASONING_EFFORT] = reasoningEffort;
  }

  return env;
}

/**
 * Build the free-model override env fragment (B, free-model auto-run): pin the
 * model to `freeModel` and REMOVE the provider pin (`CREPAIR_PROVIDER_ORDER=""`)
 * so OpenRouter routes automatically. The DeepInfra pin cannot serve `:free`
 * models, so free runs MUST use automatic routing (Fable5 실측). These two vars are
 * applied ON TOP of `buildOverrideEnv`, overriding the config-derived model /
 * provider while leaving allowFallbacks / configPath / reasoningEffort intact.
 */
export function buildFreeModelEnv(freeModel: string): Record<string, string> {
  return {
    [ENV_MODEL_ID]: freeModel.trim(),
    [ENV_PROVIDER_ORDER]: '', // automatic routing — DeepInfra pin is invalid for :free
  };
}

/**
 * The mode-independent env fragment (D-031): the overrides that apply in EVERY
 * model mode. These are orthogonal to the model/provider choice:
 *   - reasoningEffort (D-028): the fix-role reasoning budget.
 *   - configPath: the advanced escape hatch to a full custom certfix config.
 * Each is emitted only when it differs from the verified default (default-safe).
 */
function buildCommonEnv(settings: OverrideSettings): Record<string, string> {
  const env: Record<string, string> = {};

  const configPath = settings.configPath.trim();
  if (configPath && configPath !== DEFAULT_OVERRIDES.configPath) {
    env[ENV_CONFIG_PATH] = configPath;
  }

  const reasoningEffort = settings.reasoningEffort.trim();
  if (reasoningEffort && reasoningEffort !== DEFAULT_OVERRIDES.reasoningEffort) {
    env[ENV_REASONING_EFFORT] = reasoningEffort;
  }

  return env;
}

/**
 * Build the model/provider override env for a given model mode (D-031). The mode
 * is the single source of truth for the model/provider construction:
 *
 *   - `default` — emit NO model/provider env: the bridge uses its bundled verified
 *     model (usage-based). `crepair.model` / `crepair.providerOrder` /
 *     `crepair.allowFallbacks` are IGNORED (they only apply in `custom`). The result
 *     is bit-identical to today's default (only the common reasoning/configPath vars
 *     are ever added on top).
 *   - `free` — pin `CREPAIR_MODEL_ID=<freeModel>` + `CREPAIR_PROVIDER_ORDER=""`
 *     (automatic routing; the DeepInfra pin cannot serve `:free` models).
 *   - `custom` — the legacy per-setting mapping (buildOverrideEnv): model /
 *     providerOrder / allowFallbacks are forwarded when they differ from the default.
 *
 * The common (mode-independent) reasoningEffort + configPath overrides are applied
 * in every mode. `buildOverrideEnv` (custom) already includes them, so they are not
 * double-added there.
 */
export function buildModeOverrideEnv(
  mode: ModelMode,
  settings: OverrideSettings,
  freeModel: string,
): Record<string, string> {
  if (mode === 'custom') {
    // Legacy per-setting mapping already covers the common vars.
    return buildOverrideEnv(settings);
  }
  const env = buildCommonEnv(settings);
  if (mode === 'free') {
    Object.assign(env, buildFreeModelEnv(freeModel));
  }
  // `default`: model/provider left to the bundled config (nothing added here).
  return env;
}

/**
 * Whether the user has explicitly set `crepair.model` to a non-default value. When
 * true the free-model auto-switch must NOT override the model (explicit choice
 * wins — B); we only warn and run their model. A blank or default value means the
 * user left the model at the verified default, so the free switch may take over.
 */
export function hasExplicitModel(model: string): boolean {
  const m = model.trim();
  return m.length > 0 && m !== DEFAULT_OVERRIDES.model;
}

/** The free-model switch decision (B), a pure function of the current state. */
export type FreeSwitchDecision =
  /** Run the free model now: (re)start the bridge with the free env if needed. */
  | { kind: 'switch-to-free' }
  /** Return to the normal (config) construction: credits present but bridge is on free. */
  | { kind: 'revert-to-normal' }
  /** Nothing to do: no key, unknown tier, explicit model, or already in the right mode. */
  | { kind: 'none' };

/** Inputs to `decideFreeSwitch` — all already resolved by the caller. */
export interface FreeSwitchInputs {
  /**
   * The current model mode (D-031). The creditless auto-fallback is a `default`-mode
   * convenience only: in `free` mode the user already runs the free model, and in
   * `custom` mode they own the construction — both skip the automatic switch entirely
   * (decideFreeSwitch returns `none`, leaving the mode's own construction in place).
   */
  mode: ModelMode;
  /** Whether a BYOK key is present (no key => never switch). */
  hasApiKey: boolean;
  /**
   * The key's free-tier flag from `GET /key` (true / false / null=unknown). Only an
   * explicit `true` triggers the free model; null (couldn't read) leaves things as-is.
   */
  isFreeTier: boolean | null;
  /** Whether the user explicitly set a non-default `crepair.model` (their choice wins). */
  explicitModel: boolean;
  /** Whether the bridge is currently running in the free construction. */
  bridgeOnFree: boolean;
}

/**
 * Decide, at scan start, whether to switch the bridge to the free model, revert it
 * to the normal construction, or do nothing (B). Pure so it is unit-tested without a
 * host.
 *
 * - No key -> nothing (the scan flow already prompts for a key).
 * - Explicit non-default `crepair.model` -> never override the model. We still may
 *   want the caller to warn, but the *construction* is left to the user's settings,
 *   so this returns `revert-to-normal` when the bridge is stuck on free (e.g. from a
 *   prior key) and `none` otherwise. The warning is handled by the caller.
 * - is_free_tier === true (and no explicit model): switch to free when not already
 *   there; otherwise nothing.
 * - is_free_tier === false: revert to normal when the bridge is on free; otherwise
 *   nothing (credits present, already normal).
 * - is_free_tier === null (unknown): revert to normal if currently on free (defensive
 *   — do not keep degrading quality on an unreadable flag); otherwise nothing.
 *
 * The creditless auto-fallback is scoped to `default` mode (D-031): only there is
 * the automatic switch a helpful convenience. In `free` mode the user has already
 * opted into the free model (the env pins it directly), and in `custom` mode the
 * user owns the construction — both return `none` so this mechanism never overrides
 * the mode-selected env. The `setFreeModel` respawn machinery is retained, but it is
 * only ever armed while the mode is `default`.
 */
export function decideFreeSwitch(inputs: FreeSwitchInputs): FreeSwitchDecision {
  if (!inputs.hasApiKey) return { kind: 'none' };

  // Only default mode participates in the creditless auto-fallback. free/custom
  // own their construction via modelMode, so leave them untouched here — but if a
  // prior default-mode session left the bridge stuck on free, revert it so switching
  // TO free/custom mode does not inherit a stale free construction.
  if (inputs.mode !== 'default') {
    return inputs.bridgeOnFree ? { kind: 'revert-to-normal' } : { kind: 'none' };
  }

  if (inputs.explicitModel) {
    // The user's model wins. Only correct the construction if we're wrongly on free.
    return inputs.bridgeOnFree ? { kind: 'revert-to-normal' } : { kind: 'none' };
  }

  if (inputs.isFreeTier === true) {
    return inputs.bridgeOnFree ? { kind: 'none' } : { kind: 'switch-to-free' };
  }

  // false or null (unknown): the free model is only ever kept while is_free_tier is
  // explicitly true, so anything else reverts a bridge that is currently on free.
  return inputs.bridgeOnFree ? { kind: 'revert-to-normal' } : { kind: 'none' };
}
