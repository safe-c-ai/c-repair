// Integration suite for the D-026 duplicate-#include filter, driven against the
// offline fixture bridge. Flips the bridge's repair mode to "dedupe-include" so
// BOTH violation candidates carry the SAME `#include <stdint.h>` pure-insertion
// hunk at DIFFERENT anchors (line 1 vs line 4). Because the anchors differ, the
// range-based conflict guard (D-004) does not flag them, so — without D-026 —
// accepting both would insert the include twice. This suite verifies:
//   (a) accepting the FIRST candidate inserts `#include <stdint.h>` once;
//   (b) accepting the SECOND candidate applies its fix but does NOT insert the
//       include a second time (the D-026 filter drops the duplicate line);
//   (c) the final document contains `#include <stdint.h>` exactly once.
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

// A two-violation source (scale_reading + copy_label), structurally identical to
// the fixture the bridge's candidate hunks target so the fix hunks land on real
// lines. The dedupe candidates additionally insert `#include <stdint.h>`.
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
async function setRepairMode(mode: 'ready' | 'semantic-fail' | 'dedupe-include'): Promise<void> {
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

/** Count occurrences of `#include <stdint.h>` (trim-exact) in the document text. */
function countStdint(text: string): number {
  return text.split('\n').filter((l) => l.trim() === '#include <stdint.h>').length;
}

/** Generate a candidate for a finding id and return its candidate node. */
async function generateFor(api: TestApi, findingId: string): Promise<unknown> {
  const nodes = await flattenTree(api.getTree() as never);
  const findingNode = nodes.find(
    (n) =>
      (n.node as { kind?: string }).kind === 'finding' &&
      (n.node as { finding: { finding_id: string } }).finding.finding_id === findingId,
  );
  assert.ok(findingNode, `finding node ${findingId} not found`);
  await vscode.commands.executeCommand('crepair.generateRepair', findingNode!.node);
  await delay(50);
  const after = await flattenTree(api.getTree() as never);
  const candNode = after.find(
    (n) =>
      (n.node as { kind?: string; candidate?: { finding_id?: string } }).kind === 'candidate' &&
      (n.node as { candidate: { finding_id: string } }).candidate.finding_id === findingId,
  );
  assert.ok(candNode, `candidate node for ${findingId} not created`);
  return candNode!.node;
}

export function dedupeInclude(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair D-026 duplicate #include (fixture bridge)');

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let api: TestApi;

  suite.beforeAll(async () => {
    await vscode.workspace
      .getConfiguration('crepair')
      .update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-d026-'));
    filePath = path.join(tmpDir, 'dedupe_sensor.c');
    fs.writeFileSync(filePath, SRC, 'utf8');

    api = await getTestApi();
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');

    // Both candidates add the same `#include <stdint.h>` at different anchors.
    // Reset to 'ready' in afterAll so no other suite sees this mode.
    await setRepairMode('dedupe-include');

    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
    // Scan-only (no auto-repair); the test generates + accepts the two candidates.
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
    new Mocha.Test('accepting the first candidate inserts #include <stdint.h> once', async () => {
      assert.equal(countStdint(doc.getText()), 0, 'the include must not be present before Accept');
      const node = await generateFor(api, 'find-scale-int32');
      await vscode.commands.executeCommand('crepair.acceptCandidate', node);
      await delay(50);
      assert.equal(
        countStdint(doc.getText()),
        1,
        'the first Accept should insert #include <stdint.h> exactly once',
      );
    }),
  );

  suite.addTest(
    new Mocha.Test(
      'accepting the second candidate applies its fix but skips the duplicate include',
      async () => {
        const node = await generateFor(api, 'find-copy-str31');
        await vscode.commands.executeCommand('crepair.acceptCandidate', node);
        await delay(50);

        const text = doc.getText();
        // D-026: the second candidate's `#include <stdint.h>` is a duplicate of the
        // one already inserted, so it is dropped — the include appears exactly ONCE
        // (had the filter not run, the anchor drift would have inserted it twice).
        assert.equal(
          countStdint(text),
          1,
          'the include must appear exactly once after both accepts (duplicate skipped)',
        );
        // The second candidate's REAL fix (the copy_label memcpy) still applied.
        assert.match(
          text,
          /memcpy\(dst, src, n \+ 1\);/,
          'the copy_label fix hunk must still be applied even though its include was skipped',
        );

        // Both candidates are marked accepted in the tree.
        const nodes = await flattenTree(api.getTree() as never);
        const accepted = nodes.filter(
          (n) =>
            (n.node as { kind?: string }).kind === 'candidate' &&
            /\[accepted\]/.test(String(n.item.description)),
        );
        assert.equal(accepted.length, 2, 'both candidates should be marked [accepted]');
      },
    ),
  );
}
