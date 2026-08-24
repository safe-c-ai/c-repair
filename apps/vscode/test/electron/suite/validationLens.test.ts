// Integration suite for the validation CodeLens on the candidate diff's RIGHT pane
// (user feedback: the validation result — e.g. a semantic gate's fail reason — must
// be visible at the moment of judgment, the diff, not only in the clipped left tree).
//
// Drives the offline fixture bridge. For a diff opened on the applied-after (right)
// virtual doc it asserts, via `vscode.executeCodeLensProvider`, that:
//   (a) a semantic-fail candidate's right pane carries a `✗ semantic: <reason>` lens
//       wired to crepair.showValidationDetail (the Output full-text entry);
//   (b) an all-pass candidate's right pane carries the single `✓ N/N validation
//       gates passed` summary lens (no per-gate concern lens);
//   (c) the LEFT (Original) pane carries NO validation lens (right pane only).
//
// Uses a DISTINCT temp file/content from the other suites so the confirmed-context
// cache (keyed by content_hash) never collides. It flips the shared fixture bridge's
// repair mode (semantic-fail / all-pass) and resets it to 'ready' in afterAll, so it
// must run after the default-mode suites (registered last-ish in index.ts). No
// python, no LLM: the bridge is attached via CREPAIR_TEST_BRIDGE_URL.

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';

// A single-violation source (only scale_reading / find-scale-int32 is exercised),
// structurally identical to the fixture the bridge's hunks target (line 5 multiply).
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
  getActiveDiffCandidateId(): string | undefined;
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
async function setRepairMode(mode: 'ready' | 'semantic-fail' | 'all-pass'): Promise<void> {
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

/** The finding node for scale_reading (the single violation this suite drives). */
async function scaleFindingNode(api: TestApi): Promise<unknown> {
  const nodes = await flattenTree(api.getTree() as never);
  const n = nodes.find(
    (x) =>
      (x.node as { kind?: string }).kind === 'finding' &&
      (x.node as { finding: { finding_id: string } }).finding.finding_id === 'find-scale-int32',
  );
  assert.ok(n, 'scale_reading finding node not found');
  return n!.node;
}

/**
 * The active diff editor's two sides (original = left, modified = right), read from
 * the tab model. `showDiff` opens a native diff whose active tab is a TabInputTextDiff.
 */
function activeDiffUris(): { original: vscode.Uri; modified: vscode.Uri } {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
  assert.ok(input?.original && input?.modified, 'active tab is not a diff editor');
  return { original: input!.original!, modified: input!.modified! };
}

/** Fetch CodeLens titles for a URI via the built-in command (resolves commands). */
async function lensTitles(uri: vscode.Uri): Promise<string[]> {
  const lenses = (await vscode.commands.executeCommand(
    'vscode.executeCodeLensProvider',
    uri,
  )) as vscode.CodeLens[] | undefined;
  return (lenses ?? []).map((l) => l.command?.title ?? '');
}

export function validationLens(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(
    rootSuite,
    'C Repair validation CodeLens (diff right pane, fixture bridge)',
  );

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let api: TestApi;

  suite.beforeAll(async () => {
    await vscode.workspace
      .getConfiguration('crepair')
      .update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('crepair')
      .update('showCosts', false, vscode.ConfigurationTarget.Global);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-lens-'));
    filePath = path.join(tmpDir, 'lens_sensor.c');
    fs.writeFileSync(filePath, SRC, 'utf8');

    api = await getTestApi();
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');

    // Start in semantic-fail so the first generated candidate carries a ✗ semantic
    // gate; the second test flips to all-pass. Reset to 'ready' in afterAll.
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
    new Mocha.Test(
      'a semantic-fail candidate diff shows a ✗ semantic lens on the right pane',
      async () => {
        const finding = await scaleFindingNode(api);
        await vscode.commands.executeCommand('crepair.generateRepair', finding);
        await delay(50);

        // Open the candidate diff (native side-by-side). The active tab is the diff.
        const nodes = await flattenTree(api.getTree() as never);
        const candNode = nodes.find((n) => (n.node as { kind?: string }).kind === 'candidate');
        assert.ok(candNode, 'candidate node not created');
        await vscode.commands.executeCommand('crepair.showDiff', candNode!.node);
        await delay(50);

        const { original, modified } = activeDiffUris();

        // Right (applied-after) pane carries the ✗ semantic concern lens.
        const rightTitles = await lensTitles(modified);
        const semantic = rightTitles.find((t) => t.startsWith('✗ semantic:'));
        assert.ok(
          semantic,
          `expected a "✗ semantic:" lens on the right pane; got ${JSON.stringify(rightTitles)}`,
        );
        // The fixture's semantic reason reaches the lens title (1-lined, may truncate).
        assert.match(semantic!, /changes behaviour/);
        // No reassuring all-pass summary alongside a concern.
        assert.ok(
          !rightTitles.some((t) => /validation gates passed/.test(t)),
          'a concern lens must not be accompanied by an all-pass summary',
        );

        // Left (Original) pane carries NO validation lens (right pane only).
        const leftTitles = await lensTitles(original);
        assert.equal(
          leftTitles.length,
          0,
          `left (Original) pane must have no validation lens; got ${JSON.stringify(leftTitles)}`,
        );
      },
    ),
  );

  suite.addTest(
    new Mocha.Test(
      'an all-pass candidate diff shows the ✓ N/N summary lens on the right pane',
      async () => {
        // Flip to all-pass and regenerate the candidate so its validations are all pass.
        await setRepairMode('all-pass');
        const nodes = await flattenTree(api.getTree() as never);
        const candNode = nodes.find((n) => (n.node as { kind?: string }).kind === 'candidate');
        assert.ok(candNode, 'candidate node missing');
        await vscode.commands.executeCommand('crepair.regenerateRepair', candNode!.node);
        await delay(50);

        const after = await flattenTree(api.getTree() as never);
        const candAfter = after.find((n) => (n.node as { kind?: string }).kind === 'candidate');
        assert.ok(candAfter, 'candidate node missing after regenerate');
        await vscode.commands.executeCommand('crepair.showDiff', candAfter!.node);
        await delay(50);

        const { modified } = activeDiffUris();
        const rightTitles = await lensTitles(modified);
        assert.deepEqual(
          rightTitles,
          ['✓ 3/3 validation gates passed'],
          `expected a single all-pass summary lens; got ${JSON.stringify(rightTitles)}`,
        );
      },
    ),
  );
}
