// Pure (VS Code API independent) helpers for the /health handshake: parsing the
// response, checking the contract_version, and testing the harness version
// against the pinned range. Kept free of the `vscode` module so it is unit
// testable under plain Node (VSCODE_V1B_DESIGN.md §7).

/** The contract_version this extension speaks (CONTRACT.md §1). */
export const EXPECTED_CONTRACT_VERSION = '1';

/**
 * Pinned harness minor line (VSCODE_PIVOT_PLAN §3 / D-017b): `0.4.x`. A version
 * outside this range is a warning, not a fatal — the extension continues.
 */
export const HARNESS_PIN = { major: 0, minor: 4 } as const;

export interface IdVersion {
  id: string;
  version: string;
}

export interface HealthCapabilities {
  rule_profile: string;
  rules_count: number;
  gates: string[];
  routes: string[];
  // Effective LLM identity (D-019). Optional for defensive back-compat: an older
  // bridge without these fields still parses. `provider_order` [] = OpenRouter
  // automatic routing.
  model?: string;
  provider_order?: string[];
  // Effective reasoning effort (D-028/D-029). Optional for the same back-compat
  // reason. This is the FIX role's effective value (repair + validation), which is
  // what crepair.reasoningEffort controls: "max"/"xhigh"/"high"/"medium"/"low"/
  // "minimal", "off" (disabled), or "default" (unconfigured).
  reasoning_effort?: string;
  // Effective detection-role reasoning (D-029). Optional / defensive: detection
  // reasoning is fixed off and independent of reasoning_effort. Present on newer
  // bridges only; parsed when well-typed, otherwise ignored.
  detection_reasoning?: string;
  // Effective provider policy (D-019 follow-up): "private-cheap" / "balanced" when a
  // recognized policy took effect (custom mode, empty order), or "none" otherwise.
  // Optional / defensive back-compat: older bridges omit it.
  provider_policy?: string;
}

export interface HealthResponse {
  status: string;
  harness: IdVersion;
  adapter: IdVersion;
  contract_version: string;
  capabilities: HealthCapabilities;
}

export type HealthCompat =
  | { ok: true; harnessInPin: boolean; health: HealthResponse }
  | { ok: false; reason: string };

/**
 * Validate the shape of a parsed /health body. Returns the typed response or
 * null when a required field is missing/wrong-typed (defensive — the bridge is
 * trusted but we never crash the extension on a malformed reply).
 */
export function parseHealth(body: unknown): HealthResponse | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.status !== 'string') return null;
  if (typeof b.contract_version !== 'string') return null;
  const harness = parseIdVersion(b.harness);
  const adapter = parseIdVersion(b.adapter);
  if (!harness || !adapter) return null;
  const capabilities = parseCapabilities(b.capabilities);
  if (!capabilities) return null;
  return {
    status: b.status,
    harness,
    adapter,
    contract_version: b.contract_version,
    capabilities,
  };
}

function parseIdVersion(v: unknown): IdVersion | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.version !== 'string') return null;
  return { id: o.id, version: o.version };
}

function parseCapabilities(v: unknown): HealthCapabilities | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.rule_profile !== 'string') return null;
  if (typeof o.rules_count !== 'number') return null;
  if (!isStringArray(o.gates) || !isStringArray(o.routes)) return null;
  const caps: HealthCapabilities = {
    rule_profile: o.rule_profile,
    rules_count: o.rules_count,
    gates: o.gates,
    routes: o.routes,
  };
  // D-019 effective identity: accepted when present + well-typed; absence is not
  // an error (older bridge).
  if (typeof o.model === 'string') caps.model = o.model;
  if (isStringArray(o.provider_order)) caps.provider_order = o.provider_order;
  // D-028 effective reasoning effort: same defensive back-compat handling.
  if (typeof o.reasoning_effort === 'string') caps.reasoning_effort = o.reasoning_effort;
  // D-029 effective detection reasoning: optional, defensive parse (older bridges omit it).
  if (typeof o.detection_reasoning === 'string') caps.detection_reasoning = o.detection_reasoning;
  // D-019 follow-up effective provider policy: optional, defensive parse.
  if (typeof o.provider_policy === 'string') caps.provider_policy = o.provider_policy;
  return caps;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * True when `version` (e.g. "0.4.1") falls inside the pinned `0.4.x` range.
 * Only the leading `major.minor` are compared; patch and any pre-release suffix
 * are ignored. Non-numeric / malformed versions are treated as out of range.
 */
export function isHarnessInPin(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  return Number(m[1]) === HARNESS_PIN.major && Number(m[2]) === HARNESS_PIN.minor;
}

/**
 * Decide compatibility from a parsed /health body:
 * - contract_version mismatch => fatal (ok:false).
 * - harness version outside the pin => ok:true with harnessInPin:false (caller
 *   surfaces a warning and continues, D-017b).
 */
export function checkHealthCompat(body: unknown): HealthCompat {
  const health = parseHealth(body);
  if (!health) {
    return { ok: false, reason: 'The bridge /health response was malformed.' };
  }
  if (health.contract_version !== EXPECTED_CONTRACT_VERSION) {
    return {
      ok: false,
      reason:
        `contract_version mismatch: the bridge speaks "${health.contract_version}" but this ` +
        `extension requires "${EXPECTED_CONTRACT_VERSION}". Update the extension or the harness bridge.`,
    };
  }
  return { ok: true, harnessInPin: isHarnessInPin(health.harness.version), health };
}

/** Human-readable pin descriptor for warning messages, e.g. "0.4.x". */
export function harnessPinLabel(): string {
  return `${HARNESS_PIN.major}.${HARNESS_PIN.minor}.x`;
}

/**
 * Human-readable effective provider description (D-019). An empty / missing
 * provider order means OpenRouter routes automatically; a pinned order is joined
 * with " → " to show the routing preference.
 */
export function effectiveProviderLabel(caps: HealthCapabilities | undefined): string {
  const order = caps?.provider_order ?? [];
  if (order.length === 0) return 'OpenRouter automatic routing';
  return order.join(' → ');
}

/** Effective model id for display, or a fallback when the bridge omitted it. */
export function effectiveModelLabel(caps: HealthCapabilities | undefined): string {
  const model = caps?.model?.trim();
  return model && model.length > 0 ? model : 'unknown';
}

/**
 * Human-readable effective reasoning effort (D-028), or null when the bridge did
 * not report it (older bridge) so callers can omit the tooltip line entirely.
 * "off" renders as "disabled"; "default" renders as "config default"; a level
 * ("xhigh" etc.) renders verbatim.
 */
export function effectiveReasoningLabel(caps: HealthCapabilities | undefined): string | null {
  const effort = caps?.reasoning_effort?.trim();
  if (!effort) return null;
  if (effort === 'off') return 'disabled';
  if (effort === 'default') return 'config default';
  return effort;
}
