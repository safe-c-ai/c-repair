// Integration suite (VSCODE_V1B_DESIGN §7): drive the full V1b-2 flow against
// the offline fixture bridge (fixtureBridge.ts) — scan → Diagnostics/TreeView →
// Generate Repair → candidate node → Accept (document rewrite) → undo (restore).
// No python, no LLM: the BridgeManager attaches to the fixture bridge via the
// CREPAIR_TEST_BRIDGE_URL hook set by runTest.ts before launch.
//
// Determinism: the fixture source is copied to a temp .c file and opened, so the
// candidate hunks (Original line 5 / line 26) land on real line numbers, and the
// applied document is compared byte-for-byte against @core applyHunks.

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import { applyHunks } from '@c-repair/core';
import type { RepairCandidate } from '@c-repair/contract';

// The pristine fixture source (kept in sync with tests/fixtures/source/sample_sensor.c).
const SENSOR_SRC = [
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
  const ext = vscode.extensions.getExtension('undefined_publisher.c-repair') ?? findExt();
  assert.ok(ext, 'C Repair extension not found');
  const api = (await ext!.activate()) as TestApi | undefined;
  assert.ok(api, 'test API not exposed — is CREPAIR_TEST_BRIDGE_URL set?');
  return api!;
}

function findExt(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.all.find((e) => e.packageJSON?.name === 'c-repair');
}

/** Recursively flatten a tree provider into a list of {item, node} pairs. */
async function flattenTree(
  tree: TestApi['getTree'] extends () => infer T ? T : never,
): Promise<{ item: vscode.TreeItem; node: unknown }[]> {
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

export function integration(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair V1b-2 integration (fixture bridge)');

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let editor: vscode.TextEditor;
  let api: TestApi;

  suite.beforeAll(async () => {
    // Silence the external-route modal for the scan flow.
    await vscode.workspace
      .getConfiguration('crepair')
      .update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);
    // D-025: this suite exercises the MANUAL generate/accept path and drives it via
    // `crepair.scanCurrentFile`, which is now scan-only (no auto-repair). The
    // `crepair.autoRepair` setting was removed; the command choice alone decides.

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-it-'));
    filePath = path.join(tmpDir, 'sample_sensor.c');
    fs.writeFileSync(filePath, SENSOR_SRC, 'utf8');

    api = await getTestApi();
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');

    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    editor = await vscode.window.showTextDocument(doc);
    assert.equal(editor.document.getText(), SENSOR_SRC);
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
    new Mocha.Test('scan produces 2 violation diagnostics and a tree with 2 candidates-able findings', async () => {
      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      // Diagnostics settle synchronously at the end of the scan flow.
      const diags = vscode.languages.getDiagnostics(doc.uri);
      const violations = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning);
      assert.equal(violations.length, 2, `expected 2 violation diagnostics, got ${diags.length}`);

      const session = api.getSession();
      assert.ok(session, 'session should exist after scan');

      const nodes = await flattenTree(api.getTree() as never);
      const findingItems = nodes.filter(
        (n) =>
          typeof n.item.contextValue === 'string' &&
          n.item.contextValue.startsWith('crepair.finding.violation'),
      );
      assert.equal(findingItems.length, 2, 'expected 2 violation finding rows');
    }),
  );

  suite.addTest(
    new Mocha.Test('Generate Repair creates a candidate node with an insufficient-evidence badge', async () => {
      const nodes = await flattenTree(api.getTree() as never);
      const scaleFinding = nodes.find(
        (n) =>
          (n.node as { kind?: string; finding?: { function_id?: string } }).kind === 'finding' &&
          (n.node as { finding: { finding_id: string } }).finding.finding_id === 'find-scale-int32',
      );
      assert.ok(scaleFinding, 'scale_reading finding node not found');

      await vscode.commands.executeCommand('crepair.generateRepair', scaleFinding!.node);
      await delay(50);

      const after = await flattenTree(api.getTree() as never);
      const candidate = after.find(
        (n) => (n.node as { kind?: string }).kind === 'candidate',
      );
      assert.ok(candidate, 'candidate node not created');
      // behavior_check is skipped in the fixtures => insufficient evidence (D-017c).
      // V1c-UX: the badge now leads the primary label ("Proposed fix [insufficient evidence]").
      const label = candidate!.item.label;
      const labelText = typeof label === 'string' ? label : (label?.label ?? '');
      assert.match(labelText, /Proposed fix/);
      assert.match(labelText, /insufficient evidence/);
      assert.match(
        String(candidate!.item.contextValue),
        /^crepair\.candidate\.diffable\.acceptable\.pending$/,
      );
    }),
  );

  suite.addTest(
    new Mocha.Test('Accept rewrites the document to the applyHunks expected text', async () => {
      const nodes = await flattenTree(api.getTree() as never);
      const candidateNode = nodes.find((n) => (n.node as { kind?: string }).kind === 'candidate');
      assert.ok(candidateNode, 'candidate node missing');
      const candidate = (candidateNode!.node as { candidate: RepairCandidate }).candidate;

      await vscode.commands.executeCommand('crepair.acceptCandidate', candidateNode!.node);
      await delay(50);

      const expected = applyHunks(SENSOR_SRC, CAND_001_HUNKS);
      assert.equal(doc.getText(), expected, 'document not equal to applyHunks output');
      // The candidate is marked accepted in the tree.
      const after = await flattenTree(api.getTree() as never);
      const acc = after.find((n) => (n.node as { kind?: string }).kind === 'candidate');
      assert.match(String(acc!.item.description), /\[accepted\]/);
      // The scale finding's diagnostic is removed (1 violation left).
      const diags = vscode.languages.getDiagnostics(doc.uri);
      const violations = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning);
      assert.equal(violations.length, 1, 'accepted finding diagnostic should be gone');

      // Sanity: the candidate hunk id is stable.
      assert.equal(candidate.candidate_id, 'cand-001');
    }),
  );

  suite.addTest(
    new Mocha.Test('Undo restores the original document byte-for-byte', async () => {
      // A single undo reverts the one WorkspaceEdit applied by Accept.
      await vscode.commands.executeCommand('undo');
      await delay(50);
      assert.equal(doc.getText(), SENSOR_SRC, 'undo did not restore the original text');
    }),
  );
}
