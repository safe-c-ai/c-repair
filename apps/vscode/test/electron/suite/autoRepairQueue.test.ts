// Integration suite for the D-024 scan → auto-repair → diff-review-queue pipeline,
// driven against the offline fixture bridge. With crepair.autoRepair on (default),
// a single scan of the 2-violation fixture:
//   (a) auto-generates both repair candidates and opens the FIRST diffable one as a
//       diff (the review queue), incrementally (not waiting for the whole run);
//   (b) the title-bar Accept command (crepair.acceptCurrentDiff) applies the shown
//       candidate and auto-advances to the next pending diffable candidate's diff;
//   (c) after the last candidate is decided, a "Review complete" summary is shown
//       and no crepair diff remains active;
//   (d) with crepair.autoRepair OFF, a scan does NOT auto-generate or open a diff
//       (the pre-D-024 manual behaviour).
//
// Uses a DISTINCT temp file/content from the other suites so the confirmed-context
// cache (keyed by content_hash) never collides. No python, no LLM: the
// BridgeManager attaches to the fixture bridge via CREPAIR_TEST_BRIDGE_URL.

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';

import { DEFAULT_MODE_LABEL_LOWER } from '../../../src/bridge/overrideEnv';

// The 2-violation fixture (scale_reading line 5, copy_label line 26), matching the
// hunks the fixture bridge's candidates target so applyHunks lands on real lines.
const SRC = [
  '#include <stddef.h>',
  '#include <string.h>',
  '',
  'int scale_reading(int raw) {',
  '    int scaled = raw * 1000;',
  '    return scaled;',
  '}',
  '',
  'int average_two(int a, int b) {',
  '    return (a + b) / 2;',
  '}',
  '',
  'VehicleState next_state(VehicleState current) {',
  '    if (current == STATE_IDLE) {',
  '        return STATE_ACTIVE;',
  '    }',
  '    return current;',
  '}',
  '',
  'int over_threshold(void) {',
  '    int v = read_sensor(0);',
  '    return v > threshold;',
  '}',
  '',
  'void copy_label(char *dst, const char *src) {',
  '    strcpy(dst, src);',
  '}',
  '',
  'int sample_index(int i) {',
  '    int buf[8];',
  '    return buf[i];',
  '}',
  '',
].join('\n');

interface QueueTestApi {
  seedApiKey(key: string): Thenable<void>;
  getSession():
    | { decisionFor(id: string): string; candidates(): { candidate_id: string }[] }
    | undefined;
  getTree(): {
    getChildren(node?: unknown): unknown[] | Thenable<unknown[]>;
    getTreeItem(node: unknown): vscode.TreeItem;
    // D-030: the session token line rendered above the tree (treeView.message).
    message?: string;
    // The always-on model / tier / reasoning line (header row 1).
    modelLine?: string;
  };
  getActiveDiffCandidateId(): string | undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getTestApi(): Promise<QueueTestApi> {
  const ext =
    vscode.extensions.getExtension('undefined_publisher.c-repair') ??
    vscode.extensions.all.find((e) => e.packageJSON?.name === 'c-repair');
  assert.ok(ext, 'C Repair extension not found');
  const api = (await ext!.activate()) as QueueTestApi | undefined;
  assert.ok(api, 'test API not exposed — is CREPAIR_TEST_BRIDGE_URL set?');
  return api!;
}

/** Wait until `predicate()` is true or the timeout elapses (poll). */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  assert.ok(predicate(), 'condition not met within timeout');
}

/** Count candidate nodes currently in the tree. */
async function candidateCount(api: QueueTestApi): Promise<number> {
  const tree = api.getTree();
  let count = 0;
  const walk = async (node?: unknown): Promise<void> => {
    const children = (await tree.getChildren(node)) as unknown[];
    for (const child of children) {
      if ((child as { kind?: string }).kind === 'candidate') count += 1;
      await walk(child);
    }
  };
  await walk(undefined);
  return count;
}

export function autoRepairQueue(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair D-024 auto-repair queue (fixture bridge)');

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let api: QueueTestApi;

  suite.beforeAll(async () => {
    await vscode.workspace
      .getConfiguration('crepair')
      .update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);
    // D-025: the pipeline under test is now the `crepair.scanAndFixCurrentFile`
    // command (the `crepair.autoRepair` setting was removed). Keep the limit high so
    // the 2-violation fixture generates without the cost-guard confirm modal.
    await vscode.workspace
      .getConfiguration('crepair')
      .update('autoRepairLimit', 5, vscode.ConfigurationTarget.Global);
    // D-025: cost display MUST be off in tests so the usage endpoint (openrouter.ai)
    // is NEVER contacted — the suite must stay fully offline.
    await vscode.workspace
      .getConfiguration('crepair')
      .update('showCosts', false, vscode.ConfigurationTarget.Global);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-d024-'));
    filePath = path.join(tmpDir, 'queue_sensor.c');
    fs.writeFileSync(filePath, SRC, 'utf8');

    api = await getTestApi();
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');
  });

  suite.afterAll(async () => {
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  suite.addTest(
    new Mocha.Test('(a) Scan & Fix auto-generates 2 candidates and opens the first diff', async () => {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand('crepair.scanAndFixCurrentFile');
      // The pipeline generates both candidates and opens the first diff.
      await waitFor(() => (api.getSession()?.candidates().length ?? 0) === 2);
      assert.equal(await candidateCount(api), 2, 'both candidates auto-generated');

      // A crepair diff is open for the first diffable candidate (cand-001, line 5).
      await waitFor(() => api.getActiveDiffCandidateId() !== undefined);
      assert.equal(
        api.getActiveDiffCandidateId(),
        'cand-001',
        'the first diffable candidate (scale_reading) is shown first',
      );
    }),
  );

  suite.addTest(
    new Mocha.Test('(a2) the TreeView shows the session token line after Scan & Fix (D-030)', async () => {
      // D-030: the bridge meters tokens (fixture: 1500/300/0 per scan + 4200/900/600
      // per repair). After a scan + 2 repairs the accumulated line is tokens-only
      // (showCosts is off in this suite, so no cost segment is contacted / appended).
      //   prompt      = 1500 + 2*4200 = 9900  -> "9.9k"
      //   completion  =  300 + 2*900  = 2100  -> "2.1k"
      //   reasoning   =    0 + 2*600  = 1200  -> "1.2k"
      const expected = 'Session: 9.9k in / 2.1k out (reasoning 1.2k)';
      await waitFor(() => api.getTree().message === expected);
      assert.equal(
        api.getTree().message,
        expected,
        'the session token line reflects the metered scan + repair tokens',
      );

      // The always-on model line reflects the fixture bridge's effective /health
      // capabilities (model: fixture/deterministic, reasoning_effort: xhigh, PAID) and
      // the current model mode (internal `default`, displayed by its D-038 label; the
      // test workspace sets no crepair.modelMode).
      const expectedModelLine =
        `Model: fixture/deterministic (PAID) · reasoning: xhigh · mode: ${DEFAULT_MODE_LABEL_LOWER}`;
      await waitFor(() => api.getTree().modelLine === expectedModelLine);
      assert.equal(
        api.getTree().modelLine,
        expectedModelLine,
        'the model line reflects the effective /health model and reasoning',
      );
    }),
  );

  suite.addTest(
    new Mocha.Test('(b) Accept applies and auto-advances to the next candidate diff', async () => {
      assert.equal(api.getActiveDiffCandidateId(), 'cand-001', 'starting on the first diff');

      await vscode.commands.executeCommand('crepair.acceptCurrentDiff');
      // cand-001 accepted, and the queue advances to cand-002's diff.
      await waitFor(() => api.getSession()?.decisionFor('cand-001') === 'accepted');
      await waitFor(() => api.getActiveDiffCandidateId() === 'cand-002');
      assert.equal(
        api.getActiveDiffCandidateId(),
        'cand-002',
        'auto-advanced to the second candidate',
      );
    }),
  );

  suite.addTest(
    new Mocha.Test('(c) deciding the last candidate completes the review (no diff left)', async () => {
      assert.equal(api.getActiveDiffCandidateId(), 'cand-002', 'on the last diff');

      await vscode.commands.executeCommand('crepair.acceptCurrentDiff');
      await waitFor(() => api.getSession()?.decisionFor('cand-002') === 'accepted');
      // The queue is exhausted: the diff closes and no crepair diff remains active.
      await waitFor(() => api.getActiveDiffCandidateId() === undefined);
      assert.equal(
        api.getActiveDiffCandidateId(),
        undefined,
        'no crepair diff remains after the last decision (Review complete)',
      );
      // Both decisions are recorded as accepted.
      const s = api.getSession();
      assert.equal(s?.decisionFor('cand-001'), 'accepted');
      assert.equal(s?.decisionFor('cand-002'), 'accepted');
    }),
  );

  suite.addTest(
    new Mocha.Test('(d) plain Scan (scanCurrentFile) does not auto-generate or open a diff', async () => {
      // D-025: the command choice — not a setting — decides. `crepair.scanCurrentFile`
      // is scan-only, so it must NOT auto-generate candidates or open a review diff.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      // A fresh file so the confirmed-context cache does not short-circuit anything
      // relevant; scan it and confirm no candidates are auto-generated.
      const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-d025-scanonly-'));
      const offPath = path.join(offDir, 'queue_scanonly.c');
      fs.writeFileSync(offPath, SRC, 'utf8');
      const offDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(offPath));
      await vscode.window.showTextDocument(offDoc);

      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      // The scan settles synchronously; scan-only runs no pipeline. Give the flow a
      // beat to prove it did NOT generate.
      await waitFor(() => (api.getSession()?.candidates !== undefined));
      await delay(200);
      assert.equal(await candidateCount(api), 0, 'no candidates for plain Scan');
      assert.equal(
        api.getActiveDiffCandidateId(),
        undefined,
        'no diff auto-opened for plain Scan',
      );

      try {
        fs.rmSync(offDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }),
  );
}
