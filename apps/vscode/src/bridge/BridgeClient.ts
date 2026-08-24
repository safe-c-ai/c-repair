// HTTP client for the repair-api bridge. Request / response bodies are the
// snake_case contract JSON, verbatim, exactly as the web HttpClient.ts sends
// them (services/repair-api/src/repair_api/schemas.py). Every request carries
// `Authorization: Bearer <token>` (VSCODE_PIVOT_PLAN §3 补正4).
//
// SECURITY: the Bearer token and any API key are NEVER logged here. Errors are
// summarized without source content — callers may surface hashes / counts only.

import type {
  SourceDocument,
  ContextAugmentationSet,
  FunctionScanResult,
  Finding,
  RepairCandidate,
} from '@c-repair/contract';
import type { HealthResponse } from './health';
import { repairTimeoutMs, scanTimeoutMs } from './repairTimeout';

// Timeouts (VSCODE_V1B_DESIGN §2, HttpClient.ts §4): health / infer / confirm are
// fast -> 30s. Scan and repair are LLM-bound and now SIZE-SCALED (repairTimeout.ts):
// the -0731 model admits huge files (max_completion_tokens 384k) whose generation
// runs for minutes to tens of minutes, so a fixed 300s repair cap would abort a
// legitimate large-file generation. repairTimeoutMs / scanTimeoutMs derive the
// timeout from the source size (300s / 180s floors, 30min / 15min ceilings).
const DEFAULT_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

export class BridgeHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BridgeHttpError';
  }
}

/**
 * Response of POST /context/check (V2b, design §1). Not a contract object (the 6
 * schemas are unchanged); it is an additive bridge-API envelope used by the Review
 * UX to show "context compiles ✓ / still missing: X" before scanning.
 */
export interface CheckContextResponse {
  compiles: boolean;
  missing_symbols: string[];
}

/**
 * Response of GET /usage (D-030): the cumulative OpenRouter token usage the bridge
 * has metered since the last reset. Numbers only — the bridge records no prompt or
 * response content. Not a contract object; an additive bridge-API envelope used to
 * render the "Session: Xk in / Yk out" line above the C Repair TreeView.
 */
export interface UsageResponse {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  requests: number;
}

export class BridgeClient {
  private readonly baseUrl: string;

  /**
   * @param baseUrl e.g. "http://127.0.0.1:53113" (no trailing slash required).
   * @param token   the Bearer token; sent on every request. Never logged.
   */
  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.token}`,
    };
  }

  /** GET /health with the Bearer token. Short timeout (poll during handshake). */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health', undefined, HEALTH_TIMEOUT_MS);
  }

  /**
   * GET /usage (D-030): the cumulative OpenRouter token usage the bridge has metered
   * since the last reset. Fast (a counter read), so it shares the short health
   * timeout — it is polled while a scan / repair runs to drive the session token line.
   */
  async getUsage(): Promise<UsageResponse> {
    return this.request<UsageResponse>('GET', '/usage', undefined, HEALTH_TIMEOUT_MS);
  }

  /** POST /usage/reset (D-030): zero the token counters. Called at each scan start. */
  async resetUsage(): Promise<UsageResponse> {
    return this.request<UsageResponse>('POST', '/usage/reset', undefined, HEALTH_TIMEOUT_MS);
  }

  /**
   * POST /context/infer {source_document, compile_include_paths} ->
   * ContextAugmentationSet (draft). `compileIncludePaths` (D-020) is merged into
   * the compile config before probing the prelude-less Original, so symbols that
   * live in project headers are resolved and excluded from the inferred context.
   * Defaults to [].
   */
  async inferContext(
    source: SourceDocument,
    compileIncludePaths: string[] = [],
  ): Promise<ContextAugmentationSet> {
    return this.request<ContextAugmentationSet>(
      'POST',
      '/context/infer',
      { source_document: source, compile_include_paths: compileIncludePaths },
      DEFAULT_TIMEOUT_MS,
    );
  }

  /**
   * POST /context/check {source_document, context_augmentation_set,
   * compile_include_paths} -> {compiles, missing_symbols} (V2b, design §1).
   * Compose-probes the Augmented C so the Review UI can report whether the
   * confirmed context makes the baseline compile. The set need not be confirmed
   * (pre-confirm probe), but its original_hash must match the source (409 family).
   */
  async checkContext(
    source: SourceDocument,
    set: ContextAugmentationSet,
    compileIncludePaths: string[] = [],
  ): Promise<CheckContextResponse> {
    return this.request<CheckContextResponse>(
      'POST',
      '/context/check',
      {
        source_document: source,
        context_augmentation_set: set,
        compile_include_paths: compileIncludePaths,
      },
      DEFAULT_TIMEOUT_MS,
    );
  }

  /** POST /context/confirm {context_augmentation_set} -> ContextAugmentationSet. */
  async confirmContext(set: ContextAugmentationSet): Promise<ContextAugmentationSet> {
    return this.request<ContextAugmentationSet>(
      'POST',
      '/context/confirm',
      { context_augmentation_set: set },
      DEFAULT_TIMEOUT_MS,
    );
  }

  /**
   * POST /scan {source_document, context_augmentation_set, compile_include_paths}
   * -> FunctionScanResult. `compileIncludePaths` (D-020) is an additive bridge-API
   * field; scan does not run the compile gate, so the bridge accepts but ignores
   * it (sent for symmetry with /repair). Defaults to [].
   */
  async scan(
    source: SourceDocument,
    confirmedSet: ContextAugmentationSet,
    compileIncludePaths: string[] = [],
    signal?: AbortSignal,
  ): Promise<FunctionScanResult> {
    return this.request<FunctionScanResult>(
      'POST',
      '/scan',
      {
        source_document: source,
        context_augmentation_set: confirmedSet,
        compile_include_paths: compileIncludePaths,
      },
      // Size-scaled (repairTimeout.ts): 180s floor, up to a 15min ceiling for a very
      // large file, so scanning a big file is not cut off at the fixed 180s.
      scanTimeoutMs(source.content.length),
      signal,
    );
  }

  /**
   * POST /repair {source_document, context_augmentation_set, function_id, finding,
   * compile_include_paths} -> RepairCandidate. The bridge is stateless, so the
   * caller carries the finding back (its rule_id + location drive the repair).
   * `compileIncludePaths` (D-020) is merged into the compile config's `-I` paths
   * for the baseline pre-check + candidate compile gate. Defaults to []. Slow
   * (LLM + gates).
   */
  async repair(
    source: SourceDocument,
    confirmedSet: ContextAugmentationSet,
    functionId: string,
    finding: Finding,
    compileIncludePaths: string[] = [],
    signal?: AbortSignal,
  ): Promise<RepairCandidate> {
    return this.request<RepairCandidate>(
      'POST',
      '/repair',
      {
        source_document: source,
        context_augmentation_set: confirmedSet,
        function_id: functionId,
        finding,
        compile_include_paths: compileIncludePaths,
      },
      // Size-scaled (repairTimeout.ts): 300s floor, up to a 30min ceiling for a huge
      // file whose whole-file generation legitimately runs for many minutes.
      repairTimeoutMs(source.content.length),
      signal,
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    // Two abort sources drive one fetch: our internal timeout timer, and the
    // optional caller `signal` (user cancel from the progress UI / a Generate
    // command). When the caller aborts, the fetch aborts -> the bridge sees the
    // client disconnect and stops the in-flight LLM call (task A). We track whether
    // the CALLER aborted so the error is reported as a cancellation, not a timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let cancelledByCaller = false;
    const onExternalAbort = (): void => {
      cancelledByCaller = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let resp: Response;
    try {
      resp = await fetch(this.baseUrl + path, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Abort (caller cancel or timeout) or network failure. Never leak source
      // content; the message mentions only the path.
      if (err instanceof Error && err.name === 'AbortError') {
        if (cancelledByCaller) {
          // Caller-initiated cancellation: a dedicated marker so the UI can render a
          // plain "Cancelled." instead of an error (see isCancellation).
          throw new BridgeHttpError(`Request to ${path} was cancelled.`, CANCELLED_STATUS);
        }
        throw new BridgeHttpError(
          `Request to ${path} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            `Is the C Repair bridge responding?`,
        );
      }
      throw new BridgeHttpError(
        `Could not reach the C Repair bridge at ${this.baseUrl} (${path}). ` +
          `(${(err as Error).message})`,
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    if (!resp.ok) {
      throw await toHttpError(resp, path);
    }
    return (await resp.json()) as T;
  }
}

/**
 * Synthetic status carried by a BridgeHttpError when the caller aborted the request
 * (user cancel), as opposed to a real HTTP status or a timeout. Not a wire status —
 * it only distinguishes the cancellation path so the UI can show "Cancelled." rather
 * than an error. Mirrors the bridge's 499 "client closed request" abort code.
 */
export const CANCELLED_STATUS = 499;

/** Whether an error is a caller-initiated cancellation (user cancel), not a failure. */
export function isCancellation(err: unknown): boolean {
  return err instanceof BridgeHttpError && err.status === CANCELLED_STATUS;
}

/** Build a readable error from a non-2xx response. Never includes source text. */
async function toHttpError(resp: Response, path: string): Promise<BridgeHttpError> {
  const detail = await readDetail(resp);
  const suffix = detail ? `: ${detail}` : '';
  if (resp.status === 401) {
    return new BridgeHttpError(`Unauthorized (401) on ${path}${suffix}`, 401);
  }
  if (resp.status === 409) {
    return new BridgeHttpError(`Conflict (409) on ${path}${suffix}`, 409);
  }
  if (resp.status === 422) {
    return new BridgeHttpError(`Invalid request (422) on ${path}${suffix}`, 422);
  }
  if (resp.status >= 500) {
    return new BridgeHttpError(`Server error (${resp.status}) on ${path}${suffix}`, resp.status);
  }
  return new BridgeHttpError(`Request to ${path} failed (${resp.status})${suffix}`, resp.status);
}

/** Extract a FastAPI `detail` string from an error body, defensively. */
async function readDetail(resp: Response): Promise<string> {
  try {
    const data = (await resp.json()) as unknown;
    if (data && typeof data === 'object' && 'detail' in data) {
      const d = (data as { detail: unknown }).detail;
      return typeof d === 'string' ? d : JSON.stringify(d);
    }
    return '';
  } catch {
    return '';
  }
}
