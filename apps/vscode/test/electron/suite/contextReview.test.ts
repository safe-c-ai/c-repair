// Integration suite for the Context Review UX (D-021), driven against the offline
// fixture bridge. Flips the bridge's infer mode to "two-items" so /context/infer
// returns 2 inferred declarations, then verifies:
//   (a) the Review opens as a diff whose editable right side is the whole Augmented
//       C (marker-end + comment-stripped code section present);
//   (b) Confirm Context & Scan sends confirmed=true items to /context/confirm and
//       proceeds to scan;
//   (c) the Skip path leaves items confirmed=false (assumption-dependent) and scans;
//   (d) editing the code section under the marker and confirming FAILS (the doc
//       stays open, no session is produced) — the Original-invariant guard.
// Uses a DISTINCT temp file/content from the V1b-2 suite so the confirmed-context
// cache (keyed by content_hash) never collides across suites; the cache is also
// cleared between scenarios for isolation.
//
// No python, no LLM: the BridgeManager attaches to the fixture bridge via
// CREPAIR_TEST_BRIDGE_URL (also readable here to hit the test control route).

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import { MARKER_END } from '@c-repair/core';

// Fixture source that USES external symbols (read_sensor / threshold) so a real
// infer would produce items. It includes a comment so the Review diff exercises the
// comment-stripping (the code section shown must NOT contain the comment). The
// fixture bridge returns 2 canned items in two-items mode regardless of content;
// the symbols make the scenario realistic.
const REVIEW_SRC = [
  '#include <stddef.h>',
  '',
  'int over_threshold(void) {',
  '    int v = read_sensor(0); // read the sensor',
  '    return v > threshold;',
  '}',
  '',
].join('\n');

interface ReviewTestApi {
  seedApiKey(key: string): Thenable<void>;
  getSession(): { confirmedSet: { items: { confirmed: boolean }[] } } | undefined;
  getTree(): {
    getChildren(node?: unknown): unknown[] | Thenable<unknown[]>;
    getTreeItem(node: unknown): vscode.TreeItem;
  };
  getReviewDoc(): vscode.TextDocument | undefined;
  setReviewDocText(text: string): Thenable<boolean>;
  clearContextCache(contentHash: string): Thenable<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getTestApi(): Promise<ReviewTestApi> {
  const ext =
    vscode.extensions.getExtension('undefined_publisher.c-repair') ??
    vscode.extensions.all.find((e) => e.packageJSON?.name === 'c-repair');
  assert.ok(ext, 'C Repair extension not found');
  const api = (await ext!.activate()) as ReviewTestApi | undefined;
  assert.ok(api, 'test API not exposed — is CREPAIR_TEST_BRIDGE_URL set?');
  return api!;
}

/** Set the fixture bridge's infer mode via its test control route. */
async function setInferMode(mode: 'empty' | 'two-items'): Promise<void> {
  const url = process.env.CREPAIR_TEST_BRIDGE_URL;
  assert.ok(url, 'CREPAIR_TEST_BRIDGE_URL not set in the Extension Host');
  const resp = await fetch(url!.replace(/\/+$/, '') + '/__test__/infer-mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  assert.equal(resp.status, 200, 'infer-mode control route failed');
}

/** sha256:<hex> of `content`, mirroring src/session/hash.ts (for cache clears). */
async function sha256(content: string): Promise<string> {
  const crypto = await import('node:crypto');
  return 'sha256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Wait until `predicate()` is true or the timeout elapses (poll). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  assert.ok(predicate(), 'condition not met within timeout');
}

export function contextReview(rootSuite: Mocha.Suite): void {
  const suite = Mocha.Suite.create(rootSuite, 'C Repair V2b Context Review (fixture bridge)');

  let tmpDir: string;
  let filePath: string;
  let doc: vscode.TextDocument;
  let api: ReviewTestApi;
  let srcHash: string;

  suite.beforeAll(async () => {
    await vscode.workspace
      .getConfiguration('crepair')
      .update('externalRouteNotice', false, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('crepair')
      .update('contextReview', 'when-needed', vscode.ConfigurationTarget.Global);
    // D-025: this suite exercises the Context Review flow, not the auto-repair
    // pipeline; it drives `crepair.scanCurrentFile`, which is now scan-only (no
    // auto-repair), so no post-scan pipeline opens diffs or interferes with the
    // Review teardown assertions. The `crepair.autoRepair` setting was removed.

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crepair-cr-'));
    filePath = path.join(tmpDir, 'over_threshold.c');
    fs.writeFileSync(filePath, REVIEW_SRC, 'utf8');
    srcHash = await sha256(REVIEW_SRC);

    api = await getTestApi();
    await api.seedApiKey('test-key-not-used-by-fixture-bridge');

    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
    await setInferMode('two-items');
  });

  suite.afterAll(async () => {
    try {
      await setInferMode('empty');
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

  suite.beforeEach(async () => {
    // Isolate each scenario: no cached confirmed set, so infer + Review re-run.
    await api.clearContextCache(srcHash);
  });

  suite.addTest(
    new Mocha.Test('items > 0 opens the Augmented C Review as an editable diff', async () => {
      // Focus the target .c so scanCurrentFile picks it up as the active editor.
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      await waitFor(() => api.getReviewDoc() !== undefined);

      const review = api.getReviewDoc();
      assert.ok(review, 'Review document should be open');
      assert.equal(review!.isUntitled, true, 'the editable (right) side is an untitled buffer');
      assert.equal(review!.languageId, 'c', 'Review doc is a C document');
      const text = review!.getText();
      // Whole Augmented C: markers + item delimiters + declarations + code section.
      assert.match(text, /C Repair inferred context/, 'has the marker-start banner');
      assert.ok(text.includes(MARKER_END), 'has the Original-source marker-end line');
      assert.match(text, /--- item aug-1 /, 'has the first item delimiter');
      assert.match(text, /--- item aug-2 /, 'has the second item delimiter');
      assert.match(text, /int read_sensor\(int channel\);/);
      assert.match(text, /extern int threshold;/);
      // The code section (after the marker-end) is the Original, comment-stripped.
      const code = text.slice(text.indexOf(MARKER_END) + MARKER_END.length);
      assert.match(code, /int over_threshold\(void\) \{/, 'code section carries the Original');
      assert.ok(!code.includes('// read the sensor'), 'comments are stripped from the code section');

      // The Review is shown as a diff: its editable side is visible in the diff
      // editor. Confirm the untitled buffer is among the visible editors' documents.
      const visible = vscode.window.visibleTextEditors.some(
        (e) => e.document.uri.toString() === review!.uri.toString(),
      );
      assert.ok(visible, 'the editable Review side is visible (in the diff)');

      // The scan for THIS file is deferred until confirm/skip: no session yet
      // reflects the review file (a session from an earlier suite may linger; the
      // scan for over_threshold.c has not produced a 2-item confirmed set).
      const s = api.getSession();
      const scannedThisFile =
        s !== undefined && s.confirmedSet.items.length === 2;
      assert.equal(scannedThisFile, false, 'scan should be deferred until confirm/skip');
    }),
  );

  suite.addTest(
    new Mocha.Test('Confirm Context & Scan confirms all items and scans', async () => {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      await waitFor(() => api.getReviewDoc() !== undefined);

      await vscode.commands.executeCommand('crepair.confirmContextAndScan');
      await waitFor(() => api.getSession() !== undefined);

      const session = api.getSession();
      assert.ok(session, 'session should exist after confirm + scan');
      const items = session!.confirmedSet.items;
      assert.equal(items.length, 2, 'both inferred items are in the confirmed set');
      assert.ok(
        items.every((i) => i.confirmed === true),
        'a reviewed confirm marks every item confirmed=true',
      );
      // The Review doc is torn down after a successful confirm.
      await waitFor(() => api.getReviewDoc() === undefined);
    }),
  );

  suite.addTest(
    new Mocha.Test('Skip Context Review & Scan leaves items unconfirmed', async () => {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      await waitFor(() => api.getReviewDoc() !== undefined);

      await vscode.commands.executeCommand('crepair.skipContextAndScan');
      await waitFor(() => api.getSession() !== undefined);

      const session = api.getSession();
      assert.ok(session, 'session should exist after skip + scan');
      const items = session!.confirmedSet.items;
      assert.equal(items.length, 2, 'the items are carried through unconfirmed');
      assert.ok(
        items.every((i) => i.confirmed === false),
        'skip leaves every item confirmed=false (assumption-dependent)',
      );
      await waitFor(() => api.getReviewDoc() === undefined);
    }),
  );

  suite.addTest(
    new Mocha.Test('an edited declaration is confirmed with user_corrected provenance', async () => {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      await waitFor(() => api.getReviewDoc() !== undefined);

      // Simulate a user edit of the first declaration in the Review doc.
      const original = api.getReviewDoc()!.getText();
      const edited = original.replace(
        'int read_sensor(int channel);',
        'long read_sensor(int channel);',
      );
      assert.notEqual(edited, original, 'edit changed the buffer');
      const applied = await api.setReviewDocText(edited);
      assert.ok(applied, 'edit applied to the Review doc');

      await vscode.commands.executeCommand('crepair.confirmContextAndScan');
      await waitFor(() => api.getSession() !== undefined);

      const items = api.getSession()!.confirmedSet.items as {
        confirmed: boolean;
        current_text: string;
        user_edited: boolean;
        provenance: string;
      }[];
      const editedItem = items.find((i) => i.current_text.startsWith('long read_sensor'));
      assert.ok(editedItem, 'the edited declaration is in the confirmed set');
      assert.equal(editedItem!.user_edited, true);
      assert.equal(editedItem!.provenance, 'user_corrected');
      assert.equal(editedItem!.confirmed, true);
    }),
  );

  suite.addTest(
    new Mocha.Test('editing the code section under the marker fails and keeps the Review open', async () => {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('crepair.scanCurrentFile');
      await waitFor(() => api.getReviewDoc() !== undefined);

      // Tamper with the Original code section (below the marker) — forbidden here.
      const original = api.getReviewDoc()!.getText();
      const tampered = original.replace(
        'int over_threshold(void) {',
        'int over_threshold(int tampered) {',
      );
      assert.notEqual(tampered, original, 'edit changed the code section');
      const applied = await api.setReviewDocText(tampered);
      assert.ok(applied, 'edit applied to the Review doc');

      await vscode.commands.executeCommand('crepair.confirmContextAndScan');
      // The parse rejects the code edit: the Review doc stays open (not torn down)
      // and no confirmed set with the tampered code is produced. Give it a moment.
      await delay(300);
      assert.ok(
        api.getReviewDoc() !== undefined,
        'the Review stays open after a rejected code edit',
      );
      // The tampered declaration must NOT have leaked into a session.
      const s = api.getSession();
      const tamperedInSession =
        s !== undefined &&
        (s.confirmedSet.items as unknown as { current_text: string }[]).some((i) =>
          i.current_text.includes('int tampered'),
        );
      assert.equal(tamperedInSession, false, 'tampered code did not reach a confirmed set');
    }),
  );
}
