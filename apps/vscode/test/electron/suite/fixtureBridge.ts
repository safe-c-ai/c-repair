// A deterministic, offline stand-in for the repair-api bridge, used by the
// integration suite (VSCODE_V1B_DESIGN §7). It answers the same contract routes
// the real FastAPI bridge does (services/repair-api/src/repair_api/main.py),
// but returns canned responses derived from the tests/fixtures sample_sensor
// data — NO python, NO LLM. The extension attaches to it via the
// CREPAIR_TEST_BRIDGE_URL hook in BridgeManager.
//
// The server echoes the caller's content_hash into every response so the
// extension's hash chain always matches the document it actually opened (the
// fixture JSON's fixed original_hash would not). Scan findings + repair hunks
// come from the fixtures verbatim so applyHunks lands on real line numbers.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The two violation findings from tests/fixtures/scan-results/sample_sensor.scan.json. */
const SCAN_FUNCTIONS = [
  {
    function_id: 'fn-scale-reading',
    name: 'scale_reading',
    original_range: { start_line: 4, end_line: 7 },
    findings: [
      {
        finding_id: 'find-scale-int32',
        kind: 'violation',
        rule_id: 'INT32-C',
        rule_summary: 'Ensure that operations on signed integers do not result in overflow.',
        explanation: 'raw * 1000 can overflow int for large values of raw.',
        location: { start_line: 5, end_line: 5 },
        assumption_dependent: false,
      },
    ],
  },
  {
    function_id: 'fn-copy-label',
    name: 'copy_label',
    original_range: { start_line: 25, end_line: 27 },
    findings: [
      {
        finding_id: 'find-copy-str31',
        kind: 'violation',
        rule_id: 'STR31-C',
        rule_summary:
          'Guarantee that storage for strings has sufficient space for the null terminator.',
        explanation: 'strcpy(dst, src) copies src without any bound on dst.',
        location: { start_line: 26, end_line: 26 },
        assumption_dependent: false,
      },
    ],
  },
];

/** Repair candidates keyed by function_id (hunks from the fixtures). */
const CANDIDATES: Record<string, { candidate_id: string; finding_id: string; hunks: unknown[] }> = {
  'fn-scale-reading': {
    candidate_id: 'cand-001',
    finding_id: 'find-scale-int32',
    hunks: [
      {
        hunk_id: 'hunk-scale-1',
        start_line: 5,
        line_count: 1,
        replacement_text:
          '    if (raw > INT_MAX / 1000 || raw < INT_MIN / 1000) {\n        return -1;\n    }\n    int scaled = raw * 1000;',
      },
    ],
  },
  'fn-copy-label': {
    candidate_id: 'cand-002',
    finding_id: 'find-copy-str31',
    hunks: [
      {
        hunk_id: 'hunk-copy-1',
        start_line: 26,
        line_count: 1,
        replacement_text: '    size_t n = strlen(src);\n    memcpy(dst, src, n + 1);',
      },
    ],
  },
};

const VALIDATIONS = [
  { name: 'parse', status: 'pass', detail: 'Augmented C parses without errors.' },
  { name: 'compile', status: 'pass', detail: 'Compiles against the confirmed context prelude.' },
  { name: 'behavior_check', status: 'skipped', detail: 'No behavioral oracle in fixtures.' },
];

/**
 * The judgment-gate reason surfaced by a semantic-fail candidate (D-023). Mirrors
 * a real certfix SemanticCheckResult.reason wired into the contract detail by the
 * bridge adapter. The integration suite asserts this text reaches the modal.
 */
const SEMANTIC_FAIL_REASON =
  'The fix changes behaviour for raw == 0: the added early-return alters the result.';

/**
 * Validations for a semantic-fail candidate (D-023): the MECHANICAL gates pass but
 * the JUDGMENT `semantic` gate fails with a reason detail. Yields the
 * `review_required` badge (Accept allowed with a warning), not `validation_failed`.
 */
const SEMANTIC_FAIL_VALIDATIONS = [
  { name: 'format', status: 'pass' },
  { name: 'compile', status: 'pass', detail: 'Compiles against the confirmed context prelude.' },
  { name: 'semantic', status: 'fail', detail: SEMANTIC_FAIL_REASON },
];

/**
 * Validations for an all-pass candidate: every gate passes (no fail, no skipped).
 * Used by the validation-CodeLens suite to prove the right pane shows the single
 * `✓ N/N validation gates passed` summary lens (not a per-gate concern lens).
 */
const ALL_PASS_VALIDATIONS = [
  { name: 'parse', status: 'pass', detail: 'Augmented C parses without errors.' },
  { name: 'compile', status: 'pass', detail: 'Compiles against the confirmed context prelude.' },
  { name: 'semantic', status: 'pass', detail: 'Behaviour preserved.' },
];

/**
 * Mutable repair mode (D-023). Default 'ready' preserves the pre-D-023 behaviour
 * (repair_ready candidate) so the existing integration tests are non-regressed.
 * The D-023 tests flip it to 'semantic-fail' via POST /__test__/repair-mode. A
 * per-mode counter lets Regenerate return a *different* candidate than the first
 * /repair so the suite can prove the candidate was replaced.
 */
let repairMode: 'ready' | 'semantic-fail' | 'dedupe-include' | 'all-pass' = 'ready';
let repairCallCount = 0;

/**
 * D-026 candidates: two independently-generated candidates that BOTH add
 * `#include <stdint.h>` via a PURE INSERTION hunk (line_count === 0) at DIFFERENT
 * anchor lines (line 1 vs line 4). Because the insertion anchors differ, the
 * range-based conflict guard (D-004) does not flag them, so accepting both would —
 * without the D-026 filter — insert the include twice. Each also carries its real
 * fix hunk so the candidate is a normal repair_ready one.
 */
const DEDUPE_CANDIDATES: Record<
  string,
  { candidate_id: string; finding_id: string; hunks: unknown[] }
> = {
  'fn-scale-reading': {
    candidate_id: 'cand-001',
    finding_id: 'find-scale-int32',
    hunks: [
      // Insert the include before line 1 (top of file).
      {
        hunk_id: 'hunk-scale-inc',
        start_line: 1,
        line_count: 0,
        replacement_text: '#include <stdint.h>',
      },
      {
        hunk_id: 'hunk-scale-1',
        start_line: 5,
        line_count: 1,
        replacement_text:
          '    if (raw > INT_MAX / 1000 || raw < INT_MIN / 1000) {\n        return -1;\n    }\n    int scaled = raw * 1000;',
      },
    ],
  },
  'fn-copy-label': {
    candidate_id: 'cand-002',
    finding_id: 'find-copy-str31',
    hunks: [
      // Insert the SAME include before line 4 (a different anchor) — this is the
      // anchor drift D-026 targets.
      {
        hunk_id: 'hunk-copy-inc',
        start_line: 4,
        line_count: 0,
        replacement_text: '#include <stdint.h>',
      },
      {
        hunk_id: 'hunk-copy-1',
        start_line: 26,
        line_count: 1,
        replacement_text: '    size_t n = strlen(src);\n    memcpy(dst, src, n + 1);',
      },
    ],
  },
};

/**
 * The two inferred augmentation items returned by /context/infer in "two-items"
 * mode (V2b Context Review integration). Shaped like the real V2a draft response:
 * DRAFT set, items unconfirmed, generated_text === current_text. The `over_threshold`
 * function in the fixture source uses `read_sensor` and `threshold`, so these are
 * the plausible external declarations a real infer would produce.
 */
const INFER_ITEMS = [
  {
    item_id: 'aug-1',
    kind: 'external_function_declaration',
    generated_text: 'int read_sensor(int channel);',
    current_text: 'int read_sensor(int channel);',
    provenance: 'llm_inferred',
    user_edited: false,
    confirmed: false,
    rationale: 'inferred from usage at line 21',
    usage_evidence: [{ line: 21, snippet: 'int v = read_sensor(0);' }],
  },
  {
    item_id: 'aug-2',
    kind: 'external_global',
    generated_text: 'extern int threshold;',
    current_text: 'extern int threshold;',
    provenance: 'llm_inferred',
    user_edited: false,
    confirmed: false,
    rationale: 'inferred from usage at line 22',
    usage_evidence: [{ line: 22, snippet: 'return v > threshold;' }],
  },
];

/**
 * Mutable infer mode (V2b). Default 'empty' preserves the pre-V2b behaviour so
 * the existing 5 integration tests are non-regressed (items 0 -> direct scan, no
 * Review). The Context Review tests flip it to 'two-items' via the control route
 * POST /__test__/infer-mode {"mode":"two-items"} before scanning.
 */
let inferMode: 'empty' | 'two-items' = 'empty';

/**
 * D-030: deterministic token metering. The real bridge meters OpenRouter response
 * usage via httpx; the fixture fakes it by adding a fixed number of tokens per
 * /scan and /repair call so the extension's `GET /usage` poll returns growing
 * counts and the TreeView `Session:` line becomes non-zero after a scan & fix.
 * `POST /usage/reset` zeroes it (the extension calls it at each scan start).
 */
const USAGE = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, requests: 0 };
const SCAN_USAGE = { prompt_tokens: 1500, completion_tokens: 300, reasoning_tokens: 0 };
const REPAIR_USAGE = { prompt_tokens: 4200, completion_tokens: 900, reasoning_tokens: 600 };

function addUsage(delta: { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number }): void {
  USAGE.prompt_tokens += delta.prompt_tokens;
  USAGE.completion_tokens += delta.completion_tokens;
  USAGE.reasoning_tokens += delta.reasoning_tokens;
  USAGE.requests += 1;
}

function resetUsage(): void {
  USAGE.prompt_tokens = 0;
  USAGE.completion_tokens = 0;
  USAGE.reasoning_tokens = 0;
  USAGE.requests = 0;
}

export interface FixtureBridge {
  url: string;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Start the fixture bridge on an ephemeral port. Returns its base URL + close(). */
export function startFixtureBridge(): Promise<FixtureBridge> {
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      const json = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(json);
    };
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/health') {
      send(200, {
        status: 'ok',
        harness: { id: 'certfix', version: '0.4.0' },
        adapter: { id: 'certfix-adapter', version: '0.4.0' },
        contract_version: '1',
        capabilities: {
          rule_profile: 'cert-c-fixture',
          rules_count: 3,
          gates: ['parse', 'compile'],
          routes: ['/scan', '/repair'],
          // D-019 effective identity (additive; the real bridge always sends these).
          model: 'fixture/deterministic',
          provider_order: ['FixtureProvider'],
          // D-028 effective reasoning effort (additive; real bridge always sends it).
          // This is the fix-role effective value (D-029).
          reasoning_effort: 'xhigh',
          // D-029 detection reasoning is fixed off, reported separately.
          detection_reasoning: 'off',
        },
      });
      return;
    }

    // D-030: cumulative token usage since the last reset (numbers only). GET has no
    // body, so answer it before readBody (like /health).
    if (req.method === 'GET' && url === '/usage') {
      send(200, { ...USAGE });
      return;
    }

    const body = await readBody(req);

    // D-030: zero the token counters (the extension calls this at each scan start).
    if (req.method === 'POST' && url === '/usage/reset') {
      resetUsage();
      send(200, { ...USAGE });
      return;
    }

    // TEST-ONLY control route (V2b): the integration suite (running in the
    // Extension Host, which has CREPAIR_TEST_BRIDGE_URL) flips the infer mode so
    // one shared bridge serves both the items-0 (legacy) and items-2 (Review)
    // scenarios deterministically. Not a bridge-contract route.
    if (req.method === 'POST' && url === '/__test__/infer-mode') {
      inferMode = body.mode === 'two-items' ? 'two-items' : 'empty';
      send(200, { mode: inferMode });
      return;
    }

    // TEST-ONLY control route (D-023): flip the repair mode so /repair returns a
    // semantic-fail candidate (judgment gate fail with a reason) instead of the
    // default repair_ready one. Resets the per-mode call counter so Regenerate can
    // be told apart from the first /repair. Not a bridge-contract route.
    if (req.method === 'POST' && url === '/__test__/repair-mode') {
      if (body.mode === 'semantic-fail') repairMode = 'semantic-fail';
      else if (body.mode === 'dedupe-include') repairMode = 'dedupe-include';
      else if (body.mode === 'all-pass') repairMode = 'all-pass';
      else repairMode = 'ready';
      repairCallCount = 0;
      send(200, { mode: repairMode });
      return;
    }

    // D-020 non-regression: /scan and /repair must carry a well-formed
    // `compile_include_paths` (array of strings). The extension sends the scanned
    // file's directory (auto) + any configured paths; here it is the temp dir the
    // integration suite opened. Reject a malformed / absent field so a regression
    // (extension no longer sending it) fails the flow instead of passing silently.
    if (req.method === 'POST' && (url === '/scan' || url === '/repair')) {
      const paths = body.compile_include_paths;
      const wellFormed = Array.isArray(paths) && paths.every((p: unknown) => typeof p === 'string');
      if (!wellFormed) {
        send(400, { detail: 'compile_include_paths must be an array of strings (D-020)' });
        return;
      }
      // The suite opens a real file with default settings (autoIncludeFileDir on),
      // so at least the file's own directory must be present.
      if (paths.length === 0) {
        send(400, { detail: 'compile_include_paths was empty (expected the file directory)' });
        return;
      }
    }

    if (req.method === 'POST' && url === '/context/infer') {
      const src = body.source_document;
      const items = inferMode === 'two-items' ? INFER_ITEMS : [];
      send(200, {
        set_id: 'augset-' + src.source_id,
        source_id: src.source_id,
        original_hash: src.content_hash,
        status: 'draft',
        context_revision_id: null,
        prelude_line_count: items.length > 0 ? 6 : 4,
        items,
      });
      return;
    }

    // /context/check (V2b): the composed Augmented C compiles once the inferred
    // declarations are confirmed. The fixture always answers compiles=true so the
    // Review flow reaches "context compiles ✓ — scanning".
    if (req.method === 'POST' && url === '/context/check') {
      send(200, { compiles: true, missing_symbols: [] });
      return;
    }

    if (req.method === 'POST' && url === '/context/confirm') {
      const s = body.context_augmentation_set;
      send(200, {
        set_id: s.set_id,
        source_id: s.source_id,
        original_hash: s.original_hash,
        status: 'confirmed',
        context_revision_id: 'ctxrev-test-1',
        prelude_line_count: s.prelude_line_count,
        items: s.items,
      });
      return;
    }

    if (req.method === 'POST' && url === '/scan') {
      const src = body.source_document;
      addUsage(SCAN_USAGE); // D-030: meter the scan's LLM tokens
      send(200, {
        scan_id: 'scan-test-1',
        source_id: src.source_id,
        original_hash: src.content_hash,
        context_revision_id: 'ctxrev-test-1',
        rule_profile: { id: 'cert-c-fixture', version: '0.1.0' },
        adapter: { id: 'fixture', version: '0.1.0' },
        harness: { id: 'fixture', version: '0.4.0' },
        functions: SCAN_FUNCTIONS,
      });
      return;
    }

    if (req.method === 'POST' && url === '/repair') {
      const src = body.source_document;
      const functionId: string = body.function_id;
      const finding = body.finding;
      const c = CANDIDATES[functionId];
      if (!c) {
        send(422, { detail: 'no fixture candidate for function ' + functionId });
        return;
      }
      repairCallCount += 1;
      addUsage(REPAIR_USAGE); // D-030: meter the repair's LLM tokens
      const base = {
        candidate_id: c.candidate_id,
        finding_id: finding?.finding_id ?? c.finding_id,
        function_id: functionId,
        source_id: src.source_id,
        original_hash: src.content_hash,
        context_revision_id: 'ctxrev-test-1',
        model_identity: 'fixture/deterministic',
      };
      if (repairMode === 'semantic-fail') {
        // D-023: a judgment-gate (semantic) fail with a reason -> review_required.
        // The 2nd call (Regenerate) returns a distinguishable explanation so the
        // suite can prove the candidate was replaced, not left in place.
        send(200, {
          ...base,
          status: 'validation_failed',
          repair_explanation:
            repairCallCount >= 2
              ? 'Regenerated fixture repair for ' + functionId + '.'
              : 'Fixture repair for ' + functionId + '.',
          hunks: c.hunks,
          validations: SEMANTIC_FAIL_VALIDATIONS,
        });
        return;
      }
      // Validation-CodeLens suite: an all-pass candidate (no fail, no skipped) so
      // the diff right pane renders the single `✓ N/N validation gates passed` lens.
      if (repairMode === 'all-pass') {
        send(200, {
          ...base,
          status: 'repair_ready',
          repair_explanation: 'Fixture repair for ' + functionId + '.',
          hunks: c.hunks,
          validations: ALL_PASS_VALIDATIONS,
        });
        return;
      }
      // D-026: both candidates additionally carry a pure-insertion `#include
      // <stdint.h>` hunk at different anchors; a repair_ready candidate otherwise.
      const hunks = repairMode === 'dedupe-include' ? DEDUPE_CANDIDATES[functionId].hunks : c.hunks;
      send(200, {
        ...base,
        status: 'repair_ready',
        repair_explanation: 'Fixture repair for ' + functionId + '.',
        hunks,
        validations: VALIDATIONS,
      });
      return;
    }

    send(404, { detail: 'not found: ' + req.method + ' ' + url });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
