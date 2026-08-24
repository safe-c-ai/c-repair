// Integration suite for the D-023 judgment-gate flow (warning-gated Accept +
// Regenerate), driven against the offline fixture bridge. Flips the bridge's
// repair mode to "semantic-fail" so /repair returns a candidate whose MECHANICAL
// gates pass but whose JUDGMENT `semantic` gate fails with a reason detail, then
// verifies:
//   (a) the candidate badge is [review required] (not [validation_failed]);
//   (b) Accept over the warning (the QuickPick is bypassed by the CREPAIR_TEST_
//       ACCEPT_WARNING hook) rewrites the document and marks it [accepted ⚠];
//   (c) Regenerate replaces the candidate (a fresh /repair; new explanation).
//
// Uses a DISTINCT temp file/content from the other suites so the confirmed-context
// cache (keyed by content_hash) never collides. No python, no LLM: the
// BridgeManager attaches to the fixture bridge via CREPAIR_TEST_BRIDGE_URL, and
// the QuickPick is bypassed via CREPAIR_TEST_ACCEPT_WARNING (both set by runTest.ts).

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import { applyHunks } from '@c-repair/core';
import type { RepairCandidate } from '@c-repair/contract';

// A single-violation source; only scale_reading (find-scale-int32) is exercised.
// Kept structurally identical to the fixture the bridge's candidate hunks target
// (Original line 5 is the buggy multiply) so applyHunks lands on real lines.
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

const CAND_001_HUNKS = [
  {
    hunk_id: 'hunk-scale-1',
    start_line: 5,
    line_count: 1,
    replacement_text:
      '    if (raw > INT_MAX / 1000 || raw < INT_MIN / 1000) {\n        return -1;\n    }\n    int scaled = raw * 1000;',
  },
];

interface TestApi {
  seedApiKey(key: string): Thenable<void>;
  getSession(): unknown;
  getTree(): {
    getChildren(node?: unknown): unknown[] | Thenable<unknown[]>;
    getTreeItem(node: unknown): vscode.TreeItem;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getTestApi(): Promise<TestApi> {
  const ext =
    vscode.extensions.getExtension('undefined_publisher.c-repair') ??
    vscode.extensions.all.find((e) => e.packageJSON?.name === 'c-repair');
  assert.ok(ext, 'C Repair extension not found');
  const api = (await ext!.activate()) as TestApi | undefined;
  assert.ok(api, 'test API not exposed — is CREPAIR_TEST_BRIDGE_URL set?');
  return api!;
}

/** Set the fixture bridge's repair mode via its test control route. */
async function setRepairMode(mode: 'ready' | 'semantic-fail'): Promise<void> {
  const url = process.env.CREPAIR_TEST_BRIDGE_URL;
  assert.ok(url, 'CREPAIR_TEST_BRIDGE_URL not set in the Extension Host');
  const resp = await fetch(url!.replace(/\/+$/, '') + '/__test__/repair-mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  assert.equal(resp.status, 200, 'repair-mode control route failed');
}

/** Recursively flatten a tree provider into a list of {item, node} pairs. */
async function flattenTree(tree: TestApi['getTree'] extends () => infer T ? T : never): Promise<
  { item: vscode.TreeItem; node: unknown }[]
> {
  const out: { item: vscode.TreeItem; node: unknown }[] = [];
  const walk = async (node?: unknown): Promise<void> => {
    const children = (await tree.getChildren(node)) as unknown[];
    for (const child of children) {
      out.push({ item: tree.getTreeItem(child), node: child });
      await walk(child);
    }
  };
  await walk(undefined);
  return out;
}

function labelText(item: vscode.TreeItem): string {
  const label = item.label;
  return typeof label === 'string' ? label : (label?.label ?? '');
}

export function judgmentGate(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair D-023 judgment gate (fixture bridge)');

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let api: TestApi;

  suite.beforeAll(async () => {
    await vscode.workspace
      .getConfiguration('crepair')
      .update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);
    // D-025: this suite exercises the MANUAL generate/accept/regenerate path and
    // drives `crepair.scanCurrentFile`, which is now scan-only (no auto-repair).
    // The `crepair.autoRepair` setting was removed; the command choice alone decides.

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-d023-'));
    filePath = path.join(tmpDir, 'judgment_sensor.c');
    fs.writeFileSync(filePath, SRC, 'utf8');

    api = await getTestApi();
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');

    // Semantic-fail candidates for this suite; reset to 'ready' in afterAll so no
    // other suite is affected by the shared bridge's mode.
    await setRepairMode('semantic-fail');

    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('crepair.scanCurrentFile');
    await delay(50);
  });

  suite.afterAll(async () => {
    try {
      await setRepairMode('ready');
    } catch {
      /* best-effort */
    }
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
    new Mocha.Test('a semantic-fail candidate shows the [review required] badge', async () => {
      const nodes = await flattenTree(api.getTree() as never);
      const scaleFinding = nodes.find(
        (n) =>
          (n.node as { kind?: string }).kind === 'finding' &&
          (n.node as { finding: { finding_id: string } }).finding.finding_id === 'find-scale-int32',
      );
      assert.ok(scaleFinding, 'scale_reading finding node not found');

      await vscode.commands.executeCommand('crepair.generateRepair', scaleFinding!.node);
      await delay(50);

      const after = await flattenTree(api.getTree() as never);
      const candidate = after.find((n) => (n.node as { kind?: string }).kind === 'candidate');
      assert.ok(candidate, 'candidate node not created');
      // D-023: judgment (semantic) gate fail -> [review required], and the node is
      // still acceptable (diffable.acceptable.pending) so Accept can be offered.
      assert.match(labelText(candidate!.item), /review required/);
      assert.match(
        String(candidate!.item.contextValue),
        /^crepair\.candidate\.diffable\.acceptable\.pending$/,
      );
    }),
  );

  suite.addTest(
    new Mocha.Test('Accept over the warning rewrites the doc and marks [accepted ⚠]', async () => {
      const nodes = await flattenTree(api.getTree() as never);
      const candidateNode = nodes.find((n) => (n.node as { kind?: string }).kind === 'candidate');
      assert.ok(candidateNode, 'candidate node missing');

      // The QuickPick is bypassed by CREPAIR_TEST_ACCEPT_WARNING=apply (set in runTest.ts),
      // so Accept applies the fix even though a judgment gate failed.
      await vscode.commands.executeCommand('crepair.acceptCandidate', candidateNode!.node);
      await delay(50);

      const expected = applyHunks(SRC, CAND_001_HUNKS);
      assert.equal(doc.getText(), expected, 'document not equal to applyHunks output');

      const after = await flattenTree(api.getTree() as never);
      const acc = after.find((n) => (n.node as { kind?: string }).kind === 'candidate');
      // The override fact is surfaced as [accepted ⚠] (D-023).
      assert.match(String(acc!.item.description), /\[accepted ⚠\]/);
    }),
  );

  suite.addTest(
    new Mocha.Test('Regenerate replaces the candidate with a fresh one', async () => {
      // Undo the accepted edit first so the document is not stale (Regenerate is
      // refused while stale, same guard as Generate).
      await vscode.commands.executeCommand('undo');
      await delay(50);
      assert.equal(doc.getText(), SRC, 'undo did not restore the original text');

      const before = await flattenTree(api.getTree() as never);
      const candBefore = before.find((n) => (n.node as { kind?: string }).kind === 'candidate');
      assert.ok(candBefore, 'candidate node missing before regenerate');
      const explBefore = (candBefore!.node as { candidate: RepairCandidate }).candidate
        .repair_explanation;
      assert.match(explBefore, /^Fixture repair/, 'expected the first-generation explanation');

      await vscode.commands.executeCommand('crepair.regenerateRepair', candBefore!.node);
      await delay(50);

      const after = await flattenTree(api.getTree() as never);
      const candAfter = after.find((n) => (n.node as { kind?: string }).kind === 'candidate');
      assert.ok(candAfter, 'candidate node missing after regenerate');
      const candidate = (candAfter!.node as { candidate: RepairCandidate }).candidate;
      // The candidate was REPLACED: the fixture bridge returns a distinguishable
      // explanation on the 2nd /repair call.
      assert.match(candidate.repair_explanation, /^Regenerated fixture repair/);
      // Exactly one candidate for the finding (the old one was dropped).
      const candidates = after.filter((n) => (n.node as { kind?: string }).kind === 'candidate');
      assert.equal(candidates.length, 1, 'expected exactly one candidate after regenerate');
      // The decision was cleared with the replacement (no leftover [accepted ⚠]).
      assert.doesNotMatch(String(candAfter!.item.description), /accepted/);
    }),
  );
}
