// Size-scaled request timeouts for the bridge scan / repair calls.
//
// Background: the -0731 model accepts max_completion_tokens up to 384k, so a large
// file's repair is admitted within the model's ceiling and its generation can run
// for minutes to tens of minutes. A fixed 300s repair timeout (the pre-existing
// REPAIR_TIMEOUT_MS) then becomes the *effective* cap and aborts a legitimate
// large-file generation. These pure functions scale the client-side timeout with
// the source size so the timeout tracks the expected generation time instead of
// capping it, while a hard ceiling still bounds a runaway.
//
// All functions are pure (no vscode, no I/O) so they unit-test directly.

/**
 * Characters of C source per output token. Empirical rule of thumb for C: ~3.5
 * chars/token (denser than prose because of punctuation / short identifiers).
 * Used to convert a source-character count into an estimated *output* token count.
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * Growth factor applied to the input-derived token estimate. A repair rewrites the
 * whole file and usually grows it (added guards / declarations / braces), so the
 * output is modeled as ~1.3x the input's token count before the fixed reasoning /
 * scaffolding allowance below.
 */
const OUTPUT_GROWTH_FACTOR = 1.3;

/**
 * A fixed token allowance added on top of the size-derived estimate to cover the
 * model's reasoning tokens + boilerplate that does not scale with file size (fence
 * markers, a short preamble, etc.). Mirrors the 4096 scaffolding budget the bridge
 * uses when sizing max_completion_tokens.
 */
const FIXED_TOKEN_ALLOWANCE = 4096;

/**
 * Assumed sustained generation throughput, tokens/second. A conservative floor for
 * OpenRouter-routed providers under load (real throughput is usually higher, which
 * only leaves extra headroom). Lower = more generous timeout.
 */
const TOKENS_PER_SECOND = 40;

/**
 * Safety multiplier on the modeled generation time to absorb queueing, provider
 * warm-up, validation gates and throughput dips before the client gives up.
 */
const SAFETY_MARGIN = 1.5;

/** Base (minimum) repair timeout — the pre-existing 300s floor for small files. */
const REPAIR_BASE_MS = 300_000;
/** Hard ceiling for a repair timeout: 30 minutes. Bounds a runaway generation. */
const REPAIR_CEILING_MS = 1_800_000;

/** Base (minimum) scan timeout — the pre-existing 180s floor for small files. */
const SCAN_BASE_MS = 180_000;
/** Hard ceiling for a scan timeout: 15 minutes. */
const SCAN_CEILING_MS = 900_000;

/**
 * Fraction of the repair model's per-char cost a scan incurs. Scanning runs
 * detection (short, bounded outputs per function chunk) rather than whole-file
 * generation, so it scales with size far more gently than repair — modeled here as
 * ~30% of the repair size-term.
 */
const SCAN_SIZE_FACTOR = 0.3;

/**
 * Estimated number of output tokens a repair of `contentChars` source will emit.
 *
 * `chars / CHARS_PER_TOKEN` is the input token count; `* OUTPUT_GROWTH_FACTOR`
 * models the fix growing the file; `+ FIXED_TOKEN_ALLOWANCE` adds the size-
 * independent reasoning / scaffolding budget. Used both to size the repair timeout
 * and to drive the "large file" pre-warning (task C). Never negative.
 */
export function estimatedOutputTokens(contentChars: number): number {
  const chars = Math.max(0, contentChars);
  return (chars / CHARS_PER_TOKEN) * OUTPUT_GROWTH_FACTOR + FIXED_TOKEN_ALLOWANCE;
}

/**
 * The client-side timeout (ms) for a /repair call over `contentChars` of source.
 *
 * Model: estimatedOutputTokens / TOKENS_PER_SECOND seconds of generation, times a
 * SAFETY_MARGIN, converted to ms; then clamped into [REPAIR_BASE_MS, REPAIR_CEILING_MS].
 * Small files stay at the 300s base; large files scale up to a 30-minute ceiling so
 * a legitimate long generation is not aborted by the client while the ceiling still
 * bounds a runaway.
 */
export function repairTimeoutMs(contentChars: number): number {
  const genSeconds = (estimatedOutputTokens(contentChars) / TOKENS_PER_SECOND) * SAFETY_MARGIN;
  const scaledMs = genSeconds * 1000;
  return clamp(scaledMs, REPAIR_BASE_MS, REPAIR_CEILING_MS);
}

/**
 * The client-side timeout (ms) for a /scan call over `contentChars` of source.
 *
 * Scanning does not generate a whole file, so it scales gently: SCAN_BASE_MS plus
 * SCAN_SIZE_FACTOR of the repair size-term (the generation-time portion, excluding
 * the fixed allowance), clamped into [SCAN_BASE_MS, SCAN_CEILING_MS].
 */
export function scanTimeoutMs(contentChars: number): number {
  const chars = Math.max(0, contentChars);
  const sizeTokens = (chars / CHARS_PER_TOKEN) * OUTPUT_GROWTH_FACTOR;
  const sizeSeconds = (sizeTokens / TOKENS_PER_SECOND) * SAFETY_MARGIN * SCAN_SIZE_FACTOR;
  const scaledMs = SCAN_BASE_MS + sizeSeconds * 1000;
  return clamp(scaledMs, SCAN_BASE_MS, SCAN_CEILING_MS);
}

/**
 * Output-token count above which a repair is expected to take "several minutes" and
 * the progress UI should carry a heads-up (task C). ~12k tokens at the modeled
 * throughput is on the order of minutes of generation.
 */
export const LARGE_FILE_OUTPUT_TOKENS = 12_000;

/**
 * Whether a repair over `contentChars` is expected to be slow enough to warrant the
 * "large file — may take several minutes" progress note (task C). Display-only; it
 * never blocks the repair.
 */
export function isLargeRepair(contentChars: number): boolean {
  return estimatedOutputTokens(contentChars) > LARGE_FILE_OUTPUT_TOKENS;
}

/** Clamp `value` into the inclusive [min, max] range, rounded to a whole ms. */
function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}
